const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const SKILL = path.join(__dirname, '..', 'skills', 'intent', 'SKILL.md');
const plain = (value) => value.replace(/\x1b\[[0-9;]*m/g, '');

function run(args, env = {}, cwd) {
  return plain(execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd,
  }));
}

test('CLI front door names bounded, reversible adapter layers', () => {
  const out = run(['--help']);
  assert.match(out, /connect your tools/i);
  assert.match(out, /Compile project truth → native context for a chosen tool/);
  assert.match(out, /signed-in cloud push unless --no-push/);
  assert.match(out, /Same-machine worker — project-bound, human-initiated claims/);
  assert.match(out, /Optional bounded MCP adapter — no project truth or execution authority/);
  assert.match(out, /Claude Code · Codex · Cursor · Gemini · compatible MCP clients/);
  assert.doesNotMatch(out, /Sequence all memory/);
  assert.doesNotMatch(out, /any MCP agent/);
});

test('sequence help treats per-user context as optional, not shared project memory', () => {
  const out = run(['seq', '--help']);
  assert.match(out, /Project context compiler/);
  assert.match(out, /\.intent\/ remains the project truth/);
  assert.match(out, /not project truth or shared model memory/);
  assert.match(out, /phewsh seq --write\s+Refresh all native project files from \.intent\//);
  assert.doesNotMatch(out, /Universal Memory Transform/);
  assert.doesNotMatch(out, /optimal context for any target agent/);
  assert.doesNotMatch(out, /global memory/);
});

test('sequence --write refreshes every native project file from one canonical core', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-seq-write-'));
  try {
    fs.mkdirSync(path.join(root, '.intent'));
    fs.writeFileSync(path.join(root, '.intent', 'vision.md'), '# Vision\nPortable truth.\n');
    fs.writeFileSync(path.join(root, '.intent', 'status.md'), '# Status\n## Now\nCurrent across harnesses.\n');
    fs.writeFileSync(path.join(root, '.intent', 'next.md'), '# Next\nShip the proof.\n');
    fs.writeFileSync(path.join(root, '.intent', 'project.json'), JSON.stringify({ name: 'Sequence proof' }));

    const out = run(['seq', '--write'], {}, root);
    assert.match(out, /Refreshed native project context: CLAUDE\.md, AGENTS\.md, GEMINI\.md, \.cursorrules/);
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']) {
      const projection = fs.readFileSync(path.join(root, file), 'utf8');
      assert.match(projection, /Portable truth/);
      assert.match(projection, /Current across harnesses/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Ion connector plan preserves manual claim and cross-machine authority fences', () => {
  const out = run(['ion', 'connectors']);
  assert.match(out, /same-machine Phewsh worker runs only after a human explicitly claims the task/);
  assert.match(out, /Cross-machine\/VPS execution still needs a separate authority ruling/);
  assert.doesNotMatch(out, /local\/VPS Phewsh worker runs/);
});

test('ambient status distinguishes native skills, session hooks, and shared safety hooks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-adapter-status-'));
  try {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['claude', 'codex']) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(file, 0o755);
    }

    for (const file of [
      path.join(home, '.claude', 'skills', 'intent', 'SKILL.md'),
      path.join(home, '.agents', 'skills', 'intent', 'SKILL.md'),
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(SKILL, file);
    }

    const sessionHook = (command) => [{ hooks: [{ type: 'command', command }] }];
    const toolHook = (command) => [{ matcher: 'Write|Edit|Bash', hooks: [{ type: 'command', command }] }];
    const claudeSettings = {
      hooks: {
        SessionStart: sessionHook('phewsh hook session-start'),
        SessionEnd: sessionHook('phewsh hook session-end'),
        PreToolUse: toolHook('phewsh hook pre-tool'),
        PostToolUse: toolHook('phewsh hook post-tool'),
      },
    };
    const codexHooks = {
      hooks: {
        PreToolUse: toolHook('phewsh hook pre-tool'),
        PostToolUse: toolHook('phewsh hook post-tool'),
      },
    };
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(claudeSettings));
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify(codexHooks));

    const out = run(['ambient', 'status'], {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
    });
    assert.match(out, /Project truth stays in \.intent\/\. Each adapter below is independent and reversible/);
    assert.match(out, /Claude Code\s+session hooks on · native intent skill on · safety\/receipt hooks on/);
    assert.match(out, /Codex CLI\s+native intent skill on · safety\/receipt hooks on · generated context supported/);
    assert.doesNotMatch(out, /no live hook to install/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ambient explain publishes one machine-readable adapter and authority contract', () => {
  const json = run(['ambient', 'explain', '--json']);
  const contract = JSON.parse(json);

  assert.equal(contract.projectTruth.path, '.intent/');
  assert.equal(contract.projectTruth.authority, 'Project · Next · Work · Record');
  assert.deepEqual(
    contract.layers.map((layer) => layer.id),
    ['intent-skill', 'session-hooks', 'native-projections', 'safety-receipt-hooks', 'mcp', 'ion-worker', 'slack-discord'],
  );
  assert.equal(contract.layers.find((layer) => layer.id === 'mcp').ownership,
    'Setup prints a manual client-config snippet; it does not write agent config.');
  assert.match(contract.layers.find((layer) => layer.id === 'ion-worker').boundary, /no cross-machine or VPS authority/);
  assert.equal(contract.layers.find((layer) => layer.id === 'slack-discord').state, 'planned');

  const human = run(['ambient', 'explain']);
  assert.match(human, /PHEWSH adapter contract/);
  assert.match(human, /Project truth.*project-owned.*\.intent\//);
  assert.match(human, /Intent skill.*skill.*available.*user-level/);
  assert.match(human, /ownership.*project-local overrides are user-owned/i);
  assert.match(human, /MCP adapter.*capability-adapter.*optional/);
  assert.match(human, /Slack and Discord connectors.*connector.*planned/);
  assert.match(human, /phewsh ambient explain --json.*phewsh\.com\/platform\/adapters\.json/);

  const help = run(['ambient', '--help']);
  assert.match(help, /explain --json.*machine-readable JSON/);
  assert.match(help, /\.intent\/ remains project truth/);
  assert.match(help, /Safety hooks stay independent.*phewsh gate enforce status/);
});

