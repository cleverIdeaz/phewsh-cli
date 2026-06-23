// phewsh work — the read-only view of the fourth word
// (Project · Next · Work · Record). One glance: what are we building, what's
// next, what's happening now, what did we last decide, does anything need you?
//
// Read-only on purpose. It makes Work *visible*, not powerful — the loop/queue
// machinery is deliberately NOT here (see .intent/work-layer.md).

const work = require('../lib/work');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const teal = (s) => `\x1b[38;5;79m${s}\x1b[0m`;
const sage = (s) => `\x1b[38;5;151m${s}\x1b[0m`;
const slate = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const cream = (s) => `\x1b[38;5;230m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const peach = (s) => `\x1b[38;5;216m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function trunc(s, n = 88) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function main() {
  const v = work.workView();
  console.log('');
  console.log(`  ${b('😮‍💨 PHEWSH WORK')} ${slate('· ' + v.project.name)}`);
  console.log('');

  // Project — what we're building
  console.log(`  ${cream('Project')}`);
  if (v.project.present) {
    console.log(`    ${sage(v.project.name)}${v.project.tagline ? slate(' — ' + trunc(v.project.tagline, 70)) : ''}`);
  } else {
    console.log(`    ${slate('no .intent/ here yet — ')}${cream('phewsh intent --init')}`);
  }

  // Next — what should happen next
  console.log(`  ${cream('Next')}`);
  if (v.next.now) {
    console.log(`    ${green('Now:')} ${sage(trunc(v.next.now))}`);
  } else if (v.next.topQueued) {
    console.log(`    ${slate('Up next (not started):')} ${sage(trunc(v.next.topQueued))}  ${slate('· phewsh next start 1')}`);
  } else {
    console.log(`    ${slate('nothing queued — ')}${cream('phewsh next add "…"')}`);
  }

  // Work — what's being done now
  console.log(`  ${cream('Work')}`);
  if (v.work.tool) {
    console.log(`    ${slate('Tool:')} ${sage(v.work.tool)}`);
    console.log(`    ${slate('Status:')} ${v.work.active ? green('active session') : slate('last ' + v.work.lastAgo)}`);
  } else {
    console.log(`    ${slate('no active run detected')}`);
  }

  // Record — what we last decided / learned
  console.log(`  ${cream('Record')}`);
  if (v.record.latest) {
    console.log(`    ${slate('Latest:')} ${sage(trunc(v.record.latest))}`);
  } else {
    console.log(`    ${slate('nothing recorded yet — ')}${cream('phewsh remember "…"')}`);
  }

  // Verify — the started item's success criteria, checked against evidence
  if (v.verification) {
    const VSYM = { pass: green('✓'), partial: yellow('~'), fail: red('✗'), unknown: slate('?'), human: peach('◇'), proposed: slate('○') };
    const s = v.verification.summary;
    const bits = ['pass', 'partial', 'fail', 'unknown', 'human', 'proposed']
      .filter(k => s[k]).map(k => `${s[k]} ${k}`);
    console.log(`  ${cream('Verify')} ${slate('— ' + bits.join(' · '))}`);
    v.verification.results.forEach(r => console.log(`    ${VSYM[r.status] || slate('·')} ${slate(trunc(r.expected, 64) + ' · ' + r.note)}`));
  }

  // Review — does anything need a human?
  console.log(`  ${cream('Review')}`);
  if (v.review.clear && !(v.verification && (v.verification.summary.fail || v.verification.summary.human || v.verification.summary.proposed))) {
    console.log(`    ${green('✓')} ${sage('Nothing needs human review right now')}`);
  } else {
    v.review.needs.forEach(n => console.log(`    ${peach('⚠')} ${sage(n)}`));
    if (v.verification && v.verification.summary.fail) console.log(`    ${red('✗')} ${sage(v.verification.summary.fail + ' criterion(s) failed — see Verify above')}`);
    if (v.verification && (v.verification.summary.human || v.verification.summary.proposed)) console.log(`    ${peach('◇')} ${sage('criteria need your judgment / acceptance')}`);
  }

  console.log('');
}

module.exports = main;
