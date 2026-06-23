// phewsh bypass — record the moment you reached past phewsh.
//
// Every bypass is the most valuable data in the dogfood experiment: it
// directly identifies why the front door fails. Make it 10 seconds, no guilt.
//
//   phewsh bypass                 Quick picker
//   phewsh bypass 2               By number (1-7)
//   phewsh bypass faster          By name
//   phewsh bypass 7 "was on my phone"   Reason + note

const readline = require('readline');
const ui = require('../lib/ui');
const { BYPASS_REASONS, recordBypass, bypassStats } = require('../lib/outcomes');

const { b, teal, sage, slate, cream, ember } = ui;

const LABELS = {
  'forgot': 'Forgot phewsh existed in the moment',
  'faster': 'Direct was faster',
  'needed-editing': 'Needed interactive file editing',
  'needed-context': 'Needed that tool\'s own context/memory',
  'model-quality': 'Needed that model\'s quality',
  'phewsh-in-the-way': 'phewsh got in the way',
  'other': 'Something else',
};

function resolveReason(arg) {
  if (!arg) return null;
  const n = parseInt(arg, 10);
  if (n >= 1 && n <= BYPASS_REASONS.length) return BYPASS_REASONS[n - 1];
  const match = BYPASS_REASONS.find(r => r === arg || r.startsWith(arg));
  return match || null;
}

function confirm(reason, count) {
  console.log(`\n  ${teal('●')} ${sage('Bypass recorded:')} ${cream(LABELS[reason])}`);
  console.log(`  ${slate(`${count} total — no guilt, this is the experiment working. phewsh outcomes shows the pattern.`)}\n`);
}

module.exports = function bypass() {
  const args = process.argv.slice(3);

  if (args[0] === 'stats') {
    const stats = bypassStats();
    console.log('');
    console.log(`  ${b(cream('Bypasses'))} ${slate('— why the front door got skipped')}`);
    ui.divider('line');
    if (stats.total === 0) {
      console.log(`  ${sage('None recorded. When you catch yourself in Claude Code directly:')} ${cream('phewsh bypass')}`);
    } else {
      console.log(`  ${cream(String(stats.total))} ${sage('total')}`);
      for (const [reason, count] of Object.entries(stats.byReason).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${cream(String(count).padStart(3))}  ${sage(LABELS[reason])}`);
      }
    }
    console.log('');
    return;
  }

  const reason = resolveReason(args[0]);
  if (reason) {
    const note = args.slice(1).join(' ');
    confirm(reason, recordBypass(reason, note));
    return;
  }
  if (args[0]) {
    console.log(`\n  ${ember('!')} ${sage('Unknown reason. Pick 1-7 or:')} ${cream(BYPASS_REASONS.join(', '))}\n`);
    return;
  }

  console.log('');
  console.log(`  ${b(cream('You opened something directly instead of phewsh — why?'))}`);
  BYPASS_REASONS.forEach((r, i) => {
    console.log(`    ${teal(String(i + 1))} ${sage(LABELS[r])}`);
  });
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`  ${teal('>')} ${slate('1-7, enter = cancel: ')}`, (answer) => {
    rl.close();
    const picked = resolveReason(answer.trim());
    if (!picked) {
      console.log(`  ${slate('Cancelled.')}\n`);
      return;
    }
    confirm(picked, recordBypass(picked));
  });
};
