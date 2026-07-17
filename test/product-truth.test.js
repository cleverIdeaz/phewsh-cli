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
  assert.match(narrativeNext, /Active now \(Jul 16, 2026\)/);
  assert.match(narrativeNext, /Everything below is historical forward narrative/);
  assert.match(read('.intent/status.md'), /## Archive \(historical journal\)/);

  // Hero (Jul 17): cross-provider continuity promise → five durable concepts →
  // product map → handoff proof. Delivery detail (.intent/, Ion, connectors) moved
  // below the hero, per the Jul 17 messaging pass.
  const hero = homepage.indexOf('Your project remembers, even when you switch tools.');
  const fiveConcepts = homepage.indexOf('Stop being the copy-and-paste layer');
  const portableTruth = homepage.indexOf('folder you own');
  const productMap = homepage.indexOf('Start with intent. Connect your tools.');
  const boundedProof = homepage.indexOf('Carry forward what was recorded.');
  assert.ok(hero >= 0 && fiveConcepts > hero && productMap > fiveConcepts && boundedProof > productMap,
    'homepage should lead from the continuity promise to the five durable concepts to product map to handoff proof');
  assert.ok(portableTruth > hero,
    'the page should still name the portable project-owned .intent/ mechanism (now as delivery, below the hero)');
  assert.match(homepage, /One project\. Any AI\./);
  assert.match(homepage, /Phewsh keeps your goals, decisions, current work, evidence, and handoffs in one portable project record/);
  assert.match(homepage, /Provider-neutral &middot; User-owned &middot; Evidence-backed/);
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
  assert.match(homepage, /Pull it to your terminal only when you choose/);
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
  assert.equal(active.id, 'cross-harness-excellence');
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
