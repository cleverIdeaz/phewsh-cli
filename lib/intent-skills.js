// One open Agent Skill, projected into each harness's native user-level
// discovery location. The source is shipped in the npm package; installed
// copies are derived and byte-identical. Project truth remains in `.intent/`.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SOURCE_FILE = path.join(__dirname, '..', 'skills', 'intent', 'SKILL.md');
const RECEIPT_FILE = path.join(os.homedir(), '.phewsh', 'intent-skills.json');
const LEGACY_MARKER = 'phewsh-managed';

function hash(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function loadReceipt() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RECEIPT_FILE, 'utf-8'));
    return parsed && parsed.version === 1 && parsed.files ? parsed : { version: 1, files: {} };
  } catch { return { version: 1, files: {} }; }
}

function saveReceipt(receipt) {
  try {
    if (Object.keys(receipt.files).length === 0) {
      if (fs.existsSync(RECEIPT_FILE)) fs.unlinkSync(RECEIPT_FILE);
      return;
    }
    fs.mkdirSync(path.dirname(RECEIPT_FILE), { recursive: true });
    fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
  } catch { /* skill delivery must stay best-effort */ }
}

function targets() {
  const home = os.homedir();
  return [
    {
      id: 'codex',
      present: path.join(home, '.codex'),
      file: path.join(home, '.agents', 'skills', 'intent', 'SKILL.md'),
    },
    {
      id: 'claude-code',
      present: path.join(home, '.claude'),
      file: path.join(home, '.claude', 'skills', 'intent', 'SKILL.md'),
    },
  ];
}

function sourceBody() {
  return fs.readFileSync(SOURCE_FILE, 'utf-8');
}

function resolveSkillProjectRoot(start = process.cwd()) {
  let dir;
  try { dir = path.resolve(start); } catch { return start; }
  const root = path.parse(dir).root;
  const home = (() => {
    try { return fs.realpathSync(os.homedir()); } catch { return os.homedir(); }
  })();
  while (true) {
    if (fs.existsSync(path.join(dir, '.intent')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    let real;
    try { real = fs.realpathSync(dir); } catch { real = dir; }
    if (dir === root || real === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

function projectIntentSkillStatus(cwd = process.cwd()) {
  const root = resolveSkillProjectRoot(cwd);
  const body = sourceBody();
  const userTargets = new Set(targets().map(target => path.resolve(target.file)));
  return [
    { id: 'codex', file: path.join(root, '.agents', 'skills', 'intent', 'SKILL.md') },
    { id: 'claude-code', file: path.join(root, '.claude', 'skills', 'intent', 'SKILL.md') },
  ].filter(target => {
    try { return fs.existsSync(target.file) && !userTargets.has(path.resolve(target.file)); }
    catch { return false; }
  }).map(target => {
    let state = 'unreadable';
    try { state = fs.readFileSync(target.file, 'utf-8') === body ? 'exact' : 'different'; }
    catch { /* keep unreadable */ }
    return {
      ...target,
      root,
      relative: path.relative(root, target.file),
      state,
      userOwned: true,
    };
  });
}

function removeManagedLegacyCodexPrompt() {
  const file = path.join(os.homedir(), '.codex', 'prompts', 'intent.md');
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes(LEGACY_MARKER)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch { /* conservative, best-effort migration */ }
  return false;
}

function installIntentSkills() {
  const body = sourceBody();
  const bodyHash = hash(body);
  const receipt = loadReceipt();
  const written = [];
  const preserved = [];

  for (const target of targets()) {
    try {
      if (!fs.existsSync(target.present)) continue;
      if (fs.existsSync(target.file)) {
        const existing = fs.readFileSync(target.file, 'utf-8');
        const prior = receipt.files[target.file];
        if (existing === body) {
          // An identical file without our receipt may be user-owned. Use it,
          // but never claim ownership or remove it later.
          if (prior && prior.hash === bodyHash) receipt.files[target.file] = { id: target.id, hash: bodyHash };
        } else if (prior && prior.hash === hash(existing)) {
          // Safe upgrade: the on-disk bytes still match what phewsh installed.
          fs.writeFileSync(target.file, body);
          receipt.files[target.file] = { id: target.id, hash: bodyHash };
          written.push(target.id);
        } else {
          preserved.push(target.id);
        }
        continue;
      }
      fs.mkdirSync(path.dirname(target.file), { recursive: true });
      fs.writeFileSync(target.file, body);
      receipt.files[target.file] = { id: target.id, hash: bodyHash };
      written.push(target.id);
    } catch { /* best-effort per harness */ }
  }

  saveReceipt(receipt);
  const migrated = removeManagedLegacyCodexPrompt() ? ['codex'] : [];
  return { written, preserved, migrated };
}

function removeIntentSkills() {
  const receipt = loadReceipt();
  const removed = [];
  const preserved = [];

  for (const target of targets()) {
    try {
      if (!fs.existsSync(target.file)) continue;
      const prior = receipt.files[target.file];
      if (!prior || prior.hash !== hash(fs.readFileSync(target.file, 'utf-8'))) {
        preserved.push(target.id);
        continue;
      }
      fs.unlinkSync(target.file);
      removed.push(target.id);
    } catch { /* best-effort per harness */ }
    finally { delete receipt.files[target.file]; }
  }

  saveReceipt(receipt);
  return { removed, preserved };
}

function detectIntentSkillTargets() {
  return targets().filter(target => fs.existsSync(target.present));
}

function intentSkillStatus() {
  const body = sourceBody();
  const bodyHash = hash(body);
  const receipt = loadReceipt();
  const checked = detectIntentSkillTargets();
  const satisfied = [];
  const exact = [];
  const managed = [];
  const outdated = [];
  for (const target of checked) {
    try {
      if (!fs.existsSync(target.file)) continue;
      const existing = fs.readFileSync(target.file, 'utf-8');
      const existingHash = hash(existing);
      satisfied.push(target.id);
      if (existingHash === bodyHash) exact.push(target.id);
      const prior = receipt.files[target.file];
      if (prior && prior.hash === existingHash) {
        managed.push(target.id);
        if (existingHash !== bodyHash) outdated.push(target.id);
      }
    } catch { /* report this target as pending */ }
  }
  return {
    complete: checked.every(target => satisfied.includes(target.id)),
    checked: checked.map(target => target.id),
    satisfied,
    exact,
    managed,
    outdated,
    projectOverrides: projectIntentSkillStatus(),
  };
}

module.exports = {
  SOURCE_FILE,
  RECEIPT_FILE,
  installIntentSkills,
  removeIntentSkills,
  detectIntentSkillTargets,
  projectIntentSkillStatus,
  intentSkillStatus,
};
