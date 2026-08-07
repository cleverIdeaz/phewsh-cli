const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('canonical Project truth and the homepage teach one cross-harness product', () => {
  const vision = read('.intent/vision.md');
  const plan = read('.intent/plan.md');
  const narrativeNext = read('.intent/next.md');
  const project = JSON.parse(read('.intent/project.json'));
  const homepage = read('index.html');

  assert.match(vision, /user-owned continuity and collaboration layer above AI tools/i);
  assert.match(vision, /Project · Next · Work · Record/);
  assert.match(vision, /`phewsh init` creates the project-owned `.intent\/` directory/);
  for (const adapter of ['skills', 'hooks', 'projections', 'MCP', 'packs', 'connectors']) {
    assert.match(vision, new RegExp(adapter, 'i'));
  }
  assert.match(project.tldr, /User-owned project truth across AI tools/);
  assert.doesNotMatch(plan, /interchangeable harnesses/i);
  assert.doesNotMatch(read('.intent/project.json'), /interchangeable harnesses/i);
  assert.match(project.decisionGate.goal, /cross-harness continuity and collaboration layer/i);
  assert.match(plan, /Current Strategy \(Jul 15, 2026\)/);
  assert.match(plan, /Archived Strategy \(May 6, 2026 — superseded/);
  assert.match(narrativeNext, /Active now \(Jul 19, 2026\)/);
  assert.match(narrativeNext, /Everything below is historical forward narrative/);
  assert.match(read('.intent/status.md'), /## Archive \(historical journal\)/);

  // Hero: cross-provider continuity promise → five durable concepts → product
  // map → handoff proof. Ion and connector detail stay below.
  //
  // The first viewport deliberately does NOT name the mechanism. The Aug 4
  // rescue made the opening screen promise + install command + GET CENTERED,
  // because the converting action had become unreachable; adding `.intent/`
  // there would compete with it. The mechanism is still taught — the guard is
  // that it lands after the promise and BEFORE the product map, so a reader
  // meets the owned folder before they are asked to pick a door.
  const hero = homepage.indexOf('Your project remembers, even when you switch tools.');
  const fiveConcepts = homepage.indexOf('Stop being the copy-and-paste layer');
  const portableTruth = homepage.indexOf('folder you own');
  const productMap = homepage.indexOf('Start with intent. Connect your tools.');
  const boundedProof = homepage.indexOf('Carry forward what was recorded.');
  assert.ok(hero >= 0 && fiveConcepts > hero && productMap > fiveConcepts && boundedProof > productMap,
    'homepage should lead from the continuity promise to the five durable concepts to product map to handoff proof');
  assert.ok(portableTruth > hero && portableTruth < productMap,
    'the page must name the portable project-owned .intent/ mechanism after the promise and before the product map');
  assert.match(homepage, /One project\. Any AI\./);
  // The "No shared model memory · Provider-neutral · User-owned · Evidence-backed"
  // badge row was removed in the Aug 4 rescue, but the claim it protected did not
  // weaken — it is now stated outright in prose, which is the stronger guard. The
  // audience line and the "one portable record" summary went with it; the five
  // durable concepts below already assert that content, so no property is lost.
  assert.match(homepage, /does not pretend one vendor can transfer another model&rsquo;s memory/);
  for (const concept of ['Intent', 'Current work', 'Decisions', 'Evidence', 'Handoffs']) {
    assert.ok(homepage.includes('>' + concept + '</div>'), `five-concepts section names ${concept}`);
  }
  // Honest delivery boundary preserved; connectors labeled preview (truth constraint).
  assert.match(homepage, /including the prior tool&rsquo;s transcript/);
  assert.match(homepage, /syncing to Phewsh Cloud is optional/);
  assert.match(homepage, /developer preview/i);
  assert.doesNotMatch(homepage, /ChatGPT and Claude connectors are available|connectors available now/i);
  assert.match(homepage, /One project truth across AI tools/);
  assert.match(homepage, /supported AI tools start from the same project truth/);
  assert.match(homepage, /lists what did not move/);
  // "Pull it to your terminal only when you choose" was dropped; the user-control
  // property it guarded is the optional-sync line already asserted above.
  assert.match(homepage, /when you hand off, the next AI gets recorded project state and an explicit loss list/);
  assert.doesNotMatch(homepage, /it syncs to your terminal|starts grounded, automatically|decisions and outcomes were recorded|every AI tool starts from the same page|briefs every AI harness|Every handoff shows/i);
  assert.match(homepage, /Project truth lives in versioned <code>\.intent\/<\/code> files/);
  assert.match(homepage, /Open skills and native hooks adapt each tool around the same project/);
});

test('structured Next uses only now, next, and done and carries the active goal', () => {
  const next = JSON.parse(read('.intent/next.json'));
  const allowed = new Set(['now', 'next', 'done']);
  assert.equal(next.items.filter((item) => item.state === 'now').length, 1);
  assert.ok(next.items.every((item) => allowed.has(item.state)));
  const active = next.items.find((item) => item.state === 'now');
  assert.equal(active.id, 'ion-daily-driver-miramora');
  // The active goal must always carry a human-verified gate, so no agent can
  // declare the whole goal done on its own.
  assert.ok(active.criteria.some((criterion) => criterion.type === 'human' && /Two real accounts/.test(criterion.expected)));
});

test('current native harness projections carry the same canonical product truth', () => {
  const status = read('.intent/status.md');
  const focus = status.match(/\*\*Current Focus:\*\*\s*\n- \*\*(.+?)\*\*/)?.[1];
  assert.ok(focus, 'status.md must declare a current focus headline');
  for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']) {
    const projection = read(file);
    assert.match(projection, /User-owned project truth across AI tools/);
    assert.ok(projection.includes(focus), `${file} must carry the current status focus`);
    assert.match(projection, /<!-- PHEWSH:START -->/);
    assert.match(projection, /<!-- PHEWSH:END -->/);
    assert.doesNotMatch(projection, /BOAT-LOOP WEEK COMPLETE/);
  }
});
