const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const plain = (value) => String(value || '').replace(/\x1b\[[0-9;]*m/g, '');

function fakeTool(binDir, name) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
}

function fixture({ tools = ['claude', 'codex', 'gemini'], project = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-consent-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  for (const tool of tools) {
    fakeTool(binDir, tool);
    const config = tool === 'claude' ? '.claude' : tool === 'codex' ? '.codex' : '.gemini';
    fs.mkdirSync(path.join(home, config), { recursive: true });
  }
  if (project) {
    fs.mkdirSync(path.join(cwd, '.intent'));
    fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\nPortable project truth.\n');
    fs.writeFileSync(path.join(cwd, '.intent', 'status.md'), '# Status\n## Now\nConsent contract.\n');
    fs.writeFileSync(path.join(cwd, '.intent', 'next.md'), '# Next\nVerify setup.\n');
    fs.writeFileSync(path.join(cwd, '.intent', 'project.json'), JSON.stringify({ name: 'Consent proof' }));
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}:/usr/bin:/bin`,
  };
  const run = (args, input, runCwd = cwd) => {
    const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd: runCwd,
      env,
      input,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, plain(result.stderr));
    return plain(result.stdout);
  };
  return { root, home, cwd, run };
}

test('ambient consent lists its complete write surface before a declined apply', () => {
  const f = fixture();
  try {
    const output = f.run(['ambient', 'on'], 'n\n');
    assert.match(output, /Exact files this command may write:/);
    for (const target of [
      '~/.claude/settings.json',
      '~/.agents/skills/intent/SKILL.md',
      '~/.claude/skills/intent/SKILL.md',
      '~/.claude/CLAUDE.md',
      '~/.codex/AGENTS.md',
      '~/.gemini/GEMINI.md',
      '~/.gemini/commands/intent.toml',
      '~/.phewsh/ambient.json',
      '~/.phewsh/intent-skills.json',
    ]) assert.ok(output.includes(target), `missing consent target: ${target}`);
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']) {
      assert.ok(output.includes(path.join(f.cwd, file)), `missing project target: ${file}`);
      assert.equal(fs.existsSync(path.join(f.cwd, file)), false, `decline wrote ${file}`);
    }
    assert.match(output, /No AI-tool files changed/);
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.codex', 'hooks.json')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.agents')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.phewsh', 'ambient.json'))).disabled, true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a bare first launch leaves every AI-tool adapter off', () => {
  const f = fixture({ tools: ['codex'] });
  try {
    f.run([], '/quit\n');
    assert.equal(fs.existsSync(path.join(f.home, '.agents')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.codex', 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.codex', 'hooks.json')), false);
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']) {
      assert.equal(fs.existsSync(path.join(f.cwd, file)), false, `bare launch wrote ${file}`);
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('ambient works with Codex alone and removes only project blocks it wrote', () => {
  const f = fixture({ tools: ['codex'] });
  try {
    const enabled = f.run(['ambient', 'on', '--yes']);
    assert.match(enabled, /Ambient is on/);
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.agents', 'skills', 'intent', 'SKILL.md')), true);
    assert.match(fs.readFileSync(path.join(f.cwd, 'AGENTS.md'), 'utf8'), /PHEWSH:START/);

    const other = path.join(f.root, 'other');
    fs.mkdirSync(other);
    f.run(['ambient', 'off'], undefined, other);
    assert.equal(fs.existsSync(path.join(f.cwd, 'AGENTS.md')), false, 'recorded project block survived removal from another cwd');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('gate setup on a Codex-only machine does not seed Claude configuration', () => {
  const f = fixture({ tools: ['codex'], project: false });
  try {
    f.run(['gate', 'enforce', 'on']);
    assert.equal(fs.existsSync(path.join(f.home, '.claude')), false);
    assert.match(fs.readFileSync(path.join(f.home, '.codex', 'hooks.json'), 'utf8'), /phewsh hook pre-tool/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('ambient off preserves independently enabled safety and receipt hooks', () => {
  const f = fixture({ tools: ['claude', 'codex'], project: false });
  try {
    f.run(['gate', 'enforce', 'on']);
    f.run(['ambient', 'on', '--yes']);
    f.run(['ambient', 'off']);

    const claude = JSON.parse(fs.readFileSync(path.join(f.home, '.claude', 'settings.json'), 'utf8'));
    const codex = JSON.parse(fs.readFileSync(path.join(f.home, '.codex', 'hooks.json'), 'utf8'));
    const serialized = JSON.stringify({ claude, codex });
    assert.doesNotMatch(serialized, /phewsh hook session-(start|end)/);
    assert.match(serialized, /phewsh hook pre-tool/);
    assert.match(serialized, /phewsh hook post-tool/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('curl installer is syntax-valid, truthfully describes sudo repair, and ships with the site', () => {
  const install = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const ship = fs.readFileSync(path.join(ROOT, 'ship.sh'), 'utf8');
  const syntax = spawnSync('sh', ['-n', path.join(ROOT, 'install.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(install, /never runs npm\s*\n?#?\s*with sudo/i);
  assert.match(install, /sudo chown/);
  assert.doesNotMatch(install, /never uses sudo/i);
  assert.match(ship, /"install\.sh"/);
});
