const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProjectBinding } = require('../lib/project-binding');

const P = (id, name) => ({ id, name });

// ── an explicit link outranks a name match ─────────────────────────────────
// This is the whole reason the function exists. `phewsh link` is a human
// statement of identity; a matching name is a guess. If the guess wins, a
// second cloud project that happens to share a display name captures the repo.

test('a linked id wins even when a different project shares the name', () => {
  const out = resolveProjectBinding({
    linkedId: 'p_mine',
    byId: P('p_mine', 'phewsh'),
    byName: [P('p_someone_elses', 'phewsh')],
  });
  assert.equal(out.action, 'use');
  assert.equal(out.project.id, 'p_mine');
  assert.equal(out.source, 'linked');
});

test('an id passed on the command line outranks the stored link', () => {
  const out = resolveProjectBinding({
    requestedId: 'p_asked_for',
    linkedId: 'p_stored',
    byId: P('p_asked_for', 'phewsh'),
    byName: [P('p_by_name', 'phewsh')],
  });
  assert.equal(out.action, 'use');
  assert.equal(out.project.id, 'p_asked_for');
  assert.equal(out.source, 'requested');
});

// ── a link that resolves to nothing must not fall back to a guess ──────────

test('a linked id that no longer resolves reports absent, never a name match', () => {
  const out = resolveProjectBinding({
    linkedId: 'p_deleted',
    byId: null,
    byName: [P('p_lookalike', 'phewsh')],
  });
  assert.equal(out.action, 'absent');
  assert.equal(out.id, 'p_deleted', 'the caller needs the id it was meant to be');
  assert.equal(out.source, 'linked');
  assert.ok(!('project' in out), 'must not hand back the lookalike');
});

test('a requested id that does not resolve reports absent', () => {
  const out = resolveProjectBinding({ requestedId: 'p_nope', byId: null });
  assert.equal(out.action, 'absent');
  assert.equal(out.id, 'p_nope');
  assert.equal(out.source, 'requested');
});

// ── name matching, only when there is no link and only when unambiguous ────

test('one name match and no link is used, and is labelled a guess', () => {
  const out = resolveProjectBinding({ byName: [P('p_only', 'phewsh')] });
  assert.equal(out.action, 'use');
  assert.equal(out.project.id, 'p_only');
  assert.equal(out.source, 'name');
});

test('two projects sharing a name are ambiguous — never pick the first', () => {
  const out = resolveProjectBinding({
    byName: [P('p_a', 'phewsh'), P('p_b', 'phewsh')],
  });
  assert.equal(out.action, 'ambiguous');
  assert.deepEqual(out.matches.map((m) => m.id), ['p_a', 'p_b']);
});

test('no link and no name match is none', () => {
  const out = resolveProjectBinding({ byName: [] });
  assert.equal(out.action, 'none');
});

// ── shape guards ───────────────────────────────────────────────────────────

test('missing and empty inputs are treated the same as absent ones', () => {
  assert.equal(resolveProjectBinding({}).action, 'none');
  assert.equal(
    resolveProjectBinding({ linkedId: '', byName: [] }).action,
    'none',
    'an empty string is not a link'
  );
});

test('byName is never consulted while a link resolves', () => {
  // Guards the ordering directly: if byName were read first this would be
  // 'ambiguous' rather than a clean 'use'.
  const out = resolveProjectBinding({
    linkedId: 'p_mine',
    byId: P('p_mine', 'phewsh'),
    byName: [P('p_a', 'phewsh'), P('p_b', 'phewsh')],
  });
  assert.equal(out.action, 'use');
  assert.equal(out.project.id, 'p_mine');
});
