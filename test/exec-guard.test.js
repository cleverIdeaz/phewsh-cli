const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// exechard lint guard: shell-string child-process calls are banned in CLI
// source. Every call must be the argument-safe execFileSync/execFile/spawn
// form — a template string handed to a shell is one interpolation away from
// an injection. Genuinely need a shell? Add the file + reason to the
// allowlist so the exception is reviewed, not silent.
const SRC_DIRS = ['lib', 'commands', 'bin'];
const ALLOWLIST = new Set([
  // none — the Jul 14 sweep converted every call site
]);

// Pattern built from parts so this guard file never contains the banned
// call-shape itself (it would trip source scanners, including this one).
const BANNED = new RegExp('\\bexec' + 'Sync\\s*\\(');
const SAFE = new RegExp('execFile');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

test('no shell-string execSync calls in CLI source', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  for (const dir of SRC_DIRS) {
    for (const file of walk(path.join(root, dir))) {
      const rel = path.relative(root, file);
      if (ALLOWLIST.has(rel)) continue;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        const code = line.split('//')[0]; // ignore trailing comments
        if (BANNED.test(code) && !SAFE.test(code) && !/require\(/.test(code)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `shell-string exec found:\n${offenders.join('\n')}`);
});
