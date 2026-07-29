// phewsh receipts — The proof trail for AI work.
//
// Every claim an agent makes leaves evidence in ~/.phewsh/:
//   sessions/   what happened, when, by which agent (events)
//   results/    task completions + flagged blockers (full records)
//   handoffs/   what portable truth crossed tools, and what did not
//   spend/      what it cost, per model, per day
//   bridge/     web↔CLI dispatch jobs and their outcomes
//
// This command merges them into one timeline so "the agent did X" is never
// just a claim — there's a receipt, with a file you can open.
//
// Usage:
//   phewsh receipts                    Last 20 events across all projects
//   phewsh receipts --project local    Filter to one project
//   phewsh receipts --limit 50         More history
//   phewsh receipts --json             Machine-readable (for web/agents)
//   phewsh receipts <receipt-id>       One run receipt in full

const { gatherReceipts, readRunReceipt } = require('../lib/receipts-data');

// House palette (matches bin/phewsh.js / feedback: bright enough for dark terminals)
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const d = (s) => `\x1b[2m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const g = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderEvent(e) {
  const time = (e.ts || '').replace('T', ' ').slice(0, 16);
  const who = e.agent && e.agent !== 'anonymous' ? ` ${cyan(e.agent)}` : '';
  const proj = e.project ? g(` [${e.project}]`) : '';

  let icon;
  let line;
  switch (e.kind) {
    case 'session_start':
      icon = g('○'); line = g('session opened'); break;
    case 'task_complete':
      icon = e.data.success === false ? yellow('!') : green('✓');
      line = `${w(e.data.taskId || 'task')} ${g('—')} ${(e.data.result || '').slice(0, 70)}`;
      break;
    case 'result_record':
      icon = e.data.success === false ? yellow('!') : green('✓');
      line = `${w(e.data.taskId || 'task')} ${g('—')} ${(e.data.result || '').slice(0, 70)}`;
      break;
    case 'action_evaluated': {
      const s = e.data.status;
      icon = s === 'block' ? red('✕') : s === 'modify' ? yellow('~') : green('✓');
      line = `${g('gate')} ${s ? w(s) : ''} ${g('—')} ${(e.data.proposedAction || '').slice(0, 60)}`;
      break;
    }
    case 'blocker_flagged':
    case 'blocker_record':
      icon = red('⚠'); line = `${w('blocked')} ${g('—')} ${(e.data.reason || '').slice(0, 70)}`;
      break;
    case 'dispatch_enqueued':
      icon = cyan('→'); line = `${g('dispatched from web —')} ${(e.data.taskSummary || '').slice(0, 60)}`;
      break;
    case 'handoff':
      icon = e.valid === false ? red('✕') : cyan('⇄');
      line = e.valid === false
        ? `${w(e.data.id || 'handoff')} ${red('— invalid integrity')}`
        : `${w(e.data.id || 'handoff')} ${g('—')} ${g((e.data.routes?.from || 'unknown') + ' → ' + (e.data.routes?.to || 'unselected'))} ${g('· ' + (e.data.carried?.intent?.length || 0) + ' truth file(s)')}`;
      break;
    case 'job_done':
      icon = green('✓'); line = `${g('web job —')} ${(e.data.result || '').slice(0, 70)}`;
      break;
    case 'job_error':
      icon = red('✕'); line = `${g('web job failed —')} ${(e.data.error || '').slice(0, 60)}`;
      break;
    case 'job_queued':
    case 'job_executing':
      icon = cyan('…'); line = g(`web job ${e.kind.slice(4)} — ${(e.data.packet?.objective?.task || '').slice(0, 55)}`);
      break;
    default:
      icon = g('·'); line = g(e.kind);
  }

  return `  ${d(time)}  ${icon} ${line}${who}${proj}`;
}

/** One run receipt, rendered exactly as stored — no extra claims. */
function printRunReceipt(r) {
  const line = (label, value) => console.log(`  ${g(label.padEnd(14))} ${value}`);
  const changed = [
    ...r.changes.created.map((p) => green(`+${p}`)),
    ...r.changes.modified.map((p) => yellow(`~${p}`)),
    ...r.changes.deleted.map((p) => red(`-${p}`)),
  ];
  console.log('');
  console.log(`  ${b(w('Receipt'))} ${w(r.receiptId)} ${g(`(${r.schema} v${r.version})`)}`);
  console.log('');
  line('Ran', `${w(r.runtimeLabel)} ${g('in')} ${w(r.projectId)} ${g(r.boundProjectId || '')}`);
  line('Status', r.status === 'done' ? green(r.status) : yellow(r.status) + (r.partial ? red(' · partial') : ''));
  line('When', `${g(r.startedAt)} ${g(`(${r.durationMs ?? '?'}ms)`)}`);
  if (r.contract?.action) line('Action', r.contract.action);
  line('Changed', changed.length ? changed.join(g(', ')) : g('nothing'));
  if (r.changes.preExisting.length) {
    line('Already dirty', g(`${r.changes.preExisting.length} path(s) — not this run's work`));
  }
  line('Checks', yellow(r.checks.reason));
  line('Cost', g(r.cost.reason));
  line('Output', g(`${r.output.bytes} bytes${r.output.sha256 ? ` · sha256 ${r.output.sha256.slice(0, 12)}…` : ''}`));
  line('Ceiling', yellow(r.verificationCeiling));
  line('Integrity', r.integrity === 'intact'
    ? green('intact — matches the hash recorded when it was written')
    : r.integrity === 'altered'
      ? red('ALTERED since Phewsh wrote it — do not treat this as evidence')
      : g('no hash was recorded for this receipt'));
  console.log('');
  console.log(`  ${g('Unknown:')}`);
  for (const u of r.unknowns) console.log(`    ${g('·')} ${g(u)}`);
  console.log(`  ${g('Not carried:')}`);
  for (const n of r.notCarried) console.log(`    ${g('·')} ${g(n)}`);
  console.log('');
  console.log(`  ${g('Evidence:')} ${w(`~/.phewsh/${r.evidence.receiptFile}`)}`);
  console.log(`  ${g('This is evidence, not accepted project truth. Accept it in Ion to reach the Record.')}`);
  console.log('');
}

