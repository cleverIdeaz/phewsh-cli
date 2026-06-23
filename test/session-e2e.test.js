const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function waitForOutput(child, output, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), timeoutMs);
    const check = () => {
      if (!pattern.test(output.text)) return;
      clearTimeout(timeout);
      child.stdout.off('data', check);
      child.stderr.off('data', check);
      resolve();
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    check();
  });
}

function waitForFileLines(file, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      let lines = 0;
      try { lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).length; } catch {}
      if (lines >= count) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${count} invocations`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test('session coalesces pasted lines and blank input has no outcome side effect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-session-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const invocationFile = path.join(root, 'invocations.txt');
  fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
  fs.mkdirSync(path.join(project, '.intent'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, '.phewsh', 'config.json'), JSON.stringify({
    defaultRoute: 'claude-code',
    fallback: 'ask',
  }));
  for (const name of ['vision.md', 'plan.md', 'next.md']) {
    fs.writeFileSync(path.join(project, '.intent', name), `# ${name}\n`);
  }

  const fakeClaude = path.join(bin, 'claude');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(invocationFile)}, '1\\n');
console.log('STUB_RESPONSE');
`);
  fs.chmodSync(fakeClaude, 0o755);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js')], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', chunk => { output.text += chunk; });
  child.stderr.on('data', chunk => { output.text += chunk; });

  try {
    await waitForOutput(child, output, /What are you trying to do\?/);
    child.stdin.write('first pasted line\nsecond pasted line\n');
    await waitForOutput(child, output, /STUB_RESPONSE/);
    child.stdin.write('\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    child.stdin.write('/quit\n');

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Session did not exit')), 5000);
      child.on('exit', code => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0);
    assert.equal(fs.readFileSync(invocationFile, 'utf-8').trim().split('\n').length, 1);
    assert.equal((output.text.match(/how'd it go\?/g) || []).length, 1);

    const decisionsPath = path.join(home, '.phewsh', 'outcomes', 'decisions.json');
    const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf-8'));
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].summary, 'first pasted line\nsecond pasted line');
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repeated Claude usage failures offer Codex or one retry, then suppress', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-limit-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const invocationFile = path.join(root, 'claude-invocations.txt');
  fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
  fs.mkdirSync(path.join(project, '.intent'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, '.phewsh', 'config.json'), JSON.stringify({
    defaultRoute: 'claude-code',
    fallback: 'ask',
  }));
  for (const name of ['vision.md', 'plan.md', 'next.md']) {
    fs.writeFileSync(path.join(project, '.intent', name), `# ${name}\n`);
  }

  const fakeClaude = path.join(bin, 'claude');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(invocationFile)}, '1\\n');
console.error('You have hit your session limit; resets at 5pm');
process.exit(1);
`);
  fs.chmodSync(fakeClaude, 0o755);

  const fakeCodex = path.join(bin, 'codex');
  fs.writeFileSync(fakeCodex, `#!${process.execPath}
