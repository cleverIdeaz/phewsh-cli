// phewsh status — "git status for AI continuity."
//
// The product, stated as health. The user's real question isn't "did CLAUDE.md
// load" — it's "will the next AI know what the last one learned?" This answers
// it: project truth, the decision record, cross-tool continuity, drift, and how
// phewsh is wired into this machine. Everything else (hooks, shims, base files,
// /intent) is implementation that feeds this one view. Offline, deterministic.

const fs = require('fs');
const path = require('path');
const os = require('os');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const teal = (s) => `\x1b[38;5;79m${s}\x1b[0m`;
const sage = (s) => `\x1b[38;5;151m${s}\x1b[0m`;
const slate = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const cream = (s) => `\x1b[38;5;230m${s}\x1b[0m`;
const peach = (s) => `\x1b[38;5;216m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const ok = green('✓');
const off = slate('○');

function row(label, value) {
  return `  ${slate(label.padEnd(13))} ${value}`;
}

function projectName(cwd) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(cwd, '.intent', 'project.json'), 'utf-8'));
    if (m.name) return m.name;
  } catch { /* fall through */ }
  return path.basename(cwd);
}

function loadDecisions() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.phewsh', 'outcomes', 'decisions.json'), 'utf-8')); }
  catch { return []; }
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.phewsh', 'ambient.json'), 'utf-8')); }
  catch { return { applied: {} }; }
}

function main() {
  const cwd = process.cwd();
  const intentDir = path.join(cwd, '.intent');
  const hasIntent = fs.existsSync(intentDir);
  const key = path.basename(cwd);

  console.log('');
  console.log(`  ${b('😮‍💨 PHEWSH STATUS')} ${slate('· ' + projectName(cwd))}`);
  console.log(`  ${slate('Project · Next · Work · Record — the four answers every tool inherits')}`);
  console.log('');

  // ── PROJECT — what you're building & why ───────────────────────────
  if (!hasIntent) {
    console.log(row('PROJECT', `${off} ${sage('no shared project truth here yet')}`));
    console.log(row('', slate('create it so you — and the next AI — inherit context:')));
    console.log(row('', `${cream('phewsh init')} ${slate('(two questions) · guided:')} ${cream('phewsh clarify')}`));
  } else {
    const files = fs.readdirSync(intentDir).filter(f => /\.(md|json)$/.test(f));
    const has = (f) => files.includes(f);
    const visionBit = has('vision.md') ? sage('vision loaded') : slate('vision missing');
    console.log(row('PROJECT', `${ok} ${sage('.intent present')} ${slate('(' + files.length + ' files)')} ${slate('·')} ${visionBit}`));
  }

  // ── NEXT — what should happen next (works with zero AI) ────────────
  try {
    const nx = require('../lib/next');
    const items = nx.ordered(nx.load(cwd));
    if (items.length === 0) {
      console.log(row('NEXT', `${off} ${slate('nothing queued — ')}${cream('phewsh next add "…"')}`));
    } else {
      const c = { now: 0, next: 0, done: 0 };
      items.forEach(i => { c[i.state]++; });
      const bits = [];
      if (c.now) bits.push(green('◐ ' + c.now + ' in progress'));
      if (c.next) bits.push(teal('○ ' + c.next + ' queued'));
      if (c.done) bits.push(slate('✓ ' + c.done + ' done'));
      console.log(row('NEXT', bits.join(slate(' · '))));
      const focus = items.find(i => i.state === 'now') || items.find(i => i.state === 'next');
      if (focus) console.log(row('', cream(focus.title)));
    }
  } catch { /* best-effort */ }

  // ── WORK — what's being done right now (loops/runs land here later) ─
  if (hasIntent) {
    try {
      const continuity = require('../lib/continuity');
      const decisions = loadDecisions();
      const tools = continuity.toolsInThread(decisions, { project: key });
      const line = continuity.lastLeftOff(decisions, { project: key });
      const last = line && line.ts ? slate(' · last ' + continuity.agoText(line.ts)) : '';
      if (tools >= 2) console.log(row('WORK', `${ok} ${sage(tools + ' tools, one thread')}${last}`));
      else if (tools === 1) console.log(row('WORK', `${slate('1 tool so far — continuity builds as you switch tools')}${last}`));
      else console.log(row('WORK', slate('no runs active yet')));
    } catch { /* best-effort */ }
  }

  // ── RECORD — what happened & what we learned ───────────────────────
  if (hasIntent) {
    let stats = { total: 0, pending: 0 };
    try { stats = require('../lib/outcomes').outcomeStats({ project: key }); } catch { /* none */ }
    const pend = stats.pending ? ` ${slate('·')} ${peach(stats.pending + ' pending')}` : (stats.total ? ` ${slate('·')} ${slate('all labeled')}` : '');
    let noteBit = '';
    try { const n = require('../lib/record').notes(cwd).length; if (n) noteBit = ` ${slate('·')} ${sage(n + ' remembered')}`; } catch { /* none */ }
    let driftBit = '';
    try {
      const drift = require('../lib/selfheal').commitsSinceIntent(cwd);
      driftBit = drift > 0
        ? ` ${slate('·')} ${peach('drift ' + drift + ' commit(s)')} ${slate('— reconcile')}`
        : ` ${slate('·')} ${slate('no drift')}`;
    } catch { /* best-effort */ }
    console.log(row('RECORD', `${cream(stats.total + ' decisions')}${stats.total ? pend : slate(' — none yet')}${noteBit}${driftBit}`));
  }

  // ── Delivery (implementation — how phewsh reaches your tools) ───────
  console.log('');
  console.log(`  ${slate('Delivery')}`);
  const ledger = loadLedger();
  let ambientOn = false;
  try { ambientOn = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf-8').includes('phewsh hook session-start'); } catch { /* off */ }
  const gb = (ledger.applied && ledger.applied.globalBase) ? 'base files' : null;
  const sc = (ledger.applied && ledger.applied.slashCommands && ledger.applied.slashCommands.tools) || [];
  const ambientBits = [ambientOn ? 'Claude hook' : null, gb, sc.length ? '/intent in ' + sc.join(', ') : null].filter(Boolean);
  console.log(row('Ambient', (ambientOn || gb) ? `${ok} ${sage('on')} ${slate('(' + (ambientBits.join(' · ') || 'context sync') + ')')}` : `${off} ${slate('off — ')}${cream('phewsh ambient on')}`));

  let shimInstalled = [];
  try { shimInstalled = require('../lib/shims').shimStatus().installed; } catch { /* none */ }
  console.log(row('Shim', shimInstalled.length
    ? `${ok} ${sage('on')} ${slate('(' + shimInstalled.length + ' tools — banner each launch)')}`
    : `${off} ${slate('off — ')}${cream('phewsh shim on')} ${slate('for a visible launch banner')}`));

  console.log('');
  console.log(`  ${slate('The question this answers:')} ${cream('will the next AI know what the last one learned?')}`);
  console.log('');
}

module.exports = main;
