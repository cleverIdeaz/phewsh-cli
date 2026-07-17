// The first impression. A staggered, terminal-safe reveal: the mark, the
// promise, then the magic moment — phewsh scans the machine and your installed
// AI tools light up one by one. That last beat IS the value prop: "it already
// works with everything you have."
//
// Safe by construction: line-by-line printing only, no cursor-up rewrites
// (Apple Terminal hazard). Non-TTY / piped → everything prints instantly.
// Timing + harness list + output are injectable so the sequence is testable.

const ui = require('./ui');

// The exhale mark (😮‍💨) — rasterized from assets/phew.svg to a 30×14 grid
// once, baked here so there's no runtime cost. It draws in row by row.
const FACE = [
  '          ███ ██ ███',
  '      █                █',
  '    █                    █',
  '  █        █      █        █',
  ' █      ██          ██      █',
  '█           █    █           █',
  '█     █████        █████     █',
  '█                            █',
  '█                            █',
  ' █  ██  ██   █  █           █',
  '  ██        █    █         █',
  '  █        █  ██         █',
  '   ███  ███            █',
  '          ███    ███',
];

// The shush mark (🤫) — rasterized from assets/shh.svg, same 30×14 grid.
// Bookends the session: phew opens it, shh signs off.
const SHH = [
  '         ██       ███',
  '     ██                █',
  '   █                      █',
  '  █      ███      ███      █',
  ' █                          █',
  '█             ██             █',
  '█            █  █            █',
  '█               █            █',
  '           █     █',
  ' █      █ █                 █',
  '   █     █ ██  █   █      █',
  '     █    █         █   █',
  '        ██  █       ██',
  '              ██   █',
];

const LOGO = ['█▀█ █░█ █▀▀ █░█░█ █▀ █░█', '█▀▀ █▀█ ██▄ ▀▄▀▄▀ ▄█ █▀█'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function playIntro(opts = {}) {
  const {
    animated = !!process.stdout.isTTY,
    delay = sleep,
    out = console.log,
    listHarnesses = require('./harnesses').listHarnesses,
    scanProjects = require('./projects-index').scanForProjects,
    scanCandidates = require('./projects-index').scanForCandidates,
  } = opts;

  const { b, cream, sage, slate, teal, green } = ui;
  const pause = async (ms) => { if (animated) await delay(ms); };

  out('');
  for (const line of FACE) { out(`  ${cream(line)}`); await pause(55); }
  await pause(160);
  out('');
  for (const line of LOGO) { out(`  ${b(cream(line))}`); await pause(90); }
  await pause(140);
  out(`  ${sage('Keep all your AI tools.')} ${cream('phewsh briefs them from one .intent/ folder you own.')}`);
  out('');
  await pause(260);

  // The magic beat: discover the tools already on this machine.
  out(`  ${slate('scanning your machine for AI tools…')}`);
  await pause(320);

  let harnesses = [];
  try { harnesses = listHarnesses().filter((h) => h.installed); } catch { /* none */ }

  if (harnesses.length === 0) {
    out(`  ${slate('· none found yet — install Claude Code, Codex, or Gemini and phewsh picks it up.')}`);
  } else {
    for (const h of harnesses) {
      out(`    ${green('✓')} ${cream(h.label.padEnd(14))} ${sage(h.bestFor || h.role || '')}`);
      await pause(130);
    }
    await pause(160);
    out('');
    const n = harnesses.length;
    out(`  ${teal('●')} ${sage(`Found ${n} tool${n !== 1 ? 's' : ''} — available through removable native adapters.`)}`);
  }
  out('');
  await pause(160);

  // Second beat: the tools can read the same project-owned truth — so show the projects.
  // Shallow scan of the usual folders only (same rules as /scan): existing
  // .intent/ projects, plus likely candidates (git repos with no .intent yet).
  let projects = [];
  let candidates = [];
  try { projects = scanProjects(); } catch { /* none */ }
  try { candidates = scanCandidates(); } catch { /* none */ }
  if (projects.length > 0 || candidates.length > 0) {
    const bits = [];
    if (projects.length > 0) bits.push(`${projects.length} project${projects.length !== 1 ? 's' : ''} already have shared truth (.intent/)`);
    if (candidates.length > 0) bits.push(`${candidates.length} likely candidate${candidates.length !== 1 ? 's' : ''} (git, no .intent yet)`);
    out(`  ${teal('●')} ${sage(bits.join(' · '))}`);
    out(`  ${slate('run phewsh inside one — or pick from the list when the session opens.')}`);
    out('');
    await pause(160);
  }

  if (harnesses.length > 0) {
    out(`  ${sage('Adapters stay off until you choose.')} ${cream('phewsh ambient on')} ${slate('previews exact files and asks first.')}`);
    out(`  ${sage('Next:')} ${cream('just type to start')} ${slate('·')} ${cream('phewsh setup')} ${slate('to pick a default route')}`);
  } else {
    out(`  ${sage('Next:')} ${cream('phewsh setup')} ${slate('after installing Claude Code, Codex, or Gemini')}`);
  }
  out('');

  return { toolsFound: harnesses.length, projectsFound: projects.length, candidatesFound: candidates.length };
}

// Quiet sign-off — the shush mark, printed static (no animation; exit is instant).
function farewell(opts = {}) {
  const { out = console.log } = opts;
  const { slate } = ui;
  out('');
  for (const line of SHH) out(`  ${slate(line)}`);
  out('');
}

module.exports = { playIntro, farewell, LOGO, FACE, SHH };
