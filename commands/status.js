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

function hasHook(file, eventName, command) {
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (config?.hooks?.[eventName] || [])
      .some(entry => (entry.hooks || []).some(hook => hook.command === command));
  } catch { return false; }
}

function safetyHooksApplied(file) {
  return hasHook(file, 'PreToolUse', 'phewsh hook pre-tool')
    && hasHook(file, 'PostToolUse', 'phewsh hook post-tool');
}

// Structured view of the same four answers, for machine consumers (the
// desktop shell reads this instead of scraping terminal output). Additive:
// the human path below is untouched. Schema v1 — extend, don't mutate.
function collect(cwd) {
  const intentDir = path.join(cwd, '.intent');
  const hasIntent = fs.existsSync(intentDir);
  const key = path.basename(cwd);

  let intentFiles = 0;
  let hasVision = false;
  if (hasIntent) {
    try {
      const files = fs.readdirSync(intentDir).filter(f => /\.(md|json)$/.test(f));
      intentFiles = files.length;
      hasVision = files.includes('vision.md');
    } catch { /* unreadable dir stays 0/false */ }
  }

  const next = { counts: { now: 0, next: 0, done: 0 }, focus: null };
  try {
    const nx = require('../lib/next');
    const items = nx.ordered(nx.load(cwd));
    items.forEach(i => { next.counts[i.state]++; });
    const focus = items.find(i => i.state === 'now') || items.find(i => i.state === 'next');
    if (focus) next.focus = { title: focus.title, state: focus.state };
  } catch { /* best-effort */ }

  const work = { tools: 0, lastTs: null };
  try {
    const continuity = require('../lib/continuity');
    const decisions = loadDecisions();
    work.tools = continuity.toolsInThread(decisions, { project: key });
    const line = continuity.lastLeftOff(decisions, { project: key });
    if (line && line.ts) work.lastTs = line.ts;
  } catch { /* best-effort */ }

  const record = { decisions: 0, pending: 0, remembered: 0, driftCommits: null, handoff: null };
  try {
    const stats = require('../lib/outcomes').outcomeStats({ project: key });
    record.decisions = stats.total || 0;
    record.pending = stats.pending || 0;
  } catch { /* none */ }
  try { record.remembered = require('../lib/record').notes(cwd).length; } catch { /* none */ }
  try { record.driftCommits = require('../lib/selfheal').commitsSinceIntent(cwd); } catch { /* unknown stays null */ }
  try {
    const handoff = require('../lib/handoff-receipt').latestHandoffReceipt({ cwd });
    if (handoff) record.handoff = { id: handoff.id || null, status: handoff.status };
  } catch { /* best-effort */ }

  const ledger = loadLedger();
  let ambientOn = false;
  try { ambientOn = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf-8').includes('phewsh hook session-start'); } catch { /* off */ }
  let satisfiedSkills = 0;
  try { satisfiedSkills = require('../lib/intent-skills').intentSkillStatus().satisfied.length; } catch { /* best-effort */ }
  let shims = 0;
  try { shims = require('../lib/shims').shimStatus().installed.length; } catch { /* none */ }
  const adaptersOn = ambientOn
    || Boolean(ledger.applied && ledger.applied.globalBase)
    || satisfiedSkills > 0;

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    version: require('../package.json').version,
    project: { name: projectName(cwd), key, hasIntent, intentFiles, hasVision },
    next,
    work,
    record,
    delivery: { adaptersOn, shims },
  };
}

