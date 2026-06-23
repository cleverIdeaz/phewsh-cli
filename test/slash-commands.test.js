const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// The module reads os.homedir() (→ $HOME on posix). Point it at a temp home.
function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-slash-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  delete require.cache[require.resolve('../lib/slash-commands')];
  try { return fn(home, require('../lib/slash-commands')); }
  finally { process.env.HOME = prev; fs.rmSync(home, { recursive: true, force: true }); }
}

test('installs /intent only for tools whose config dir exists', () => {
  withTempHome((home, slash) => {
    fs.mkdirSync(path.join(home, '.claude'));   // present, but excluded (has its own /intent skill)
    fs.mkdirSync(path.join(home, '.gemini'));   // present
    // .codex absent → must be skipped
    const { written } = slash.installSlashCommands();
    assert.ok(!written.includes('claude-code'), 'Claude Code is excluded — it has its own /intent skill');
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'commands', 'intent.md')), 'no colliding /intent in Claude Code');
    assert.ok(written.includes('gemini'));
    assert.ok(!written.includes('codex'));
    assert.ok(fs.existsSync(path.join(home, '.gemini', 'commands', 'intent.toml')));
  });
});

test('never clobbers a user-authored /intent, and remove only deletes phewsh-managed', () => {
  withTempHome((home, slash) => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex', 'prompts'), { recursive: true });
    const userFile = path.join(home, '.codex', 'prompts', 'intent.md');
    fs.writeFileSync(userFile, 'my own command');

    slash.installSlashCommands();
    assert.equal(fs.readFileSync(userFile, 'utf-8'), 'my own command', 'user command preserved');
    assert.ok(fs.existsSync(path.join(home, '.gemini', 'commands', 'intent.toml')), 'phewsh wrote gemini');

    const { removed } = slash.removeSlashCommands();
    assert.ok(removed.includes('gemini'));
    assert.ok(!removed.includes('codex'), 'user file not removed');
    assert.ok(fs.existsSync(userFile), 'user command survives removal');
    assert.ok(!fs.existsSync(path.join(home, '.gemini', 'commands', 'intent.toml')), 'phewsh command removed');
  });
});
