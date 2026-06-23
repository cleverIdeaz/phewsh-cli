// phewsh outcomes — the accumulated record of decisions and what became of them.
//
//   phewsh outcomes                  Stats + recent decisions
//   phewsh outcomes label            Interactively label pending decisions
//   phewsh outcomes label <id> <o>   Label one decision directly

const readline = require('readline');
const ui = require('../lib/ui');
const {
  OUTCOMES, recordDecision, labelOutcome,
  pendingDecisions, recentDecisions, outcomeStats, bypassStats,
} = require('../lib/outcomes');
const learning = require('../lib/learning');
const continuity = require('../lib/continuity');

const { b, teal, peach, sage, slate, cream, ember, green } = ui;

const OUTCOME_COLOR = {
  kept: green, reverted: ember, superseded: peach, failed: ember,
};

function fmtAgo(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// Pad the raw word before coloring — ANSI codes break padEnd's width math
function outcomeBadge(d, width = 10) {
  if (!d.outcome) return slate('pending'.padEnd(width));
  return OUTCOME_COLOR[d.outcome](d.outcome.padEnd(width));
}

function showBypasses() {
  const bypasses = bypassStats();
  if (bypasses.total === 0) return;
  console.log('');
  console.log(`  ${b(cream('Bypasses'))} ${slate('— why the front door got skipped')}`);
  for (const [reason, count] of Object.entries(bypasses.byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cream(String(count).padStart(3))}  ${sage(reason)}`);
  }
}

// Plain-language explanation of the contract — shown every time, because the
// #1 complaint was "I have no idea what this is for or how to use it."
function explainDeal() {
  console.log(`  ${b(cream('Outcomes'))} ${slate('— phewsh\'s memory of what actually worked')}`);
  ui.divider('line');
  console.log(`  ${sage('Every call you route, phewsh logs. Tell it what you')} ${green('kept')} ${sage('vs')} ${ember('threw out')}${sage(',')}`);
  console.log(`  ${sage('and it learns which tool to trust for which job — and warns you before')}`);
  console.log(`  ${sage('you repeat something that flopped.')} ${slate('That labeled record is the one thing')}`);
  console.log(`  ${slate('your chat history doesn\'t have. Two taps now = smarter routing later.')}`);
}

// The payoff, in their own data — so labeling feels like it buys something.
function showPayoff(stats) {
  const lines = [];
  try {
    const best = learning.bestRoute(stats, { minSample: 2 });
    if (best && best.keptRate >= 0.5) {
      const label = continuity.labelFor(best.route) || best.route;
      lines.push(`${green('●')} ${sage(label + ' keeps best for you — ')}${cream(Math.round(best.keptRate * 100) + '%')} ${sage(`(${best.kept}/${best.total}). phewsh leans there when it routes.`)}`);
    }
  } catch { /* best-effort */ }
  const regrets = stats.reverted + stats.failed;
  if (regrets > 0) {
    lines.push(`${ember('●')} ${sage((regrets === 1 ? '1 call you marked a miss is' : regrets + ' calls you marked misses are') + ' remembered — ')}${cream('/recall')} ${sage('warns you before a repeat.')}`);
  }
  if (lines.length === 0) return;
  console.log('');
  console.log(`  ${b(cream('What it already knows'))} ${slate('← this is the payoff')}`);
  for (const l of lines) console.log(`    ${l}`);
  if (stats.judged < 4) console.log(`    ${slate('judge a few more and clearer patterns surface here.')}`);
}

function showStats() {
  const stats = outcomeStats();

  console.log('');
  explainDeal();

  if (stats.total === 0) {
    console.log('');
    console.log(`  ${sage('Nothing logged yet — start routing work and it fills in.')}`);
    console.log(`  ${slate('In a session: just type, or use /use <tool>. Then tap 1-4 to judge it.')}`);
    showBypasses();
    console.log('');
    return;
  }

  // The state of the record, in plain numbers that don't lie.
  console.log('');
  console.log(`  ${b(cream('Your record'))}`);
  console.log(`    ${cream(String(stats.total))} ${sage('routed')} ${slate('·')} ${cream(String(stats.judged))} ${sage('you\'ve judged')} ${slate('·')} ${cream(String(stats.pending))} ${sage('not yet judged')}`);
  if (stats.judged > 0) {
    const bits = [green(`✓ ${stats.kept} kept`)];
    if (stats.reverted) bits.push(ember(`↩ ${stats.reverted} reverted`));
    if (stats.superseded) bits.push(peach(`⟳ ${stats.superseded} redone`));
    if (stats.failed) bits.push(ember(`✗ ${stats.failed} flopped`));
    console.log(`    ${bits.join(slate(' · '))}`);
  }
  if (stats.autoFailed > 0) {
    console.log(`    ${slate(`(${stats.autoFailed} didn't complete — route errors phewsh logged for you, not your call)`)}`);
  }

  showPayoff(stats);

  // The ask — focused on recent, real calls, with a dead-simple next step.
  const pending = pendingDecisions({ substantive: true }).slice(-6).reverse();
  if (pending.length > 0) {
    console.log('');
    console.log(`  ${b(cream('Give a verdict'))} ${slate('— your recent calls (skip the trivial ones)')}`);
    pending.forEach((d, i) => {
      let s = (d.summary || '').replace(/\s+/g, ' ');
      if (s.length > 44) s = s.slice(0, 43).trimEnd() + '…';
      const via = (continuity.labelFor(d.route) || d.route).padEnd(12);
      console.log(`    ${teal(String(i + 1))} ${cream(s.padEnd(45))} ${slate(via)} ${slate(fmtAgo(d.ts))}`);
    });
    console.log('');
    console.log(`  ${teal('→')} ${sage('Walk through them:')} ${cream('phewsh outcomes label')} ${slate('· 20 seconds, Enter skips')}`);
    console.log(`    ${slate('or in a session, just tap')} ${cream('1-4')} ${slate('right after any answer.')}`);
  }

  showBypasses();
  console.log('');
}

function labelInteractive() {
  // Newest first, and capped — you judge best while the work is fresh, and a
  // 76-item slog through last week's test prompts is exactly the chore that
  // made this feel pointless. The recent calls carry the signal.
  const CAP = 12;
  const all = pendingDecisions({ substantive: true }).reverse(); // newest first
  const pending = all.slice(0, CAP);
  if (pending.length === 0) {
    console.log(`\n  ${teal('●')} ${sage('Nothing substantive to judge — your real calls are all labeled.')}\n`);
    return;
  }

  console.log('');
  const more = all.length > CAP ? slate(` (most recent ${CAP}; ${all.length - CAP} older left alone)`) : '';
  console.log(`  ${b(cream(`Judging your recent call${pending.length !== 1 ? 's' : ''}`))}${more}`);
  console.log(`  ${slate('For each: what happened to it?')}`);
  console.log(`  ${green('1')} ${sage('kept it')}   ${ember('2')} ${sage('undid it')}   ${peach('3')} ${sage('redid it differently')}   ${ember('4')} ${sage('it flopped')}`);
  console.log(`  ${slate('Enter = skip (judge later) · q = stop. This is what teaches phewsh.')}`);
  ui.divider('line');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let i = 0;

  const next = () => {
    if (i >= pending.length) {
      rl.close();
      console.log(`\n  ${teal('●')} ${sage('Done.')}\n`);
      return;
    }
    const d = pending[i];
    console.log('');
    console.log(`  ${slate(d.id)} ${sage(fmtAgo(d.ts) + ' ago')} ${slate('·')} ${cream(d.route)} ${slate('·')} ${sage(d.project)}`);
    console.log(`  ${cream(d.summary)}`);
    rl.question(`  ${teal('>')} `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === 'q') {
        rl.close();
        console.log(`\n  ${sage('Stopped — the rest stay pending.')}\n`);
        return;
      }
      const idx = parseInt(a, 10);
      if (idx >= 1 && idx <= 4) {
        const outcome = OUTCOMES[idx - 1];
        // A miss is only useful if phewsh learns WHY — that one line is what
        // /recall surfaces before you repeat it. Match the inline flow.
        if (outcome === 'reverted' || outcome === 'failed') {
          console.log(`  ${teal('●')} ${OUTCOME_COLOR[outcome](outcome)}`);
          rl.question(`  ${slate('why? (one line — Enter to skip)')} ${teal('>')} `, (why) => {
            labelOutcome(d.id, outcome, why.trim() || null);
            if (why.trim()) console.log(`  ${slate('noted — /recall will remember why.')}`);
            i++;
            next();
          });
          return;
        }
        labelOutcome(d.id, outcome);
        console.log(`  ${teal('●')} ${OUTCOME_COLOR[outcome](outcome)}`);
      }
      i++;
      next();
    });
  };
  next();
}

module.exports = function outcomes() {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (sub === 'label') {
    const id = args[1];
    const outcome = args[2];
    if (id && outcome) {
      try {
        const d = labelOutcome(id, outcome);
        if (d) console.log(`\n  ${teal('●')} ${sage('Labeled')} ${cream(d.summary.slice(0, 50))} ${slate('→')} ${OUTCOME_COLOR[outcome](outcome)}\n`);
        else console.log(`\n  ${ember('!')} ${sage('No unique decision matching')} ${cream(id)}\n`);
      } catch (err) {
        console.log(`\n  ${ember('!')} ${sage(err.message)}\n`);
      }
      return;
    }
    labelInteractive();
    return;
  }

  showStats();
};