function main() {
  const cwd = process.cwd();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(collect(cwd), null, 2));
    return;
  }

  const intentDir = path.join(cwd, '.intent');
  const hasIntent = fs.existsSync(intentDir);
  const key = path.basename(cwd);

  console.log('');
  console.log(`  ${b('😮‍💨 PHEWSH STATUS')} ${slate('· ' + projectName(cwd))}`);
  console.log(`  ${slate('Project · Next · Work · Record — four recorded answers supported tools can read')}`);
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
    try {
      const handoffReceipts = require('../lib/handoff-receipt');
      const handoff = handoffReceipts.latestHandoffReceipt({ cwd });
      if (!handoff) {
        console.log(row('', slate('handoff: none — cold start from .intent/ only')));
      } else if (handoff.status === 'verified') {
        const unfinished = handoff.receipt?.trigger === 'work-start';
        console.log(row('', unfinished
          ? `${yellow('△')} ${peach('handoff ' + handoff.id + ' matches work start')} ${slate('· no exit receipt; unrecorded decisions were not carried')}`
          : `${ok} ${sage('handoff ' + handoff.id + ' verified')} ${slate('· truth + repository unchanged')}`));
      } else if (handoff.status === 'partial') {
        console.log(row('', `${yellow('△')} ${peach('handoff ' + handoff.id + ' partial')} ${slate('· ' + handoffReceipts.summarizeEvidence(handoff.repositoryPartial))}`));
      } else if (handoff.status === 'moved') {
        const moved = [...handoff.truthChanged, ...handoff.repositoryChanged, ...handoff.briefChanged];
        console.log(row('', `${yellow('△')} ${peach('handoff ' + handoff.id + ' moved')} ${slate('· ' + handoffReceipts.summarizeEvidence(moved))}`));
      } else {
        console.log(row('', `${yellow('!')} ${peach('handoff ' + (handoff.id || 'receipt') + ' invalid')} ${slate('· ' + handoff.reason)}`));
      }
    } catch { /* handoff evidence is best-effort */ }
  }

  // ── Delivery (implementation — how phewsh reaches your tools) ───────
  console.log('');
  console.log(`  ${slate('Delivery')}`);
  const ledger = loadLedger();
  let ambientOn = false;
  try { ambientOn = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf-8').includes('phewsh hook session-start'); } catch { /* off */ }
  const gb = (ledger.applied && ledger.applied.globalBase) ? 'base files' : null;
  const sc = (ledger.applied && ledger.applied.slashCommands && ledger.applied.slashCommands.tools) || [];
  let skillState = { checked: [], satisfied: [], exact: [], managed: [], outdated: [], projectOverrides: [] };
  try { skillState = require('../lib/intent-skills').intentSkillStatus(); } catch { /* best-effort */ }
  const outdatedSkills = skillState.outdated || [];
  const customSkills = skillState.satisfied.filter(id => !skillState.exact.includes(id) && !outdatedSkills.includes(id));
  const pendingSkills = skillState.checked.filter(id => !skillState.satisfied.includes(id));
  const projectOverrides = skillState.projectOverrides || [];
  const safetyHooks = [
    safetyHooksApplied(path.join(os.homedir(), '.claude', 'settings.json')) ? 'claude-code' : null,
    safetyHooksApplied(path.join(os.homedir(), '.codex', 'hooks.json')) ? 'codex' : null,
  ].filter(Boolean);
  const adapterBits = [
    ambientOn ? 'Claude session hooks' : null,
    skillState.exact.length ? 'intent skill in ' + skillState.exact.join(', ') : null,
    outdatedSkills.length ? 'intent skill update available in ' + outdatedSkills.join(', ') : null,
    customSkills.length ? 'custom intent skill in ' + customSkills.join(', ') : null,
    pendingSkills.length ? 'intent skill pending in ' + pendingSkills.join(', ') : null,
    projectOverrides.length ? 'project-local intent skill override' : null,
    safetyHooks.length ? 'safety/receipt hooks in ' + safetyHooks.join(', ') : null,
    gb ? 'generated base files' : null,
    sc.length ? '/intent fallback in ' + sc.join(', ') : null,
  ].filter(Boolean);
  const adaptersDelivered = ambientOn || gb || skillState.satisfied.length > 0 || projectOverrides.length > 0 || safetyHooks.length > 0 || sc.length > 0;
  console.log(row('Adapters', adaptersDelivered ? `${ok} ${sage('on')} ${slate('(' + (adapterBits.join(' · ') || 'context sync') + ')')}` : `${off} ${slate('off — ')}${cream('phewsh ambient on')}`));
  for (const override of projectOverrides) {
    const exact = override.state === 'exact';
    const detail = exact
      ? 'matches Phewsh canonical · project-local, user-owned, preserved'
      : override.state === 'different'
        ? 'differs from Phewsh canonical · can override the user-level skill'
        : 'could not be read · can override the user-level skill';
    console.log(row('Project skill', `${exact ? ok : yellow('!')} ${cream(override.relative)} ${slate('(' + override.id + ' · ' + detail + ')')}`));
    if (!exact) console.log(row('', slate('phewsh will not edit it; review, rename, or remove that project-local file yourself')));
  }

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
