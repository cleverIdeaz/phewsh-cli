// The Record is one of the four words. `phewsh remember` writes it to
// .intent/decisions.md, and .intent/README.md names that file the canonical
// source for "what happened & what we learned".
//
// Before this suite, decisions.md was absent from discover.js's INTENT_FILES,
// so it was never discovered, never parsed, and never emitted. Every generated
// projection (AGENTS.md / CLAUDE.md / GEMINI.md / .cursorrules) carried Project
// and Next but silently dropped the Record — on a product whose central claim
// is "will the next AI know what the last one learned?".
//
// Found by the P2 released-artifact cold-transfer run, 2026-07-28.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { discover } = require('../lib/sequencer/discover');
const intentParser = require('../lib/sequencer/parsers/intent');
const { emit } = require('../lib/sequencer/emitters/claude-md');

const DECISION = "Slugify preserves Unicode letters instead of stripping to ASCII, because 'Ørsted' and 'Orsted' collapsed into one slug.";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-record-'));
  fs.mkdirSync(path.join(dir, '.intent'));
  fs.writeFileSync(path.join(dir, '.intent', 'vision.md'), '# Vision\n\n## North Star\nStable slugs.\n');
  fs.writeFileSync(
    path.join(dir, '.intent', 'decisions.md'),
    `# Decisions\n\n> What we decided and why — append-only.\n\n- 2026-07-28 — ${DECISION}\n`,
  );
  return dir;
}

test('decisions.md is discovered as an .intent source', () => {
  const dir = fixture();
  try {
    const sources = discover(dir);
    const names = sources.map(s => s.name);
    assert.ok(names.includes('decisions.md'), `decisions.md not discovered — found: ${names.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('decisions.md parses into a record chunk carrying the decision text', () => {
  const dir = fixture();
  try {
    const source = discover(dir).find(s => s.name === 'decisions.md');
    assert.ok(source, 'decisions.md was not discovered');
    const chunks = intentParser.parse(source);
    assert.ok(chunks.length > 0, 'decisions.md produced no chunks');
    assert.strictEqual(chunks[0].kind, 'record');
    assert.match(chunks[0].content, /Ørsted/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the emitted projection carries the Record, not just Project and Next', () => {
  const dir = fixture();
  try {
    const chunks = discover(dir).flatMap(s => intentParser.parse(s));
    const output = emit(chunks, { projectName: 'fixture' });
    assert.match(output, /## Record/, 'projection has no Record section');
    assert.match(output, /Ørsted/u, 'projection dropped the recorded decision');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Record section points at the canonical file rather than replacing it', () => {
  const dir = fixture();
  try {
    const chunks = discover(dir).flatMap(s => intentParser.parse(s));
    const output = emit(chunks, { projectName: 'fixture' });
    assert.match(output, /\.intent\/decisions\.md/, 'Record section does not name its source of truth');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project with no decisions.md emits no empty Record section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-norecord-'));
  fs.mkdirSync(path.join(dir, '.intent'));
  fs.writeFileSync(path.join(dir, '.intent', 'vision.md'), '# Vision\n\n## North Star\nStable slugs.\n');
  try {
    const chunks = discover(dir).flatMap(s => intentParser.parse(s));
    const output = emit(chunks, { projectName: 'fixture' });
    assert.doesNotMatch(output, /## Record/, 'emitted an empty Record section');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
