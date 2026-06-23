// Tests for the first-impression intro sequence.

const { test } = require('node:test');
const assert = require('node:assert');
const { playIntro, farewell, LOGO, FACE, SHH } = require('../lib/intro');

function capture() {
  const lines = [];
  return { out: (s = '') => lines.push(s), lines, text: () => lines.join('\n') };
}

const fakeHarnesses = (installed) => () => installed;

test('intro renders mark, promise, logo, and next step', async () => {
  const c = capture();
  await playIntro({
    animated: false,
    out: c.out,
    listHarnesses: fakeHarnesses([
      { label: 'Claude Code', role: 'writes code', installed: true },
      { label: 'Codex', role: 'reasons & reviews', bestFor: 'reviews', installed: true },
    ]),
  });
  const t = c.text();
  for (const l of FACE) assert.ok(c.lines.some((x) => x.includes(l)), 'face row present');
  for (const l of LOGO) assert.ok(c.lines.some((x) => x.includes(l)), 'logo line present');
  assert.match(t, /one memory they share/);
  assert.match(t, /phewsh setup/);
});

test('found tools light up with their roles and a count', async () => {
  const c = capture();
  const res = await playIntro({
    animated: false,
    out: c.out,
    listHarnesses: fakeHarnesses([
      { label: 'Claude Code', role: 'writes code', installed: true },
      { label: 'Codex', role: 'reasons & reviews', installed: true },
      { label: 'Gemini', role: "another model's take", installed: true },
      { label: 'NotInstalled', role: 'x', installed: false },
    ]),
  });
  assert.equal(res.toolsFound, 3); // only installed
  const t = c.text();
  assert.match(t, /Claude Code/);
  assert.match(t, /reviews/);
  assert.match(t, /Found 3 tools/);
});

test('no tools found shows the install nudge, not a fake count', async () => {
  const c = capture();
  const res = await playIntro({ animated: false, out: c.out, listHarnesses: fakeHarnesses([]) });
  assert.equal(res.toolsFound, 0);
  assert.match(c.text(), /none found yet/);
  assert.match(c.text(), /phewsh setup/);
  assert.ok(!/just type to start/.test(c.text()));
  assert.ok(!/Found 0 tools/.test(c.text()));
});

test('a thrown harness lookup degrades gracefully (no tools)', async () => {
  const c = capture();
  const res = await playIntro({ animated: false, out: c.out, listHarnesses: () => { throw new Error('boom'); } });
  assert.equal(res.toolsFound, 0);
  assert.match(c.text(), /none found yet/);
});

test('farewell renders the shush mark', () => {
  const c = capture();
  farewell({ out: c.out });
  for (const l of SHH) assert.ok(c.lines.some((x) => x.includes(l)), 'shh row present');
});

test('animated mode awaits the injected delay', async () => {
  const c = capture();
  let waits = 0;
  await playIntro({ animated: true, delay: async () => { waits++; }, out: c.out, listHarnesses: fakeHarnesses([{ label: 'Codex', role: 'x', installed: true }]) });
  assert.ok(waits > 0, 'delay was awaited in animated mode');
});
