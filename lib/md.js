'use strict';

// Terminal markdown rendering, safe for line-buffered streaming.
//
// Each completed line is rendered on its own — no cursor movement, no
// in-place rewrites. That is deliberate: mid-stream cursor tricks under line
// wrapping are the exact Apple Terminal hazard that has bitten this project
// before. We hold tokens until a newline, render that finished line, and print
// it. The only block-level state carried across lines is the code-fence flag,
// so fenced code renders literally instead of as inline markdown.

const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  ital: '\x1b[3m', italOff: '\x1b[23m',
  uline: '\x1b[4m',
  cream: '\x1b[38;5;230m',  // bold emphasis
  teal: '\x1b[38;5;79m',    // code, links, headers
  sage: '\x1b[38;5;151m',   // list items
  slate: '\x1b[38;5;247m',  // dividers, quotes, link urls
};

// Inline spans: bold, italic, code, links. `base` is the SGR sequence to
// restore the line's colour after each span's reset, so the rest of the line
// keeps its block colour. Pass '' for default-foreground body text.
function inlineMd(t, base = '') {
  return t
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => `${A.bold}${A.cream}${x}${A.reset}${base}`)
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, (_, p, x) => `${p}${A.ital}${x}${A.italOff}${base}`)
    .replace(/`([^`]+)`/g, (_, x) => `${A.teal}${x}${A.reset}${base}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,
      (_, x, u) => `${A.uline}${A.teal}${x}${A.reset}${base} ${A.dim}${A.slate}(${u})${A.reset}${base}`);
}

// Soft-wrap a rendered line at word boundaries to the terminal width — this is
// what replaces the terminal's mid-word hard wrap (CSS `text-wrap: pretty`, in
// spirit). We never break inside a word. `base` is the block's colour SGR,
// re-emitted at the start of each continuation line so colour survives the
// break; `hang` is the continuation indent (hanging indent under list/quote
// markers). No-op when width is unknown (piped output) so redirected text and
// tests stay raw.
const ANSI = /\x1b\[[0-9;]*m/g;
const vis = (s) => s.replace(ANSI, '').length;

function softWrap(s, base = '', hang) {
  const width = require('./ui').termWidth();
  if (!width || width < 24 || vis(s) <= width) return s;
  const lead = s.match(/^ */)[0].length;
  const indent = hang == null ? lead : hang;
  const words = s.slice(lead).split(/ +/);
  const pad = ' '.repeat(indent);
  const out = [];
  let cur = ' '.repeat(lead);
  let len = lead;
  let started = false;
  for (const word of words) {
    const wl = vis(word);
    if (started && len + 1 + wl > width) {
      out.push(cur + A.reset);
      cur = base + pad + word;
      len = indent + wl;
    } else {
      cur += (started ? ' ' : '') + word;
      len += (started ? 1 : 0) + wl;
      started = true;
    }
  }
  out.push(cur);
  return out.join('\n');
}

// Render one complete line, mutating `state` for block-level context.
// Body text keeps the default terminal foreground (bright) — only structural
// elements get colour, so a reply reads as a reply, not as dimmed UI chrome.
function renderLine(line, state = {}) {
  const fence = line.match(/^\s*```+\s*\w*\s*$/);
  if (fence) {
    state.inFence = !state.inFence;
    return `  ${A.slate}${A.dim}┄┄┄${A.reset}`;
  }
  if (state.inFence) {
    return `  ${A.teal}${line}${A.reset}`; // literal code, no inline md
  }
  if (/^#{1,2}\s/.test(line)) return `\n${A.bold}${A.teal}${inlineMd(line.replace(/^#+\s*/, ''), A.teal)}${A.reset}`;
  if (/^#{3,}\s/.test(line)) return `${A.cream}${inlineMd(line.replace(/^#+\s*/, ''), A.cream)}${A.reset}`;
  if (/^\s*[-*]\s/.test(line)) return softWrap(`  ${A.teal}·${A.reset} ${A.sage}${inlineMd(line.replace(/^\s*[-*]\s*/, ''), A.sage)}${A.reset}`, A.sage, 4);
  if (/^\s*\d+\.\s/.test(line)) return softWrap(`  ${A.sage}${inlineMd(line.trim(), A.sage)}${A.reset}`, A.sage, 5);
  if (/^\s*>\s?/.test(line)) return softWrap(`  ${A.slate}${A.ital}${inlineMd(line.replace(/^\s*>\s?/, ''), A.slate)}${A.italOff}${A.reset}`, A.slate, 4);
  if (/^---+\s*$/.test(line)) return `  ${A.slate}${'─'.repeat(40)}${A.reset}`;
  if (line.trim() === '') return '';
  return softWrap(inlineMd(line, ''), '', 0); // body: default foreground, inline styling only
}

// Line-buffered streaming renderer. Feed raw token text via push(); each time a
// newline completes a line, the rendered line (with its trailing '\n') is handed
// to write(). flush() renders any trailing partial line at stream end. The
// caller's write() is where first-output side effects (stop the spinner, print a
// leading newline) belong, so they fire on first *rendered* output, not on the
// first raw token — no spinner-stopped-but-blank gap.
function streamRenderer(write) {
  let buf = '';
  const state = { inFence: false };
  return {
    push(text) {
      buf += text;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        write(renderLine(line, state) + '\n');
      }
    },
    flush() {
      if (buf.length) {
        write(renderLine(buf, state) + '\n');
        buf = '';
      }
    },
  };
}

// Render a complete markdown string to styled, word-wrapped terminal text —
// the non-streaming counterpart to streamRenderer, for content we already have
// in full (a handoff brief, a saved record). Carries fence state across lines
// so code blocks render literally.
function renderMarkdown(md) {
  const state = { inFence: false };
  return String(md).split('\n').map((line) => renderLine(line, state)).join('\n');
}

module.exports = { inlineMd, renderLine, streamRenderer, renderMarkdown };
