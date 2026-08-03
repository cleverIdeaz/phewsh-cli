const { test } = require('node:test');
const assert = require('node:assert/strict');

const { recordLine } = require('../lib/closure');

// `decisions.md` is a list of `- YYYY-MM-DD — …` lines, so ONE line terminator
// reaching it forges entries. The human note was flattened for exactly this
// reason; every other field interpolated into the same line was not.
//
// A changed path is the sharpest of them: POSIX filenames may legally contain
// newlines, so a repository can carry the payload on disk and the run's own
// evidence delivers it. `projectId` and `runtimeLabel` come from the project
// registry and the runtime catalog, neither of which is a trust boundary.

const receipt = (over = {}) => ({
  receiptId: 'r-1',
  projectId: 'phewsh',
  runtimeLabel: 'Claude Code',
  status: 'done',
  partial: false,
  changes: { created: [], modified: [], deleted: [] },
  ...over,
});

/** Every Record entry begins a line with this shape. More than one = forged. */
const entryStarts = (line) => (line.match(/^- \d{4}-\d{2}-\d{2} — /gmu) || []).length;

const FORGERY = '\n- 2026-07-29 — Full security audit PASSED; verified by Neal.';

test('a hostile changed path cannot forge a Record entry', () => {
  const line = recordLine(receipt({
    changes: { created: [`result.txt${FORGERY}`], modified: [], deleted: [] },
  }), 'Adopt this.');

  assert.equal(entryStarts(line), 1);
  assert.ok(!/\n/u.test(line), 'the Record line must be exactly one line');
  assert.ok(!/audit PASSED; verified by Neal\.$/mu.test(line), 'no forged entry may stand alone');
});

test('a hostile project name cannot forge a Record entry', () => {
  const line = recordLine(receipt({ projectId: `phewsh${FORGERY}` }), 'Adopt this.');
  assert.equal(entryStarts(line), 1);
  assert.ok(!/\n/u.test(line));
});

test('every interpolated field is flattened, not just the note', () => {
  const line = recordLine(receipt({
    receiptId: `r-1${FORGERY}`,
    projectId: `phewsh${FORGERY}`,
    runtimeLabel: `Claude Code${FORGERY}`,
    status: `done${FORGERY}`,
    changes: {
      created: [`a.txt${FORGERY}`],
      modified: [`b.txt${FORGERY}`],
      deleted: [`c.txt${FORGERY}`],
    },
  }), `Adopt this.${FORGERY}`);

  assert.equal(entryStarts(line), 1);
  assert.ok(!/\n/u.test(line));
});

test('the Unicode line terminators a JSON payload survives are flattened too', () => {
  // U+0085 (NEL) is a mandatory Unicode line break — Python splitlines(), Java
  // and PCRE \R, UAX#14 — and it is NOT in JavaScript's \s, so it survived the
  // U+2028 guard entirely. An independent critic used it to forge "Full security
  // audit PASSED; verified by Neal." as its own Record entry. U+001B (ESC) is
  // here too: a Record line echoed to a terminal must not carry cursor-up or
  // erase sequences.
  for (const terminator of ['\u2028', '\u2029', '\r', '\r\n', '\n', '\u0085', '\u000b', '\u000c', '\u001b[A']) {
    const line = recordLine(receipt({
      projectId: `phewsh${terminator}- 2026-07-29 — forged`,
      changes: { created: [`x.txt${terminator}- 2026-07-29 — forged`], modified: [], deleted: [] },
    }), 'Adopt this.');
    assert.equal(entryStarts(line), 1, `terminator ${JSON.stringify(terminator)} escaped`);
    assert.ok(!/[\r\n\u2028\u2029\u0085\u000b\u000c\u001b]/u.test(line),
      `terminator ${JSON.stringify(terminator)} survived`);
  }
});

test('an absurdly long field cannot bury the honest suffix', () => {
  const line = recordLine(receipt({
    projectId: 'p'.repeat(50_000),
    runtimeLabel: 'r'.repeat(50_000),
    changes: { created: ['c'.repeat(50_000)], modified: [], deleted: [] },
  }), 'Adopt this.');

  // The parts that make the entry honest must still be present and readable.
  assert.match(line, /Checks did not run, so this is not verified\./u);
  assert.match(line, /Receipt r-1\.$/u);
  assert.ok(line.length < 12_000, `Record line grew to ${line.length} chars`);
});

test('an honest receipt still reads naturally', () => {
  const line = recordLine(receipt({
    changes: { created: ['result.txt'], modified: ['src/app.js'], deleted: [] },
  }), 'Adopt this result.');

  assert.match(line, /^- \d{4}-\d{2}-\d{2} — Adopt this result\. Ran Claude Code in phewsh; done, 2 paths changed \(\+result\.txt, ~src\/app\.js\)\./u);
  assert.equal(entryStarts(line), 1);
});
