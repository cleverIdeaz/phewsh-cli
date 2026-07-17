// "Next" — the structured backing for one of phewsh's four plain words
// (Project · Next · Work · Record). A dead-simple, zero-AI task list that
// answers "what should happen next?" for a human alone OR for any AI tool
// reading the project. Lives in `.intent/next.json` so it travels with the
// repo so supported adapters can read the same list — no account or model needed.
//
// Three states only, on purpose: NOW (doing it), NEXT (queued), DONE (shipped).
// CG called this a "queue"; we call it Next because everyone understands it.
// Pure + fail-soft: a corrupt/odd-shaped file degrades to empty, never throws.

const fs = require('fs');
const path = require('path');

const STATES = ['now', 'next', 'done'];
// Display order — what you act on first, what's queued, what's already done.
const ORDER = { now: 0, next: 1, done: 2 };

function intentDir(cwd = process.cwd()) {
  return path.join(cwd, '.intent');
}

function nextFile(cwd = process.cwd()) {
  return path.join(intentDir(cwd), 'next.json');
}

function load(cwd = process.cwd()) {
  try {
    const data = JSON.parse(fs.readFileSync(nextFile(cwd), 'utf-8'));
    const items = Array.isArray(data?.items) ? data.items.filter(it => it && it.id && it.title) : [];
    return { version: 1, items };
  } catch {
    return { version: 1, items: [] };
  }
}

function save(data, cwd = process.cwd()) {
  try {
    fs.mkdirSync(intentDir(cwd), { recursive: true });
    fs.writeFileSync(nextFile(cwd), JSON.stringify({ version: 1, items: data.items }, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** Items in display order: NOW, then NEXT, then DONE; stable within a state. */
function ordered(data) {
  return data.items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (ORDER[a.it.state] ?? 1) - (ORDER[b.it.state] ?? 1) || a.i - b.i)
    .map(x => x.it);
}

/** Resolve a user reference (exact id, or 1-based number in display order). */
function resolve(data, ref) {
  if (ref == null) return null;
  const byId = data.items.find(it => it.id === ref);
  if (byId) return byId;
  const n = parseInt(ref, 10);
  if (Number.isInteger(n) && n >= 1) {
    const list = ordered(data);
    if (n <= list.length) return list[n - 1];
  }
  return null;
}

function add(title, cwd = process.cwd()) {
  const t = (title || '').trim();
  if (!t) return null;
  const data = load(cwd);
  const id = 'n' + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 4);
  const now = new Date().toISOString();
  const item = { id, title: t.slice(0, 200), state: 'next', created: now, updated: now };
  data.items.push(item);
  save(data, cwd);
  return item;
}

function setState(ref, state, cwd = process.cwd()) {
  if (!STATES.includes(state)) return null;
  const data = load(cwd);
  const item = resolve(data, ref);
  if (!item) return null;
  item.state = state;
  item.updated = new Date().toISOString();
  if (state === 'done') item.done = item.updated;
  save(data, cwd);
  return item;
}

function remove(ref, cwd = process.cwd()) {
  const data = load(cwd);
  const item = resolve(data, ref);
  if (!item) return null;
  data.items = data.items.filter(it => it.id !== item.id);
  save(data, cwd);
  return item;
}

// ── Verification criteria (the define→verify contract) ─────────────────────
// Criteria are an OPTIONAL list on an item — items without them work unchanged.
// Each: { expected, type: 'measurable'|'human', check?, accepted }.

function addCriterion(ref, criterion, cwd = process.cwd()) {
  const data = load(cwd);
  const item = resolve(data, ref);
  if (!item) return null;
  const expected = (criterion && criterion.expected || '').trim();
  if (!expected) return null;
  if (!Array.isArray(item.criteria)) item.criteria = [];
  const c = { expected: expected.slice(0, 300), type: criterion.type === 'human' ? 'human' : 'measurable', accepted: criterion.accepted !== false };
  if (criterion.check && criterion.check.kind) c.check = criterion.check;
  item.criteria.push(c);
  item.updated = new Date().toISOString();
  save(data, cwd);
  return item;
}

/** Accept all proposed criteria on an item (model-proposed → authoritative). */
function acceptCriteria(ref, cwd = process.cwd()) {
  const data = load(cwd);
  const item = resolve(data, ref);
  if (!item || !Array.isArray(item.criteria)) return null;
  item.criteria.forEach(c => { c.accepted = true; });
  save(data, cwd);
  return item;
}

function clearCriteria(ref, cwd = process.cwd()) {
  const data = load(cwd);
  const item = resolve(data, ref);
  if (!item) return null;
  item.criteria = [];
  save(data, cwd);
  return item;
}

/** The task a fresh brief should carry: started work, otherwise the top queue item. */
function briefItem(cwd = process.cwd()) {
  const items = ordered(load(cwd));
  return items.find(item => item.state === 'now') ||
    items.find(item => item.state === 'next') ||
    null;
}

/** Counts by state — for status/banner summaries. */
function counts(cwd = process.cwd()) {
  const { items } = load(cwd);
  return {
    now: items.filter(i => i.state === 'now').length,
    next: items.filter(i => i.state === 'next').length,
    done: items.filter(i => i.state === 'done').length,
    total: items.length,
  };
}

module.exports = {
  STATES,
  acceptCriteria,
  add,
  addCriterion,
  briefItem,
  clearCriteria,
  counts,
  load,
  nextFile,
  ordered,
  remove,
  resolve,
  save,
  setState,
};
