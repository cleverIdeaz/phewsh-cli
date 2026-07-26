// End-to-end binding tests for `phewsh push` / `phewsh pull`.
//
// project-binding.test.js proves the *decision*. This proves the **wiring** —
// that push and pull actually ask the right question and act on the answer.
// That gap mattered: the defect these guard against was not a bad decision, it
// was pull never consulting the link at all.
//
// No network. `../lib/supabase` is replaced in the require cache before
// commands/sync.js is loaded, and INTENT_DIR is fixed at require time from
// process.cwd(), so each case runs against a real temp repo on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SUPABASE = require.resolve('../lib/supabase');
const SYNC = require.resolve('../commands/sync');

const CONFIG = { supabaseUserId: 'u1', supabaseAccessToken: 't' };

function tempRepo(label, { cloudId, vision = '# local vision\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `phewsh-sync-${label}-`));
  const intent = path.join(dir, '.intent');
  fs.mkdirSync(intent, { recursive: true });
  fs.writeFileSync(path.join(intent, 'vision.md'), vision);
  const pps = { archetype: 'product', adapters: {} };
  if (cloudId) pps.adapters.phewsh = { cloud_id: cloudId };
  fs.writeFileSync(path.join(intent, 'pps.json'), JSON.stringify(pps));
  return { dir, intent };
}

const readPPS = (intent) =>
  JSON.parse(fs.readFileSync(path.join(intent, 'pps.json'), 'utf-8'));

// Anchored on a field boundary: an unanchored /id=eq\./ also matches the
// `id=eq.` inside `user_id=eq.u1`, which silently turned every name lookup
// into a lookup for the user id — and made two of these tests pass vacuously.
const capture = (query, field) =>
  (query.match(new RegExp(`(?:^|&)${field}=eq\\.([^&]+)`)) || [])[1];

/**
 * Load sync.js against a temp repo with fake data access.
 * `projects` is the whole cloud table; the fake honours the same id/name
 * filters the real queries use, so a wrong query returns the wrong rows here
 * exactly as it would in production.
 */
function loadSync({ cwd, projects = [], artifacts = [] }) {
  const calls = { selects: [], upserts: [] };

  const select = async (table, query = '') => {
    calls.selects.push(`${table}?${query}`);
    if (table === 'projects') {
      const id = capture(query, 'id');
      const name = capture(query, 'name');
      if (id) return projects.filter((p) => p.id === id);
      if (name) {
        const want = decodeURIComponent(name);
        return projects.filter((p) => p.name === want);
      }
      return [];
    }
    if (table === 'artifacts') {
      const pid = capture(query, 'project_id');
      return pid ? artifacts.filter((a) => a.project_id === pid) : [];
    }
    return [];
  };

  const upsert = async (table, payload) => {
    calls.upserts.push({ table, payload });
    return [payload];
  };

  const prev = require.cache[SUPABASE];
  require.cache[SUPABASE] = {
    id: SUPABASE, filename: SUPABASE, loaded: true, children: [], paths: [],
    exports: { select, upsert, refreshSession: async () => null },
  };
  delete require.cache[SYNC];

  const cwdBefore = process.cwd();
  process.chdir(cwd);
  let mod;
  try {
    mod = require(SYNC);
  } finally {
    process.chdir(cwdBefore);
  }

  const restore = () => {
    if (prev) require.cache[SUPABASE] = prev;
    else delete require.cache[SUPABASE];
    delete require.cache[SYNC];
  };
  return { mod, calls, restore };
}

/** Run inside the repo dir, capturing a process.exit as a throw. */
async function run(cwd, fn) {
  const before = process.cwd();
  const realExit = process.exit;
  const realLog = console.log;
  console.log = () => {};
  process.exit = (code) => { throw new Error(`EXIT:${code}`); };
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(before);
    process.exit = realExit;
    console.log = realLog;
  }
}

// ── the regression that motivated all of this ──────────────────────────────