test('MCP setup says it previews manual client config before syncing its cache', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-mcp-setup-'));
  try {
    const out = run(['mcp', 'setup'], { HOME: home });
    assert.match(out, /Manual MCP client setup.*Phewsh will not edit agent config/);
    assert.match(out, /Add this to.*\.claude\/settings\.json/);
    assert.ok(fs.existsSync(path.join(home, '.phewsh', 'projects.json')));
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ambient status names project-local skill precedence without claiming ownership', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-adapter-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-adapter-project-'));
  try {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(codex, 0o755);
    fs.mkdirSync(path.join(home, '.codex'));
    fs.mkdirSync(path.join(project, '.intent'));
    const localSkill = path.join(project, '.agents', 'skills', 'intent', 'SKILL.md');
    fs.mkdirSync(path.dirname(localSkill), { recursive: true });
    fs.writeFileSync(localSkill, '---\nname: intent\ndescription: project-owned override\n---\n');

    const out = run(['ambient', 'status'], {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
    }, project);
    assert.match(out, /Project-local intent skill precedence:/);
    assert.match(out, /\.agents\/skills\/intent\/SKILL\.md.*codex.*differs from Phewsh canonical/);
    assert.match(out, /Phewsh never edits project-local skills/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('ambient on updates user-level delivery but preserves a conflicting project-local skill', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-adapter-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-adapter-project-'));
  try {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(codex, 0o755);
    fs.mkdirSync(path.join(home, '.codex'));
    fs.mkdirSync(path.join(project, '.intent'));
    fs.writeFileSync(path.join(project, '.intent', 'vision.md'), '# Project\nOne portable truth.\n');
    const localSkill = path.join(project, '.agents', 'skills', 'intent', 'SKILL.md');
    const localBody = '---\nname: intent\ndescription: user-owned project workflow\n---\n';
    fs.mkdirSync(path.dirname(localSkill), { recursive: true });
    fs.writeFileSync(localSkill, localBody);

    const out = run(['ambient', 'on', '--yes'], {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
    }, project);
    assert.match(out, /Project-local intent skills this command will not write:/);
    assert.match(out, /differs from Phewsh canonical · can override the user-level skill/);
    assert.match(out, /Ambient is on/);
    assert.equal(fs.readFileSync(localSkill, 'utf-8'), localBody);
    assert.equal(
      fs.readFileSync(path.join(home, '.agents', 'skills', 'intent', 'SKILL.md'), 'utf-8'),
      fs.readFileSync(SKILL, 'utf-8'),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('watcher exhaustion closes cleanly and preserves the completed initial-sync claim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-watch-failure-'));
  const previous = process.cwd();
  const modulePath = require.resolve('../commands/watch');
  try {
    fs.mkdirSync(path.join(root, '.intent', 'nested'), { recursive: true });
    process.chdir(root);
    delete require.cache[modulePath];
    const { watchIntent, formatWatchFailure } = require('../commands/watch');
    const created = [];
    let observed = null;
    const controller = watchIntent({
      watch: () => {
        const watcher = new EventEmitter();
        watcher.closed = false;
        watcher.close = () => { watcher.closed = true; };
        created.push(watcher);
        return watcher;
      },
      onError: (err) => { observed = err; },
    });

    const failure = Object.assign(new Error('descriptor limit'), { code: 'EMFILE' });
    created[0].emit('error', failure);
    assert.equal(observed, failure);
    assert.ok(created.every((watcher) => watcher.closed));
    assert.doesNotThrow(() => controller.close());

    const message = formatWatchFailure(failure).join(' ');
    assert.match(message, /initial sync completed/);
    assert.match(message, /phewsh seq --write/);
    assert.match(message, /retry `phewsh watch`/);
  } finally {
    process.chdir(previous);
    delete require.cache[modulePath];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context compression never strands Current Focus without its value', () => {
  const { compress } = require('../lib/sequencer/compressor');
  const focus = '- **Truthful adapter status:** skills, hooks, generated context, MCP, and connectors keep separate authority boundaries. ' + 'evidence '.repeat(24);
  const chunks = compress([
    { content: 'x'.repeat(7700), weight: 1 },
    { content: `# Status\n\n**Current Focus:**\n${focus}\nmore detail`, weight: 0.7 },
  ], 'standard');

  assert.equal(chunks.length, 2);
  assert.match(chunks[1].content, /\*\*Current Focus:\*\*\n- \*\*Truthful adapter status:/);
  assert.doesNotMatch(chunks[1].content, /more detail/);
});
