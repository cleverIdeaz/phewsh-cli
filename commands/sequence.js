// phewsh sequence (phewsh seq)
// Universal Memory Transform — reads this directory's memory files plus the
// user's global per-tool memory (read-only), emits optimal context per target.

const fs = require('fs');
const path = require('path');
const { sequence } = require('../lib/sequencer');
const ui = require('../lib/ui');

const { b, w, sage, slate, teal, cream, green, ember } = ui;

const args = process.argv.slice(3);

const flags = {
  target: getFlag('--target', '-t') || getPositionalTarget(),
  budget: getFlag('--budget', '-b') || 'standard',
  explain: args.includes('--explain') || args.includes('-e'),
  write: args.includes('--write') || args.includes('-w'),
  dryRun: args.includes('--dry-run'),
  all: args.includes('--all'),
  includeGlobal: args.includes('--include-global'),
  sources: getFlag('--sources', '-s'),
  help: args.includes('--help') || args.includes('-h'),
};

function getFlag(long, short) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === long || args[i] === short) && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

function getPositionalTarget() {
  // phewsh seq claude → target claude-md
  // phewsh seq cursor → target cursorrules
  const aliases = {
    claude: 'claude-md',
    cursor: 'cursorrules',
    agent: 'agent-md',
    soul: 'soul-md',
    json: 'json',
  };
  const first = args.find(a => !a.startsWith('-'));
  return aliases[first] || null;
}

function showHelp() {
  console.log('');
  console.log(`  ${b(cream('phewsh sequence'))} ${slate('(phewsh seq)')}`);
  console.log(`  ${sage('Universal Memory Transform — reads the memory files in this')}`);
  console.log(`  ${sage('directory plus your global per-user memory across tools,')}`);
  console.log(`  ${sage('then emits optimal context for any target agent.')}`);
  console.log('');
  console.log(`  ${cream('reads')} ${slate('(read-only — phewsh never edits these)')}`);
  console.log(`    ${sage('project  .intent/, CLAUDE.md, AGENTS.md, GEMINI.md, .cursorrules,')}`);
  console.log(`    ${sage('         copilot-instructions, README, + this project’s Claude memory')}`);
  console.log(`    ${sage('global   ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md')}`);
  console.log(`    ${slate('global memory is per-user and travels across every project.')}`);
  console.log('');
  console.log(`  ${cream('usage')}`);
  console.log(`    ${teal('phewsh seq')}              ${sage('Sequence → stdout summary (project + global)')}`);
  console.log(`    ${teal('phewsh seq')} ${slate('claude')}      ${sage('Sequence → CLAUDE.md section (project only)')}`);
  console.log(`    ${teal('phewsh seq')} ${slate('-w')}          ${sage('Write to target file')}`);
  console.log(`    ${teal('phewsh seq')} ${slate('--explain')}   ${sage('Show full ranking breakdown')}`);
  console.log(`    ${teal('phewsh seq')} ${slate('--dry-run')}   ${sage('Show sources found (with scope), no output')}`);
  console.log('');
  console.log(`  ${cream('targets')}`);
  console.log(`    ${teal('claude')}     ${sage('CLAUDE.md section (between markers)')}`);
  console.log('');
  console.log(`  ${cream('options')}`);
  console.log(`    ${teal('--budget')} ${slate('<level>')}   ${sage('Token budget: minimal|standard|full|unlimited')}`);
  console.log(`    ${teal('--sources')} ${slate('<list>')}  ${sage('Limit sources: intent,claude-md,claude-memory')}`);
  console.log(`    ${teal('--include-global')}    ${sage('Allow global memory into a written project file')}`);
  console.log(`    ${slate('                       (off by default — keeps personal notes out of committed files)')}`);
  console.log(`    ${teal('--write, -w')}         ${sage('Write output to target file')}`);
  console.log(`    ${teal('--explain, -e')}       ${sage('Full ranking breakdown')}`);
  console.log(`    ${teal('--dry-run')}           ${sage('Discover sources only')}`);
  console.log('');
}

async function main() {
  if (flags.help) { showHelp(); return; }

  const sourceFilter = flags.sources ? flags.sources.split(',') : null;

  // Dry run: just show what was found
  if (flags.dryRun) {
    const { discover } = require('../lib/sequencer/discover');
    let sources = discover();
    if (sourceFilter) {
      sources = sources.filter(s => sourceFilter.some(f => s.type === f || s.type.startsWith(f)));
    }

    const projectCount = sources.filter(s => s.scope !== 'global').length;
    const globalCount = sources.filter(s => s.scope === 'global').length;

    console.log('');
    console.log(`  ${b(cream('Sources discovered'))} ${slate(`(${sources.length})`)}`);
    ui.divider('line');
    if (sources.length === 0) {
      console.log(`  ${sage('No recognized memory files found in')} ${slate(process.cwd())}`);
    } else {
      for (const source of sources) {
        const tag = source.scope === 'global' ? slate('global ') : sage('project');
        console.log(`    ${tag} ${teal(source.type.padEnd(18))} ${sage(source.name)}`);
      }
    }
    ui.divider('line');
    console.log(`  ${slate(`${projectCount} project · ${globalCount} global`)}`);
    console.log(`  ${slate('global = per-user memory across all tools; summary-only unless --include-global on write')}`);
    console.log('');
    return;
  }

  // Default behavior: no target = stdout summary
  const target = flags.target || 'stdout';

  // CANONICAL WRITE. Writing a native projection (e.g. `phewsh seq claude -w`)
  // goes through the one canonical projector (self-heal), NOT the broad
  // sequencer — identical block, identical source policy, no stale clobber.
  if (flags.write && target === 'claude-md') {
    const selfheal = require('../lib/selfheal');
    const res = selfheal.syncContextFiles({ targets: ['CLAUDE.md'], createMissing: true });
    if (res.synced && res.synced.length) {
      console.log(`\n  ${green('✓')} ${sage('CLAUDE.md — canonical .intent/ projection (same block self-heal & watch write)')}\n`);
    } else {
      console.log(`\n  ${slate('CLAUDE.md already current' + (res.reason ? ' (' + res.reason + ')' : ''))}\n`);
    }
    return;
  }

  try {
    const result = sequence({
      target,
      budget: flags.budget,
      sources: sourceFilter,
      explain: flags.explain,
      write: flags.write,
      includeGlobal: flags.includeGlobal,
    });

    // If target is stdout, emit already printed
    if (target === 'stdout') return;

    // If writing to file
    if (flags.write) {
      if (result.writeResult === 'updated') {
        console.log(`\n  ${green('\u2713')} ${sage('Updated CLAUDE.md')}`);
      } else if (result.writeResult === 'created') {
        console.log(`\n  ${green('\u2713')} ${sage('Created CLAUDE.md')}`);
      }
      console.log(`  ${slate(`${result.chunks.length} chunks from ${result.sources.length} sources`)}`);
      console.log('');
      return;
    }

    // Otherwise print the output
    console.log(result.output);

  } catch (err) {
    console.error(`\n  ${ember('!')} ${sage(err.message)}\n`);
    process.exit(1);
  }
}

module.exports = main;
