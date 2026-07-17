const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function captureStatus(home, setup) {
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-status-project-'));
  const lines = [];
  const originalLog = console.log;
  process.env.HOME = home;
  process.chdir(project);
  delete require.cache[require.resolve('../lib/intent-skills')];
  delete require.cache[require.resolve('../commands/status')];
  try {
    setup(project);
    console.log = (...args) => lines.push(args.join(' '));
    require('../commands/status')();
    return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
    process.env.HOME = previousHome;
    fs.rmSync(project, { recursive: true, force: true });
  }
}

test('status verifies intent skill bytes instead of trusting a stale ambient ledger', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-status-home-'));
  try {
    const output = captureStatus(home, () => {
      fs.mkdirSync(path.join(home, '.codex'));
      fs.mkdirSync(path.join(home, '.phewsh'));
      fs.writeFileSync(path.join(home, '.phewsh', 'ambient.json'), JSON.stringify({
        applied: { intentSkill: { tools: ['codex'] } },
      }));
    });
    assert.match(output, /Adapters\s+.*off/);
    assert.doesNotMatch(output, /intent skill in codex/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('status distinguishes the canonical skill from a user-owned custom skill', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-status-home-'));
  try {
    const canonical = captureStatus(home, () => {
      fs.mkdirSync(path.join(home, '.codex'));
      const file = path.join(home, '.agents', 'skills', 'intent', 'SKILL.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'skills', 'intent', 'SKILL.md'), file);
    });
    assert.match(canonical, /Adapters\s+.*on.*intent skill in codex/);

    const file = path.join(home, '.agents', 'skills', 'intent', 'SKILL.md');
    fs.appendFileSync(file, '\nuser customization\n');
    const custom = captureStatus(home, () => {});
    assert.match(custom, /Adapters\s+.*on.*custom intent skill in codex/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('status exposes a conflicting project-local skill that can shadow the canonical adapter', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-status-home-'));
  try {
    const output = captureStatus(home, (project) => {
      fs.mkdirSync(path.join(home, '.codex'));
      const userSkill = path.join(home, '.agents', 'skills', 'intent', 'SKILL.md');
      fs.mkdirSync(path.dirname(userSkill), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'skills', 'intent', 'SKILL.md'), userSkill);
      const localSkill = path.join(project, '.agents', 'skills', 'intent', 'SKILL.md');
      fs.mkdirSync(path.dirname(localSkill), { recursive: true });
      fs.writeFileSync(localSkill, '---\nname: intent\ndescription: obsolete local workflow\n---\n');
    });
    assert.match(output, /Project skill\s+! \.agents\/skills\/intent\/SKILL\.md/);
    assert.match(output, /differs from Phewsh canonical · can override the user-level skill/);
    assert.match(output, /phewsh will not edit it; review, rename, or remove that project-local file yourself/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('status reports Claude and Codex safety hooks as independent adapters', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-status-home-'));
  try {
    const output = captureStatus(home, () => {
      const toolHook = (command) => [{ matcher: 'Write|Edit|Bash', hooks: [{ type: 'command', command }] }];
      const hooks = {
        hooks: {
          PreToolUse: toolHook('phewsh hook pre-tool'),
          PostToolUse: toolHook('phewsh hook post-tool'),
        },
      };
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(hooks));
      fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify(hooks));
    });
    assert.match(output, /Adapters\s+.*on.*safety\/receipt hooks in claude-code, codex/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('status shows verified handoff evidence inside Record and names later movement', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-status-home-'));
  try {
    const verified = captureStatus(home, (cwd) => {
      fs.mkdirSync(path.join(cwd, '.intent'));
      fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\n');
      const created = require('../lib/handoff-receipt').createHandoffReceipt({
        cwd,
        report: { git: { available: false } },
      });
      assert.equal(created.written, true);
      assert.ok(created.file.startsWith(home));
      assert.equal(require('../lib/handoff-receipt').latestHandoffReceipt({ cwd }).status, 'verified');
    });
    assert.match(verified, /handoff h-[a-f0-9]+ verified/);

    const moved = captureStatus(home, (cwd) => {
      // captureStatus creates a new project root, so make and move a receipt in
      // that same root rather than relying on the prior fixture path.
      fs.mkdirSync(path.join(cwd, '.intent'));
      fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\n');
      require('../lib/handoff-receipt').createHandoffReceipt({
        cwd,
        report: { git: { available: false } },
      });
      fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision changed\n');
    });
    assert.match(moved, /handoff h-[a-f0-9]+ moved.*\.intent\/vision\.md/);

    const unfinished = captureStatus(home, (cwd) => {
      fs.mkdirSync(path.join(cwd, '.intent'));
      fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\n');
      require('../lib/handoff-receipt').createHandoffReceipt({
        cwd,
        report: { git: { available: false } },
        trigger: 'work-start',
      });
    });
    assert.match(unfinished, /matches work start.*no exit receipt; unrecorded decisions were not carried/);
    assert.doesNotMatch(unfinished, /handoff h-[a-f0-9]+ verified/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('status bounds a large moved handoff while keeping its evidence count', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-status-home-'));
  try {
    const output = captureStatus(home, (cwd) => {
      fs.mkdirSync(path.join(cwd, '.intent'));
      fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd });
      execFileSync('git', ['config', 'user.name', 'T'], { cwd });
      execFileSync('git', ['add', '.intent'], { cwd });
      execFileSync('git', ['commit', '-qm', 'intent'], { cwd });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
      require('../lib/handoff-receipt').createHandoffReceipt({
        cwd,
        report: { git: { available: true, head, tracked: [], untracked: [] } },
      });
      for (let index = 0; index < 12; index++) {
        fs.writeFileSync(path.join(cwd, `changed-${String(index).padStart(2, '0')}.txt`), 'moved\n');
      }
    });
    assert.match(output, /handoff h-[a-f0-9]+ moved/);
    assert.match(output, /… \+9 more \(12 changes total\)/);
    assert.equal((output.match(/working path changed:/g) || []).length, 3);
    assert.ok(output.length < 5000);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