console.log('CODEX_RESPONSE');
`);
  fs.chmodSync(fakeCodex, 0o755);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js')], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', chunk => { output.text += chunk; });
  child.stderr.on('data', chunk => { output.text += chunk; });

  try {
    await waitForOutput(child, output, /What are you trying to do\?/);
    child.stdin.write('test quota handling\n');
    await waitForOutput(child, output, /retry Claude once below/);
    child.stdin.write('2\n');
    await waitForFileLines(invocationFile, 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    child.stdin.write('/quit\n');

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Session did not exit')), 5000);
      child.on('exit', code => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0);
    assert.equal((output.text.match(/hit a usage wall/g) || []).length, 1);
    assert.equal((output.text.match(/Retry with your context intact/g) || []).length, 1);
    assert.equal((output.text.match(/outcome\?/g) || []).length, 0);

    const decisionsPath = path.join(home, '.phewsh', 'outcomes', 'decisions.json');
    const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf-8'));
    assert.equal(decisions.length, 2);
    assert.ok(decisions.every(decision => decision.outcome === 'failed'));
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/use codex persists across session restarts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-route-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const claudeInvocations = path.join(root, 'claude-invocations.txt');
  const codexInvocations = path.join(root, 'codex-invocations.txt');
  fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
  fs.mkdirSync(path.join(project, '.intent'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, '.phewsh', 'config.json'), JSON.stringify({
    defaultRoute: 'claude-code',
    fallback: 'ask',
  }));
  for (const name of ['vision.md', 'plan.md', 'next.md']) {
    fs.writeFileSync(path.join(project, '.intent', name), `# ${name}\n`);
  }

  for (const [name, invocationFile, response] of [
    ['claude', claudeInvocations, 'CLAUDE_RESPONSE'],
    ['codex', codexInvocations, 'CODEX_RESPONSE'],
  ]) {
    const executable = path.join(bin, name);
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(invocationFile)}, '1\\n');
console.log(${JSON.stringify(response)});
`);
    fs.chmodSync(executable, 0o755);
  }

  async function runSession({ switchToCodex = false, prompt }) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js')], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = { text: '' };
    child.stdout.on('data', chunk => { output.text += chunk; });
    child.stderr.on('data', chunk => { output.text += chunk; });
    try {
      await waitForOutput(child, output, /What are you trying to do\?/);
      if (switchToCodex) {
        child.stdin.write('/use codex\n');
        await waitForOutput(child, output, /saved across sessions/);
      }
      child.stdin.write(prompt + '\n');
      await waitForOutput(child, output, /CODEX_RESPONSE/);
      child.stdin.write('/quit\n');
      const exitCode = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Session did not exit')), 5000);
        child.on('exit', code => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      assert.equal(exitCode, 0);
      return output.text;
    } finally {
      if (!child.killed) child.kill('SIGTERM');
    }
  }

  try {
    const firstOutput = await runSession({ switchToCodex: true, prompt: 'first turn' });
    assert.match(firstOutput, /saved across sessions/);
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.phewsh', 'config.json'), 'utf-8'));
    assert.equal(saved.defaultRoute, 'codex');

    await runSession({ prompt: 'second turn' });
    assert.equal(fs.existsSync(claudeInvocations), false);
    assert.equal(fs.readFileSync(codexInvocations, 'utf-8').trim().split('\n').length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bare help opens help instead of routing to the harness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-bare-help-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const invocationFile = path.join(root, 'invocations.txt');
  fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
  fs.mkdirSync(path.join(project, '.intent'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, '.phewsh', 'config.json'), JSON.stringify({
    defaultRoute: 'claude-code',
    fallback: 'ask',
  }));
  for (const name of ['vision.md', 'plan.md', 'next.md']) {
    fs.writeFileSync(path.join(project, '.intent', name), `# ${name}\n`);
  }

  const fakeClaude = path.join(bin, 'claude');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(invocationFile)}, '1\\n');