test('pull binds to the linked project, not a stranger sharing its name', async () => {
  const { dir, intent } = tempRepo('pull-linked', { cloudId: 'p_mine' });
  const { mod, restore } = loadSync({
    cwd: dir,
    // Both are called "phewsh". Only one is ours.
    projects: [
      { id: 'p_stranger', name: 'phewsh', pps_json: null },
      { id: 'p_mine', name: 'phewsh', pps_json: null },
    ],
    artifacts: [
      { project_id: 'p_stranger', kind: 'vision', content: '# STRANGER CONTENT\n' },
      { project_id: 'p_mine', kind: 'vision', content: '# mine\n' },
    ],
  });

  try {
    await run(dir, () => mod.pull(CONFIG, 't'));
    const vision = fs.readFileSync(path.join(intent, 'vision.md'), 'utf-8');
    assert.doesNotMatch(vision, /STRANGER/, 'pull overwrote .intent/ from a same-named project');
    assert.match(vision, /# mine/);
    assert.equal(readPPS(intent).adapters.phewsh.cloud_id, 'p_mine', 'the link was rewritten');
  } finally {
    restore();
  }
});

test('pull refuses when two projects share the name and there is no link', async () => {
  const { dir, intent } = tempRepo('pull-ambiguous');
  const name = path.basename(dir);
  const { mod, restore } = loadSync({
    cwd: dir,
    projects: [{ id: 'p_a', name }, { id: 'p_b', name }],
    artifacts: [{ project_id: 'p_a', kind: 'vision', content: '# guessed\n' }],
  });
  try {
    await run(dir, () => mod.pull(CONFIG, 't'));
    assert.equal(
      fs.readFileSync(path.join(intent, 'vision.md'), 'utf-8'),
      '# local vision\n',
      'an ambiguous name must not overwrite local truth'
    );
    assert.equal(readPPS(intent).adapters.phewsh, undefined, 'must not invent a link');
  } finally {
    restore();
  }
});

test('pull stops when the link points at a project that is gone', async () => {
  const { dir, intent } = tempRepo('pull-absent', { cloudId: 'p_deleted' });
  const name = path.basename(dir);
  const { mod, restore } = loadSync({
    cwd: dir,
    // A same-named project exists — the old code would have silently used it.
    projects: [{ id: 'p_lookalike', name }],
    artifacts: [{ project_id: 'p_lookalike', kind: 'vision', content: '# LOOKALIKE\n' }],
  });
  try {
    await run(dir, () => mod.pull(CONFIG, 't'));
    const vision = fs.readFileSync(path.join(intent, 'vision.md'), 'utf-8');
    assert.doesNotMatch(vision, /LOOKALIKE/);
    assert.equal(readPPS(intent).adapters.phewsh.cloud_id, 'p_deleted', 'the link must survive');
  } finally {
    restore();
  }
});

test('pull uses an id given on the command line over the stored link', async () => {
  const { dir, intent } = tempRepo('pull-explicit', { cloudId: 'p_stored' });
  const { mod, restore } = loadSync({
    cwd: dir,
    projects: [{ id: 'p_stored', name: 'x' }, { id: 'p_asked', name: 'y' }],
    artifacts: [
      { project_id: 'p_stored', kind: 'vision', content: '# stored\n' },
      { project_id: 'p_asked', kind: 'vision', content: '# asked\n' },
    ],
  });
  try {
    await run(dir, () => mod.pull(CONFIG, 't', 'p_asked'));
    assert.match(fs.readFileSync(path.join(intent, 'vision.md'), 'utf-8'), /# asked/);
  } finally {
    restore();
  }
});

// ── push ───────────────────────────────────────────────────────────────────

test('push targets the linked project even when a same-named one exists', async () => {
  const { dir, intent } = tempRepo('push-linked', { cloudId: 'p_mine' });
  const { mod, calls, restore } = loadSync({
    cwd: dir,
    projects: [
      { id: 'p_stranger', name: 'phewsh' },
      { id: 'p_mine', name: 'phewsh' },
    ],
  });
  try {
    await run(dir, () => mod.push(CONFIG, 't'));
    const artifactWrites = calls.upserts.filter((u) => u.table === 'artifacts');
    assert.ok(artifactWrites.length > 0, 'nothing was pushed');
    for (const w of artifactWrites) {
      assert.equal(w.payload.project_id, 'p_mine', 'pushed this project into a stranger');
    }
    assert.equal(readPPS(intent).adapters.phewsh.cloud_id, 'p_mine');
    // It must not even ask by name once a link exists.
    assert.ok(
      !calls.selects.some((q) => q.startsWith('projects?name=eq.')),
      'push searched by name despite having a link'
    );
  } finally {
    restore();
  }
});

test('push refuses to guess between two projects sharing the name', async () => {
  const { dir } = tempRepo('push-ambiguous');
  const name = path.basename(dir);
  const { mod, calls, restore } = loadSync({
    cwd: dir,
    projects: [{ id: 'p_a', name }, { id: 'p_b', name }],
  });
  try {
    await assert.rejects(
      () => run(dir, () => mod.push(CONFIG, 't')),
      /EXIT:1/,
      'push should stop rather than pick one'
    );
    assert.equal(calls.upserts.length, 0, 'push wrote to the cloud while ambiguous');
  } finally {
    restore();
  }
});

test('push restores a linked project at the same id when it has gone missing', async () => {
  const { dir, intent } = tempRepo('push-restore', { cloudId: 'p_gone' });
  const { mod, calls, restore } = loadSync({ cwd: dir, projects: [] });
  try {
    await run(dir, () => mod.push(CONFIG, 't'));
    const created = calls.upserts.find((u) => u.table === 'projects');
    assert.equal(created.payload.id, 'p_gone', 'the bond must survive a deleted cloud project');
    assert.equal(readPPS(intent).adapters.phewsh.cloud_id, 'p_gone');
  } finally {
    restore();
  }
});
