const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-intent-skill-'));
  const previous = process.env.HOME;
  process.env.HOME = home;
  delete require.cache[require.resolve('../lib/intent-skills')];
  try { return fn(home, require('../lib/intent-skills')); }
  finally {
    process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('canonical intent skill follows the open format and the four-word model', () => {
  const body = fs.readFileSync(path.join(__dirname, '..', 'skills', 'intent', 'SKILL.md'), 'utf-8');
  assert.match(body, /^---\nname: intent\ndescription:/);
  assert.match(body, /version: "2"/);
  assert.match(body, /Project · Next · Work · Record/);
  assert.match(body, /\.intent\//);
  assert.match(body, /\.agents\/skills\/intent\/SKILL\.md/);
  assert.match(body, /project-local copy\s+over the user-level skill/);
  assert.doesNotMatch(body, /generates vision\.md, plan\.md, status\.md/i);
});

test('public skill is byte-identical and this repository carries no project-local override', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'skills', 'intent', 'SKILL.md'), 'utf-8');
  const publicSkill = fs.readFileSync(path.join(__dirname, '..', '..', 'intent', 'skill', 'SKILL.md'), 'utf-8');
  assert.equal(publicSkill, source);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', '.claude', 'skills', 'intent', 'SKILL.md')), false);
});

test('installs one byte-identical skill into Codex and Claude user locations', () => {
  withTempHome((home, skills) => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.mkdirSync(path.join(home, '.claude'));

    const result = skills.installIntentSkills();
    assert.deepEqual(result.written.sort(), ['claude-code', 'codex']);

    const source = fs.readFileSync(skills.SOURCE_FILE, 'utf-8');
    const codex = fs.readFileSync(path.join(home, '.agents', 'skills', 'intent', 'SKILL.md'), 'utf-8');
    const claude = fs.readFileSync(path.join(home, '.claude', 'skills', 'intent', 'SKILL.md'), 'utf-8');
    assert.equal(codex, source);
    assert.equal(claude, source);
  });
});

test('skill install is machine-scoped and never writes into the current project', () => {
  withTempHome((home, skills) => {
    fs.mkdirSync(path.join(home, '.codex'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-project-'));
    const previous = process.cwd();
    try {
      process.chdir(project);
      skills.installIntentSkills();
      assert.equal(fs.existsSync(path.join(project, '.agents')), false);
      assert.equal(fs.existsSync(path.join(project, '.claude')), false);
    } finally {
      process.chdir(previous);
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

test('reports a project-local skill that shadows Codex without editing the user-owned file', () => {
  withTempHome((home, skills) => {
    fs.mkdirSync(path.join(home, '.codex'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-project-skill-'));
    const previous = process.cwd();
    const local = path.join(project, '.agents', 'skills', 'intent', 'SKILL.md');
    const stale = '---\nname: intent\ndescription: old three-artifact workflow\n---\n';
    try {
      fs.mkdirSync(path.join(project, '.intent'));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, stale);
      process.chdir(project);

      skills.installIntentSkills();
      const status = skills.intentSkillStatus();
      assert.deepEqual(status.projectOverrides.map(entry => ({
        id: entry.id,
        relative: entry.relative,
        state: entry.state,
        userOwned: entry.userOwned,
      })), [{
        id: 'codex',
        relative: path.join('.agents', 'skills', 'intent', 'SKILL.md'),
        state: 'different',
        userOwned: true,
      }]);
      assert.equal(fs.readFileSync(local, 'utf-8'), stale);
      assert.equal(status.exact.includes('codex'), true, 'the separate user-level skill is current');
    } finally {
      process.chdir(previous);
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

test('never clobbers an existing skill and removes only an unchanged phewsh copy', () => {
  withTempHome((home, skills) => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'intent'), { recursive: true });
    const claudeFile = path.join(home, '.claude', 'skills', 'intent', 'SKILL.md');
    fs.writeFileSync(claudeFile, 'my own intent skill\n');

    const installed = skills.installIntentSkills();
    assert.ok(installed.preserved.includes('claude-code'));
    assert.equal(fs.readFileSync(claudeFile, 'utf-8'), 'my own intent skill\n');

    const codexFile = path.join(home, '.agents', 'skills', 'intent', 'SKILL.md');
    fs.appendFileSync(codexFile, '\nmy local note\n');
    const removed = skills.removeIntentSkills();
    assert.ok(!removed.removed.includes('codex'), 'a modified installed copy survives removal');
    assert.ok(!removed.removed.includes('claude-code'), 'a user-authored skill survives removal');
    assert.ok(fs.existsSync(codexFile));
    assert.ok(fs.existsSync(claudeFile));
  });
});

test('updates a prior phewsh-managed copy only while its receipt still matches', () => {
  withTempHome((home, skills) => {
    fs.mkdirSync(path.join(home, '.codex'));
    skills.installIntentSkills();

    const codexFile = path.join(home, '.agents', 'skills', 'intent', 'SKILL.md');
    const oldManaged = '---\nname: intent\ndescription: old phewsh copy\n---\n';
    fs.writeFileSync(codexFile, oldManaged);
    const receipt = JSON.parse(fs.readFileSync(skills.RECEIPT_FILE, 'utf-8'));
    receipt.files[codexFile].hash = crypto.createHash('sha256').update(oldManaged).digest('hex');
    fs.writeFileSync(skills.RECEIPT_FILE, JSON.stringify(receipt));

    const before = skills.intentSkillStatus();
    assert.ok(before.managed.includes('codex'));
    assert.ok(before.outdated.includes('codex'));
    assert.ok(!before.exact.includes('codex'));

    const updated = skills.installIntentSkills();
    assert.ok(updated.written.includes('codex'));
    assert.equal(fs.readFileSync(codexFile, 'utf-8'), fs.readFileSync(skills.SOURCE_FILE, 'utf-8'));
  });
});

test('an identical skill without a phewsh receipt remains user-owned', () => {
  withTempHome((home, skills) => {
    fs.mkdirSync(path.join(home, '.codex'));
    const codexFile = path.join(home, '.agents', 'skills', 'intent', 'SKILL.md');
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.copyFileSync(skills.SOURCE_FILE, codexFile);

    skills.installIntentSkills();
    const result = skills.removeIntentSkills();
    assert.ok(!result.removed.includes('codex'));
    assert.ok(result.preserved.includes('codex'));
    assert.ok(fs.existsSync(codexFile));
  });
});

test('removes unmodified installed copies and only the managed legacy Codex prompt', () => {
  withTempHome((home, skills) => {
    fs.mkdirSync(path.join(home, '.codex', 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'));
    const legacy = path.join(home, '.codex', 'prompts', 'intent.md');
    fs.writeFileSync(legacy, '<!-- phewsh-managed · remove with: phewsh ambient off -->\nold prompt\n');

    const installed = skills.installIntentSkills();
    assert.deepEqual(installed.migrated, ['codex']);
    assert.equal(fs.existsSync(legacy), false);

    const removed = skills.removeIntentSkills();
    assert.deepEqual(removed.removed.sort(), ['claude-code', 'codex']);
    assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'intent', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'intent', 'SKILL.md')), false);

    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, 'my own prompt\n');
    skills.installIntentSkills();
    assert.equal(fs.readFileSync(legacy, 'utf-8'), 'my own prompt\n');
  });
});
