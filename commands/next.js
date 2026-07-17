// phewsh next — one of the four plain words (Project · Next · Work · Record).
// A zero-AI "what should happen next?" list that lives in `.intent/next.json`,
// so it travels with the repo and compatible AI tools can read the same list. Works
// for a human alone with no model in the loop — a thinking tool first.
//
//   phewsh next                 show NOW / NEXT / DONE + phewsh's suggestion
//   phewsh next add "<title>"   queue something
//   phewsh next start <n|id>    mark it in progress (NOW)
//   phewsh next done <n|id>     mark it shipped (DONE)
//   phewsh next drop <n|id>     remove it
//   phewsh next clear           clear the DONE pile

const next = require('../lib/next');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const teal = (s) => `\x1b[38;5;79m${s}\x1b[0m`;
const sage = (s) => `\x1b[38;5;151m${s}\x1b[0m`;
const slate = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const cream = (s) => `\x1b[38;5;230m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const peach = (s) => `\x1b[38;5;216m${s}\x1b[0m`;

const MARK = { now: green('◐'), next: slate('○'), done: slate('✓') };
const LABEL = { now: cream('NOW '), next: teal('NEXT'), done: slate('DONE') };
const VSYM = { pass: green('✓'), partial: yellow('~'), fail: red('✗'), unknown: slate('?'), human: peach('◇'), proposed: slate('○') };

function render(cwd = process.cwd()) {
  const data = next.load(cwd);
  const list = next.ordered(data);
  console.log('');
  console.log(`  ${b(cream('NEXT'))} ${slate('— what should happen next ·')} ${slate('.intent/next.json')}`);
  console.log('');
  if (list.length === 0) {
    console.log(`  ${slate('Nothing queued yet.')}`);
    console.log(`  ${slate('Add one:')} ${cream('phewsh next add "the thing you want done"')}`);
  } else {
    list.forEach((it, i) => {
      const n = slate(String(i + 1).padStart(2));
      const title = it.state === 'done' ? slate(it.title) : cream(it.title);
      console.log(`  ${n} ${MARK[it.state]} ${LABEL[it.state]}  ${title}`);
      if (Array.isArray(it.criteria) && it.criteria.length) {
        try {
          const { results } = require('../lib/verify').verifyAll(it.criteria, cwd);
          results.forEach(r => console.log(`       ${VSYM[r.status] || slate('·')} ${slate(r.expected)} ${slate('· ' + r.note)}`));
        } catch { /* verdicts are best-effort */ }
      }
    });
    console.log('');
    console.log(`  ${slate('start # · done # · drop # · add "…" · criteria # … · clear')}`);
  }

  // Unify with phewsh's own recommendation: the user's list is what THEY want
  // next; this one line is what phewsh notices is worth doing. Best-effort.
  try {
    const { suggest } = require('../lib/suggest');
    const tip = suggest(buildState(cwd));
    if (tip) {
      console.log('');
      console.log(`  ${teal('⤷ phewsh suggests')}  ${cream(tip.command.trim())}  ${sage(tip.message)}`);
    }
  } catch { /* suggestion is a nicety, never required */ }
  console.log('');
}

// Minimal state for the suggestion engine — mirrors session.buildSuggestState
// but standalone (no live session). Everything fail-soft.
function buildState(cwd) {
  const fs = require('fs');
  const path = require('path');
  const hasIntentDir = fs.existsSync(path.join(cwd, '.intent'));
  let intentFileCount = 0;
  try {
    intentFileCount = fs.readdirSync(path.join(cwd, '.intent')).filter(f => f.endsWith('.md')).length;
  } catch { /* none */ }
  let packsInstalled = false;
  try {
    const { PACKS, isInstalled } = require('../lib/packs');
    packsInstalled = Object.keys(PACKS).some(name => isInstalled(name, cwd));
  } catch { /* ignore */ }
  let installedHarnesses = [];
  try { installedHarnesses = require('../lib/harnesses').listHarnesses().filter(h => h.installed).map(h => h.id); } catch { /* ignore */ }
  return { hasIntentDir, intentFileCount, installedHarnesses, packsInstalled, turnsThisSession: 1 };
}

function notFound(ref) {
  console.log('');
  console.log(`  ${slate('No item')} ${cream(ref)}${slate('. Run')} ${cream('phewsh next')} ${slate('to see the numbered list.')}`);
  console.log('');
}

function main() {
  const sub = (process.argv[3] || '').toLowerCase();
  const rest = process.argv.slice(4).join(' ').replace(/^["']|["']$/g, '');

  if (!sub || sub === 'list' || sub === 'ls') {
    render();
    return;
  }

  if (sub === 'add' || sub === 'a') {
    const item = next.add(rest);
    if (!item) {
      console.log(`\n  ${slate('Add what? e.g.')} ${cream('phewsh next add "wire up the MCP read connector"')}\n`);
      return;
    }
    render();
    return;
  }

  if (sub === 'start' || sub === 'now' || sub === 'done' || sub === 'drop' || sub === 'rm') {
    const ref = process.argv[4];
    if (!ref) { console.log(`\n  ${slate('Which one? e.g.')} ${cream('phewsh next ' + sub + ' 1')}\n`); return; }
    if (sub === 'drop' || sub === 'rm') {
      const removed = next.remove(ref);
      if (!removed) return notFound(ref);
    } else {
      const state = sub === 'start' || sub === 'now' ? 'now' : 'done';
      const item = next.setState(ref, state);
      if (!item) return notFound(ref);
    }
    render();
    return;
  }

  if (sub === 'clear') {
    const data = next.load();
    data.items = data.items.filter(it => it.state !== 'done');
    next.save(data);
    render();
    return;
  }

  // Verification criteria — define what "done" looks like up front.
  //   phewsh next criteria <#>                       show verdicts
  //   phewsh next criteria <#> human "<expected>"    a human judgment
  //   phewsh next criteria <#> file <path>           a file must exist
  //   phewsh next criteria <#> contains <path> <txt> a file must contain text
  //   phewsh next criteria <#> changed <path>        a path must change vs HEAD
  //   phewsh next criteria <#> accept | clear
  if (sub === 'criteria' || sub === 'criterion') {
    const ref = process.argv[4];
    const kind = (process.argv[5] || '').toLowerCase();
    const args = process.argv.slice(6);
    if (!ref) { console.log(`\n  ${slate('Which item? e.g.')} ${cream('phewsh next criteria 1 file out.txt')}\n`); return; }
    if (!kind) { render(); return; }
    if (kind === 'accept') { if (!next.acceptCriteria(ref)) return notFound(ref); render(); return; }
    if (kind === 'clear') { if (!next.clearCriteria(ref)) return notFound(ref); render(); return; }
    let criterion = null;
    if (kind === 'human') {
      criterion = { expected: args.join(' ').replace(/^["']|["']$/g, '') || 'human judgment required', type: 'human' };
    } else if (kind === 'file' || kind === 'changed') {
      const p = args[0];
      if (!p) { console.log(`\n  ${slate('Need a path. e.g.')} ${cream('phewsh next criteria ' + ref + ' ' + kind + ' cli/lib/verify.js')}\n`); return; }
      const exp = args.slice(1).join(' ').replace(/^["']|["']$/g, '') || `${p} ${kind === 'file' ? 'exists' : 'changed'}`;
      criterion = { expected: exp, type: 'measurable', check: { kind, path: p } };
    } else if (kind === 'contains') {
      const p = args[0]; const text = args.slice(1).join(' ').replace(/^["']|["']$/g, '');
      if (!p || !text) { console.log(`\n  ${slate('Need a path and text. e.g.')} ${cream('phewsh next criteria ' + ref + ' contains README.md "Four words"')}\n`); return; }
      criterion = { expected: `${p} contains "${text}"`, type: 'measurable', check: { kind: 'contains', path: p, text } };
    } else {
      console.log(`\n  ${slate('Kinds:')} ${cream('human <expected> | file <path> | contains <path> <text> | changed <path> | accept | clear')}\n`);
      return;
    }
    if (!next.addCriterion(ref, criterion)) return notFound(ref);
    render();
    return;
  }

  // Unknown sub → treat the whole thing as a quick add ("phewsh next fix the bug")
  const item = next.add([sub, rest].filter(Boolean).join(' '));
  if (item) { render(); return; }
  render();
}

module.exports = main;
