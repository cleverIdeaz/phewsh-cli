const test = require('node:test');
const assert = require('node:assert/strict');
const { inlineMd, renderLine, streamRenderer } = require('../lib/md');

const ESC = '\x1b';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('inlineMd resolves bold, italic, code, links to ANSI — no literal markers', () => {
  const out = inlineMd('a **bold** and *em* and `code` and [link](https://x.io)', '');
  assert.ok(out.includes(ESC), 'emits ANSI');
  const plain = stripAnsi(out);
  assert.ok(!plain.includes('**'), 'no literal **');
  assert.ok(!plain.includes('`'), 'no literal backtick');
  assert.ok(plain.includes('bold') && plain.includes('em') && plain.includes('code'));
  assert.ok(plain.includes('link') && plain.includes('https://x.io'), 'link text + url kept');
});

test('renderLine styles headers, bullets, numbered, quotes, dividers', () => {
  const st = {};
  assert.ok(stripAnsi(renderLine('## Heading', st)).includes('Heading'));
  assert.equal(stripAnsi(renderLine('- item', st)).trim().startsWith('·'), true);
  assert.ok(stripAnsi(renderLine('1. first', st)).includes('1. first'));
  assert.ok(stripAnsi(renderLine('> quoted', st)).includes('quoted'));
  assert.ok(renderLine('---', st).includes('─'));
  assert.equal(renderLine('', st), '');
});

test('code fences carry state across lines and render literally', () => {
  const st = {};
  renderLine('```js', st);
  assert.equal(st.inFence, true, 'fence opens');
  const code = renderLine('const x = `tmpl`;', st);
  assert.ok(stripAnsi(code).includes('`tmpl`'), 'inline md NOT applied inside a fence');
  renderLine('```', st);
  assert.equal(st.inFence, false, 'fence closes');
});

test('streamRenderer is line-buffered: holds a partial line until newline', () => {
  let out = '';
  const r = streamRenderer((s) => { out += s; });
  r.push('hello wor');          // no newline yet
  assert.equal(out, '', 'nothing emitted before the line completes');
  r.push('ld\n');               // line completes
  assert.ok(out.length > 0 && out.endsWith('\n'), 'completed line is emitted');
  assert.ok(stripAnsi(out).includes('hello world'));
});

test('streamRenderer.flush emits the trailing line that never got a newline', () => {
  let out = '';
  const r = streamRenderer((s) => { out += s; });
  r.push('no trailing newline here');
  assert.equal(out, '');
  r.flush();
  assert.ok(stripAnsi(out).includes('no trailing newline here'));
});

test('streamRenderer survives token-by-token markdown with no literal markers', () => {
  let out = '';
  const r = streamRenderer((s) => { out += s; });
  const reply = 'The **plan**:\n- step `one`\n- step *two*\n';
  for (const ch of reply) r.push(ch);
  r.flush();
  const plain = stripAnsi(out);
  assert.ok(!plain.includes('**') && !plain.includes('`'), 'markers resolved');
  assert.ok(plain.includes('plan') && plain.includes('step one') && plain.includes('step two'));
});
