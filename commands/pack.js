// phewsh pack — opt-in gateway to AI-workflow enhancements (Karpathy-style
// guidelines, GSD, …). Attributed, previewed, confirmed, reversible. phewsh's
// core stays continuity; packs are an optional layer you choose.
//
//   phewsh pack                  list packs (available + installed)
//   phewsh pack install <name>   show source/license + diff, confirm, install
//   phewsh pack remove <name>    remove a vendored pack's marked block

const readline = require('readline');
const packs = require('../lib/packs');

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

function list() {
  console.log('');
  console.log(`  ${b(cream('phewsh packs'))} ${sage('— optional, attributed, reversible enhancements')}`);
  console.log(`  ${slate('phewsh\'s core is continuity; these are extras you opt into.')}`);
  console.log('');
  for (const [name, p] of Object.entries(packs.PACKS)) {
    const on = packs.isInstalled(name);
    const tag = p.kind === 'linked' ? slate('[linked]') : (on ? green('[installed]') : slate('[available]'));
    console.log(`  ${cream(name.padEnd(16))} ${tag}`);
    console.log(`    ${slate(p.desc)}`);
    console.log(`    ${slate('source: ' + p.source)}`);
  }
  console.log('');
  console.log(`  ${sage('Install:')} ${cream('phewsh pack install <name>')}   ${sage('All official packs at once:')} ${cream('phewsh pack install all')}`);
  console.log(`  ${sage('Remove:')}  ${cream('phewsh pack remove <name>')}    ${sage('Read about every pack:')} ${cream('phewsh.com/cli#packs')}`);
  console.log('');
}

// `phewsh pack install all` — every official (vendored) pack in one confirmed
// pass. Linked packs stay pointers to their upstream source; we list them so
// nothing external ever installs silently.
async function installAll() {
  const vendored = Object.entries(packs.PACKS).filter(([, p]) => p.kind !== 'linked');
  const linked = Object.entries(packs.PACKS).filter(([, p]) => p.kind === 'linked');
  const pending = vendored.filter(([name]) => !packs.isInstalled(name));

  console.log('');
  if (pending.length === 0) {
    console.log(`  ${sage('All official packs are already installed here.')}`);
  } else {
    console.log(`  ${b(cream('Official phewsh packs'))} ${sage('— ' + pending.length + ' to install:')}`);
    pending.forEach(([name, p]) => console.log(`    ${cream(name.padEnd(16))} ${slate(p.desc)}`));
    console.log('');
    const ok = await confirm(`  ${b('Install ' + (pending.length === 1 ? 'it' : 'all ' + pending.length) + ' here?')} ${slate('[y/N] ')}`);
    if (!ok) { console.log(`  ${sage('Nothing changed.')}\n`); return; }
    for (const [name] of pending) {
      const { written } = packs.install(name);
      console.log(`  ${green('●')} ${cream(name)} ${slate('→ ' + written.join(', '))}`);
    }
    console.log(`  ${sage('Remove any:')} ${cream('phewsh pack remove <name>')}`);
  }
  if (linked.length > 0) {
    console.log('');
    console.log(`  ${sage(linked.length + ' more are linked packs — separate tools phewsh points at but never auto-installs:')}`);
    console.log(`    ${cream('phewsh pack')} ${sage('lists them ·')} ${cream('phewsh.com/cli#packs')} ${sage('tells their stories')}`);
  }
  console.log('');
}

async function install(name) {
  const p = packs.PACKS[name];
  if (!p) { console.log(`\n  ${yellow('Unknown pack:')} ${name}. See ${cream('phewsh pack')}.\n`); return; }

  console.log('');
  console.log(`  ${b(cream(p.title))} ${slate('(pack: ' + name + ')')}`);
  console.log(`  ${slate(p.desc)}`);
  console.log(`  ${peach('source:')}  ${slate(p.source)}`);
  console.log(`  ${peach('license:')} ${slate(p.license)}`);
  console.log('');

  if (p.kind === 'linked') {
    console.log(`  ${sage('This is a separate tool — phewsh doesn\'t vendor it. Start here:')}`);
    console.log(`    ${cream(p.install)}`);
    console.log('');
    return;
  }

  const preview = packs.previewInstall(name);
  console.log(`  ${sage('Writes a clearly-marked, removable block into:')} ${cream(preview.files.join(', '))}`);
  console.log(`  ${slate('Preview:')}`);
  preview.block.split('\n').slice(0, 8).forEach(l => console.log(`    ${slate('│ ' + l)}`));
  console.log(`    ${slate('│ … (' + preview.block.split('\n').length + ' lines total)')}`);
  console.log('');

  const ok = await confirm(`  ${b('Install this pack here?')} ${slate('[y/N] ')}`);
  if (!ok) { console.log(`  ${sage('Nothing changed.')}\n`); return; }

  const { written } = packs.install(name);
  console.log('');
  console.log(`  ${green('●')} ${b('Installed.')} ${slate('→ ' + written.join(', '))}`);
  console.log(`  ${sage('Remove anytime:')} ${cream('phewsh pack remove ' + name)}`);
  console.log('');
}

function remove(name) {
  const p = packs.PACKS[name];
  if (!p) { console.log(`\n  ${yellow('Unknown pack:')} ${name}.\n`); return; }
  if (p.kind === 'linked') { console.log(`\n  ${sage(p.title + ' is a separate tool — uninstall it the way you installed it.')}\n`); return; }
  const { removed } = packs.remove(name);
  console.log('');
  if (removed.length) console.log(`  ${green('●')} ${b('Removed.')} ${slate('← ' + removed.join(', '))}`);
  else console.log(`  ${sage('Not installed here — nothing to remove.')}`);
  console.log('');
}

async function main() {
  const sub = process.argv[3];
  const name = process.argv[4];
  if (sub === 'install' && name === 'all') return installAll();
  if (sub === 'install' && name) return install(name);
  if (sub === 'remove' && name) return remove(name);
  return list();
}

module.exports = main;
