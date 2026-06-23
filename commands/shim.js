// phewsh shim — install/remove the launch-banner shims.
//
//   phewsh shim            status
//   phewsh shim on [--yes] consent screen, then install shims + PATH line
//   phewsh shim off        remove shims + PATH line
//
// Shims are the GUARANTEE that phewsh is active: phewsh prints a deterministic
// banner when you launch a tool, then runs the real tool. This is invasive
// (intercepts your tool commands on PATH + edits your shell rc), so it's an
// explicit opt-in with a consent screen — never auto-installed.

const readline = require('readline');
const { listHarnesses } = require('../lib/harnesses');
const shims = require('../lib/shims');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const teal = (s) => `\x1b[38;5;79m${s}\x1b[0m`;
const sage = (s) => `\x1b[38;5;151m${s}\x1b[0m`;
const slate = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const cream = (s) => `\x1b[38;5;230m${s}\x1b[0m`;
const peach = (s) => `\x1b[38;5;216m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

async function confirm(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}

function installedBins() {
  return listHarnesses().filter(h => h.installed).map(h => h.bin);
}

async function turnOn(skipConfirm) {
  const bins = installedBins();
  const resolvable = bins.filter(bin => shims.resolveReal(bin));
  console.log('');
  console.log(`  ${b(cream('phewsh shims'))} ${sage('— a guaranteed status banner when you launch your tools')}`);
  console.log('');
  if (resolvable.length === 0) {
    console.log(`  ${yellow('No installed tools found to shim.')} ${slate('Install a coding CLI first.')}`);
    console.log('');
    return;
  }
  console.log(`  ${sage('When you run any of these, phewsh prints one line, then runs the real tool:')}`);
  console.log(`    ${slate(resolvable.join('  '))}`);
  console.log('');
  console.log(`  ${peach('Exactly what changes:')}`);
  console.log(`    ${teal('+')} ${slate('tiny scripts in')} ${cream('~/.phewsh/shims/')} ${slate('(each runs the real tool — bricks nothing)')}`);
  console.log(`    ${teal('+')} ${slate('one PATH line in')} ${cream(shims.detectRcFile())}`);
  console.log(`  ${sage('Undo anytime:')} ${cream('phewsh shim off')}`);
  console.log('');
  if (!skipConfirm) {
    const ok = await confirm(`  ${b('Install shims?')} ${slate('[y/N] ')}`);
    if (!ok) { console.log(`  ${sage('Nothing changed.')}\n`); return; }
  }
  const { shimmed, skipped, rcFile, rcAdded } = shims.installShims(bins);
  console.log('');
  console.log(`  ${green('●')} ${b('Shims installed.')}`);
  shimmed.forEach(s => console.log(`    ${teal('+')} ${cream(s.bin.padEnd(12))} ${slate('→ ' + s.real)}`));
  if (skipped.length) console.log(`    ${slate('skipped (no real binary found): ' + skipped.join(', '))}`);
  if (rcAdded) console.log(`    ${teal('+')} ${slate('PATH line added to ' + rcFile)}`);
  console.log('');
  console.log(`  ${peach('Open a new terminal')} ${sage('(or `source ' + rcFile + '`) so the PATH change takes effect.')}`);
  console.log(`  ${sage('Then launching')} ${cream(shimmed[0] ? shimmed[0].bin : 'your tool')} ${sage('shows the phewsh banner first.')}`);
  console.log('');
}

function turnOff() {
  const { removed, rcFile, rcRemoved } = shims.removeShims();
  console.log('');
  if (removed.length || rcRemoved) {
    console.log(`  ${green('●')} ${b('Shims removed.')}`);
    if (removed.length) console.log(`    ${peach('-')} ${slate('removed ' + removed.join(', '))}`);
    if (rcRemoved) console.log(`    ${peach('-')} ${slate('PATH line removed from ' + rcFile)}`);
    console.log(`  ${sage('Open a new terminal so your shells stop using the shim dir.')}`);
  } else {
    console.log(`  ${sage('No shims were installed — nothing to remove.')}`);
  }
  console.log('');
}

function status() {
  const s = shims.shimStatus();
  console.log('');
  console.log(`  ${b(cream('phewsh shims'))} ${sage('— status')}`);
  console.log('');
  if (s.installed.length) {
    console.log(`    ${green('●')} ${cream('installed')} ${slate(s.installed.join(', '))}`);
    console.log(`        ${slate('dir: ' + s.shimDir)}`);
    console.log(`        ${slate('PATH active in this shell: ' + (s.onPath ? 'yes' : 'no — open a new terminal'))}`);
    console.log(`        ${slate('rc line in ' + s.rcFile + ': ' + (s.rcActive ? 'present' : 'missing'))}`);
  } else {
    console.log(`    ${yellow('○')} ${sage('not installed —')} ${cream('phewsh shim on')} ${sage('to add the launch banner')}`);
  }
  console.log('');
}

async function main() {
  const sub = process.argv[3] || 'status';
  const skipConfirm = process.argv.includes('--yes');
  if (sub === 'on') return turnOn(skipConfirm);
  if (sub === 'off') return turnOff();
  return status();
}

module.exports = main;