async function main() {
  const args = process.argv.slice(3);
  const json = args.includes('--json');
  const projIdx = args.indexOf('--project');
  const projectFilter = projIdx >= 0 ? args[projIdx + 1] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 20 : 20;

  // One full run receipt. Same file Ion renders, so the two surfaces cannot
  // tell different stories about the same run.
  const receiptId = args.find((a) => /^r-[a-f0-9]+$/i.test(a));
  if (receiptId) {
    const receipt = readRunReceipt(receiptId);
    if (!receipt) {
      console.log(`\n  ${g('No receipt')} ${w(receiptId)} ${g('on this machine.')}\n`);
      process.exitCode = 1;
      return;
    }
    if (json) { console.log(JSON.stringify(receipt, null, 2)); return; }
    printRunReceipt(receipt);
    return;
  }

  const { summary, events: shown } = gatherReceipts({ project: projectFilter, limit });
  const counts = summary;
  const spend = summary.spend;
  const totalEvents = summary.totalEvents;

  if (json) {
    console.log(JSON.stringify({
      summary,
      events: shown.map(e => ({ ts: e.ts, project: e.project, agent: e.agent, kind: e.kind, valid: e.valid, receipt: `~/.phewsh/${e.receipt}`, data: e.data })),
    }, null, 2));
    return;
  }

  console.log('');
  console.log(`  ${b(w('Receipts'))} ${g('— the proof trail for AI work on this machine')}`);
  console.log('');

  if (totalEvents === 0) {
    console.log(`  ${g('No receipts yet. They appear when you hand off or agents work through PHEWSH:')}`);
    console.log(`  ${g('•')} ${w('phewsh')} ${g('→ /work or /switch — carry verified truth into another native tool')}`);
    console.log(`  ${g('•')} ${w('phewsh mcp setup')} ${g('— connect Claude Code / Cursor to the coordination layer')}`);
    console.log(`  ${g('•')} ${w('phewsh mcp serve')} ${g('— let the web app dispatch work to your machine')}`);
    console.log('');
    return;
  }

  const parts = [];
  if (counts.completed) parts.push(green(`${counts.completed} completed`));
  if (counts.failed) parts.push(yellow(`${counts.failed} failed`));
  if (counts.blocked) parts.push(red(`${counts.blocked} blocked`));
  if (counts.gated) parts.push(`${counts.gated} gate checks`);
  if (counts.dispatched) parts.push(cyan(`${counts.dispatched} web dispatches`));
  if (counts.handoffs) parts.push(cyan(`${counts.handoffs} handoff${counts.handoffs === 1 ? '' : 's'}`));
  if (counts.invalidHandoffs) parts.push(red(`${counts.invalidHandoffs} invalid handoff${counts.invalidHandoffs === 1 ? '' : 's'}`));
  console.log(`  ${parts.join(g(' · '))}`);
  if (spend.days > 0) {
    console.log(`  ${g('spend:')} $${spend.today.toFixed(4)} today ${g('·')} $${spend.total.toFixed(4)} across ${spend.days} day${spend.days === 1 ? '' : 's'} ${g('(~/.phewsh/spend/)')}`);
  }
  console.log('');

  for (const e of shown) console.log(renderEvent(e));

  console.log('');
  if (totalEvents > shown.length) {
    console.log(`  ${g(`${totalEvents - shown.length} older — use --limit ${Math.min(totalEvents, 200)}`)}`);
  }
  console.log(`  ${g('Every line has a file behind it. Inspect:')} ${w('phewsh receipts --json')}`);
  console.log('');
}

module.exports = main;