console.log('SHOULD_NOT_RUN');
`);
  fs.chmodSync(fakeClaude, 0o755);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js')], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', chunk => { output.text += chunk; });
  child.stderr.on('data', chunk => { output.text += chunk; });

  try {
    await waitForOutput(child, output, /What are you trying to do\?/);
    child.stdin.write('help\n');
    await waitForOutput(child, output, /the essentials/);
    child.stdin.write('/quit\n');
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Session did not exit')), 5000);
      child.on('exit', code => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(invocationFile), false);
    assert.doesNotMatch(output.text, /SHOULD_NOT_RUN/);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/clarify inside a session works through an installed harness with no API key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-session-clarify-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, '.phewsh', 'config.json'), JSON.stringify({
    defaultRoute: 'claude-code',
    fallback: 'ask',
  }));

  const fakeClaude = path.join(bin, 'claude');
  const spec = {
    goal: 'Keep AI work aligned across tools.',
    success_criteria: ['Intent files are written'],
    constraints: ['No API key required'],
    inputs: ['User intent'],
    outputs: ['Portable project spec'],
    tasks: [{ text: 'Review the generated intent files', type: 'do' }],
  };
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
console.log(JSON.stringify({ type: 'result', result: ${JSON.stringify(JSON.stringify(spec))} }));
`);
  fs.chmodSync(fakeClaude, 0o755);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js')], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', chunk => { output.text += chunk; });
  child.stderr.on('data', chunk => { output.text += chunk; });

  try {
    await waitForOutput(child, output, /What are you trying to do\?/);
    child.stdin.write('/clarify I want to build a front door for AI work\n');
    await waitForOutput(child, output, /Context loaded:/, 10000);
    child.stdin.write('/quit\n');
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Session did not exit')), 5000);
      child.on('exit', code => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0);
    assert.doesNotMatch(output.text, /No API key/);
    assert.ok(fs.existsSync(path.join(project, '.intent', 'pps.json')));
    assert.match(fs.readFileSync(path.join(project, '.intent', 'vision.md'), 'utf-8'), /Keep AI work aligned/);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('natural input with no route explains the setup path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-no-route-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js')], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      PATH: '/usr/bin:/bin',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', chunk => { output.text += chunk; });
  child.stderr.on('data', chunk => { output.text += chunk; });

  try {
    await waitForOutput(child, output, /No agent CLI found|Where do you want to work\?|What are you trying to do\?/);
    child.stdin.write('help me build a tool\n');
    await waitForOutput(child, output, /AI worker behind the door/);
    child.stdin.write('/quit\n');
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Session did not exit')), 5000);
      child.on('exit', code => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0);
    assert.match(output.text, /phewsh setup/);
    assert.match(output.text, /Once a route exists, plain typing works/);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/work postflight and /switch pass a freshly verified brief to the next native harness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-work-lifecycle-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const codexArgsFile = path.join(root, 'codex-args.jsonl');
  const claudeArgsFile = path.join(root, 'claude-args.jsonl');
  fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
  fs.mkdirSync(path.join(project, '.intent'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, '.phewsh', 'config.json'), JSON.stringify({
    defaultRoute: 'codex',
    fallback: 'ask',
  }));
  for (const name of ['vision.md', 'plan.md', 'status.md', 'next.md']) {
    fs.writeFileSync(path.join(project, '.intent', name), `---\nupdated: 2026-06-15\n---\n# ${name}\nLifecycle fixture.\n`);
  }
  fs.writeFileSync(path.join(project, '.intent', 'project.json'), JSON.stringify({
    name: 'Lifecycle Fixture',
    decisionGate: { constraints: { urgency: 'urgent' } },
  }));
  fs.writeFileSync(path.join(project, '.intent', 'next.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'n1',
      title: 'Complete the native lifecycle',
      state: 'now',
      criteria: [{
        expected: 'from-codex.txt exists',
        type: 'measurable',
        accepted: true,
        check: { kind: 'file', path: 'from-codex.txt' },
      }],
    }],
  }, null, 2));
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: project });
  execFileSync('git', ['add', '-A'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: project });

  const fakeCodex = path.join(bin, 'codex');
  fs.writeFileSync(fakeCodex, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(codexArgsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(path.join(process.cwd(), 'from-codex.txt'), 'changed');
`);
  fs.chmodSync(fakeCodex, 0o755);

  const fakeClaude = path.join(bin, 'claude');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(claudeArgsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
  fs.chmodSync(fakeClaude, 0o755);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js')], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NO_COLOR: '1',
      PHEWSH_OFFLINE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', chunk => { output.text += chunk; });
  child.stderr.on('data', chunk => { output.text += chunk; });

  try {
    await waitForOutput(child, output, /What are you trying to do\?/);
    child.stdin.write('/work codex\n');
    await waitForFileLines(codexArgsFile, 1, 10000);
    await waitForOutput(child, output, /Codex CLI session ended — postflight/, 10000);
    await waitForOutput(child, output, /Verification:\s+- pass: Complete the native lifecycle/, 10000);
    child.stdin.write('/reconcile\n');
    await waitForOutput(child, output, /Verification verdict: pass/, 10000);
    child.stdin.write('y\n');
    await waitForOutput(child, output, /Applied the approved diff/, 10000);
    child.stdin.write('/switch claude-code\n');
    await waitForFileLines(claudeArgsFile, 1, 10000);
    await waitForOutput(child, output, /Claude Code session ended — postflight/, 10000);
    child.stdin.write('/quit\n');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Session did not exit')), 5000);
      child.on('exit', code => {
        clearTimeout(timeout);
        assert.equal(code, 0);
        resolve();
      });
    });

    const codexArgs = JSON.parse(fs.readFileSync(codexArgsFile, 'utf-8').trim());
    const claudeArgs = JSON.parse(fs.readFileSync(claudeArgsFile, 'utf-8').trim());
    assert.match(codexArgs.join(' '), /Working tree: clean/);
    assert.match(codexArgs.join(' '), /from-codex\.txt exists/);
    assert.match(claudeArgs.join(' '), /Working tree: \d+ changed path\(s\), uncommitted/);
    assert.match(claudeArgs.join(' '), /from-codex\.txt exists/);
    assert.deepEqual(claudeArgs.slice(0, 1), ['--append-system-prompt']);
    assert.match(fs.readFileSync(path.join(project, '.intent', 'next.md'), 'utf-8'), /Verification verdict: pass/);
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']) {
      assert.match(fs.readFileSync(path.join(project, file), 'utf-8'), /from-codex\.txt exists/);
    }
    // /work + /switch each persist a brief; /quit gives the exit handoff (3rd).
    assert.match(output.text, /Handoff ready/, 'exit renders the cross-harness handoff');
    const briefs = fs.readdirSync(path.join(home, '.phewsh', 'briefs', 'project'));
    assert.equal(briefs.length, 3);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
