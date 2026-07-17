// phewsh ui — the exhale
// Relief. Quiet execution. Cool sweet future.
// Zero dependencies. Pure ANSI. The terminal breathes.

// ── PHEWSH palette ───────────────────────────────────────
// 256-color (38;5;n), NOT 24-bit (38;2;r;g;b). Terminals without truecolor
// (Apple Terminal et al.) misparse 24-bit params as separate SGR codes —
// e.g. teal's red channel "100" became "bright black BACKGROUND" = grey
// boxes behind text. 256-color is a single param: renders the same
// everywhere. Comfy in every terminal beats precise in some.
const c256 = (n) => (s) => `\x1b[38;5;${n}m${s}\x1b[0m`;
const rgb = (r, g, b) => (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`; // kept for callers; avoid for new UI
const rgbBg = (r, g, b) => (s) => `\x1b[48;2;${r};${g};${b}m${s}\x1b[0m`;

// Brand colors — relief, quiet, future
const teal    = c256(79);    // #5fd7af  cool calm — primary
const peach   = c256(216);   // #ffaf87  warm exhale — accent
const sage    = c256(151);   // #afd7af  quiet — secondary text
const slate   = c256(247);   // #9e9e9e  whisper — dim but legible
const cream   = c256(230);   // #ffffd7  clarity — bright text
const ember   = c256(173);   // #d7875f  glow — warnings/energy

// Standard ANSI fallbacks (used where 24-bit might not render)
const b  = (s) => `\x1b[1m${s}\x1b[0m`;
const d  = (s) => `\x1b[2m${s}\x1b[0m`;
const w  = (s) => `\x1b[97m${s}\x1b[0m`;
const g  = (s) => `\x1b[90m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const magenta = (s) => `\x1b[35m${s}\x1b[0m`;
const blue   = (s) => `\x1b[34m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;

// ANSI cursor control
const hide = '\x1b[?25l';
const show = '\x1b[?25h';
const up = (n = 1) => `\x1b[${n}A`;
const clearLine = '\x1b[2K\r';

// ── Sleep helper ─────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Spinner: the exhale pulse ────────────────────────────
// Breathes in and out. Calm. Not frantic.
const EXHALE_FRAMES = [
  '    ·    ',
  '   · ·   ',
  '  ·   ·  ',
  ' ·     · ',
  '·       ·',
  ' ·     · ',
  '  ·   ·  ',
  '   · ·   ',
];

const BREATH_DOTS = ['  ·', ' · ·', '· · ·', ' · ·', '  ·', '    '];

const GENTLE_FRAMES = ['·', '•', '●', '•', '·', ' '];

function spinner(text = 'thinking', style = 'exhale') {
  const frames = style === 'gentle' ? GENTLE_FRAMES
    : style === 'dots' ? BREATH_DOTS
    : EXHALE_FRAMES;
  let i = 0;
  let stopped = false;
  let currentText = text;
  process.stdout.write(hide);
  const interval = setInterval(() => {
    if (stopped) return;
    const frame = frames[i % frames.length];
    process.stdout.write(`${clearLine}  ${teal(frame)} ${sage(currentText)}`);
    i++;
  }, style === 'gentle' ? 150 : 100);

  return {
    update(newText) { currentText = newText; },
    stop(finalText) {
      stopped = true;
      clearInterval(interval);
      process.stdout.write(`${clearLine}${show}`);
      if (finalText) process.stdout.write(`  ${finalText}\n`);
    }
  };
}

// ── The Exhale: signature brand reveal ───────────────────
// Crisp over clever: plain prints with a breath of timing. No in-place
// rewrites, no cursor tricks, no dim-wrapped emoji — those are exactly
// what render as grey boxes and artifacts across terminals. Every line
// lands once and stays put.
async function brandReveal(fast = false) {
  const pause = (ms) => fast ? Promise.resolve() : sleep(ms);
  console.log('');
  console.log(`  😮‍💨 🤫`);
  console.log('');
  await pause(160);
  console.log(`  ${b(cream('█▀█ █░█ █▀▀ █░█░█ █▀ █░█'))}`);
  console.log(`  ${b(cream('█▀▀ █▀█ ██▄ ▀▄▀▄▀ ▄█ █▀█'))}`);
  await pause(160);
  // The value prop, plain language, off the bat — the alignment wedge, not
  // "memory". It exhales in (typewriter) when animated; lands instantly
  // otherwise. Safe: the color wrapper is emitted up front, only words reveal.
  const tagline = 'One project. Many AI tools. Visible handoffs.';
  if (fast || !process.stdout.isTTY) {
    console.log(`  ${sage(tagline)}`);
  } else {
    process.stdout.write('  ');
    await typewrite(sage(tagline), 20);
  }
  console.log('');
}

// ── Smart line wrap ──────────────────────────────────────
// The terminal's default hard wrap breaks mid-word at the window edge. This
// wraps at word boundaries instead (CSS `text-wrap: pretty`, in spirit),
// ANSI-aware: colour codes carry zero width, and the colour active at a break
// is re-opened on the continuation line so nothing loses its tint. A word
// longer than the line is left whole — we never split inside a word, which is
// the whole point. Per physical line; only over-long lines are touched.
const SGR = /\x1b\[[0-9;]*m/g;
const visW = (s) => s.replace(SGR, '').length;

// Best available terminal width, with a safety margin so content never sits
// flush against the edge (where terminals add their own mid-word wrap). The
// width is pinnable, the escape hatch for host terminals that misreport their
// size — some embedded/agent terminals (e.g. Grok Build) advertise a wider pty
// than the visible pane, so text breaks mid-word even with smart wrap on.
// Resolution order: live override (set by `/width`) → PHEWSH_WIDTH env →
// the tty's reported columns → COLUMNS env → 80. Two columns are held back as
// margin so an off-by-one in the host's report can't cause a mid-word break.
let _widthOverride = null;
const WIDTH_MARGIN = 2;

function setWidth(n) {
  const v = parseInt(n, 10);
  _widthOverride = (Number.isFinite(v) && v >= 20) ? v : null;
  return _widthOverride;
}

// The raw width phewsh believes the terminal is, before margin — what `/width`
// reports back so the user can compare it to their visible pane.
function rawWidth() {
  if (_widthOverride) return _widthOverride;
  const pin = parseInt(process.env.PHEWSH_WIDTH, 10);
  if (Number.isFinite(pin) && pin >= 20) return pin;
  return process.stdout.columns || parseInt(process.env.COLUMNS, 10) || 80;
}

function termWidth() {
  return Math.max(24, rawWidth() - WIDTH_MARGIN);
}

// Active SGR state after consuming `s`, starting from `prev`. A reset clears it;
// any other colour code accumulates. Good enough to re-open colour at a break.
function sgrAfter(prev, s) {
  let active = prev;
  for (const code of s.match(SGR) || []) {
    active = (code === '\x1b[0m' || code === '\x1b[m') ? '' : active + code;
  }
  return active;
}

function wrapAnsi(s, width) {
  if (!width || width < 24) return s;
  return s.split('\n').map((line) => {
    if (visW(line) <= width) return line;
    const lead = line.match(/^ */)[0].length;
    const pad = ' '.repeat(lead);
    const words = line.slice(lead).split(/ +/);
    const out = [];
    let cur = pad, len = lead, started = false, active = '';
    for (const word of words) {
      const wl = visW(word);
      if (started && len + 1 + wl > width) {
        out.push(cur + '\x1b[0m');       // close colour cleanly at the break
        cur = active + pad + word;       // re-open it on the continuation line
        len = lead + wl;
      } else {
        cur += (started ? ' ' : '') + word;
        len += (started ? 1 : 0) + wl;
        started = true;
      }
      active = sgrAfter(active, word);
    }
    out.push(cur);
    return out.join('\n');
  }).join('\n');
}

// Monkeypatch console.log so every prose line the CLI prints wraps at word
// boundaries. TTY-only (piped/redirected output stays raw for tooling), and
// only the simple all-string case is transformed — object args pass through
// untouched. Idempotent. process.stdout.write paths (spinner, typewriter,
// streamed AI render) are intentionally left alone; they handle their own.
function installSmartWrap() {
  if (!process.stdout.isTTY || console.log.__phewshWrapped) return;
  const orig = console.log.bind(console);
  const wrapped = (...args) => {
    if (args.length && args.every((a) => typeof a === 'string')) {
      orig(wrapAnsi(args.join(' '), termWidth()));
    } else {
      orig(...args);
    }
  };
  wrapped.__phewshWrapped = true;
  console.log = wrapped;
}

// ── Status panel ─────────────────────────────────────────
function statusPanel(title, rows) {
  const maxLabel = Math.max(...rows.map(r => r[0].length));
  console.log('');
  console.log(`  ${b(cream(title))}`);
  console.log(`  ${slate('─'.repeat(48))}`);
  for (const [label, value, color] of rows) {
    const colorFn = color === 'green' ? green
      : color === 'yellow' ? ember
      : color === 'cyan' ? teal
      : color === 'red' ? red
      : color === 'peach' ? peach
      : (s) => s;
    console.log(`  ${sage(label.padEnd(maxLabel + 2))} ${colorFn(value)}`);
  }
  console.log(`  ${slate('─'.repeat(48))}`);
  console.log('');
}

// ── Interop badge line ───────────────────────────────────
function interopLine(config, intentFiles) {
  const parts = [];
  if (intentFiles.length > 0) parts.push(teal('●') + sage(' .intent/'));
  if (config?.apiKey) parts.push(teal('●') + sage(' AI'));
  if (config?.supabaseUserId) parts.push(teal('●') + sage(' cloud'));

  const available = [
    sage('Claude Code'),
    sage('Cursor'),
    sage('ChatGPT'),
    sage('MCP'),
  ];

  if (parts.length > 0) {
    console.log(`  ${slate('active')}    ${parts.join(slate('  ·  '))}`);
  }
  console.log(`  ${slate('works in')}  ${available.join(slate(' · '))}`);
}

// ── Divider ──────────────────────────────────────────────
function divider(style = 'line', width = 48) {
  const char = style === 'dots' ? '·' : style === 'fade' ? '░' : '─';
  console.log(`  ${slate(char.repeat(width))}`);
}

// ── Typewriter ───────────────────────────────────────────
function typewrite(text, speed = 25) {
  return new Promise((resolve) => {
    let i = 0;
    const interval = setInterval(() => {
      if (i >= text.length) {
        clearInterval(interval);
        process.stdout.write('\n');
        resolve();
        return;
      }
      process.stdout.write(text[i]);
      i++;
    }, speed);
  });
}

// ── Welcome tips ─────────────────────────────────────────
const TIPS = [
  `${sage('try')} ${cream('/clarify')} ${sage('— turns ideas into .intent/ artifacts')}`,
  `${sage('try')} ${cream('/gate')} ${sage('— set budget/time constraints, AI respects them')}`,
  `${sage('try')} ${cream('/watch')} ${sage('— sync .intent/ across harness files in the background')}`,
  `${sage('try')} ${cream('/export')} ${sage('— .intent/ as portable context for any AI tool')}`,
  `${sage('.intent/ is plain markdown — edit the files directly anytime')}`,
  `${sage('the loop: define .intent/ → sync → work → evolve → repeat')}`,
  `${sage('try')} ${cream('/tour')} ${sage('— quick walkthrough, no key needed')}`,
  `${sage('works in Claude Code, Cursor, ChatGPT, and compatible MCP clients')}`,
];

function randomTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

// ── Tour content ─────────────────────────────────────────
const TOUR_PAGES = [
  {
    title: 'The idea',
    body: [
      '',
      `  Your AI tools keep asking the same question:`,
      `  ${slate('"What are you building?"')}`,
      '',
      `  ${teal('.intent/')} ${sage('answers it once. Native adapters brief each supported tool.')}`,
      `  Plain markdown. Committed with your code. No lock-in.`,
      '',
      `  ${sage('The loop:')} ${cream('define')} ${sage('→')} ${cream('sync')} ${sage('→')} ${cream('work')} ${sage('→')} ${cream('evolve')} ${sage('→')} ${cream('repeat')}`,
    ]
  },
  {
    title: 'The files',
    body: [
      '',
      `  ${teal('.intent/')}`,
      `    ${peach('vision.md')}    ${sage('What you\'re building and why')}`,
      `    ${peach('plan.md')}      ${sage('Strategy, phases, milestones')}`,
      `    ${peach('next.md')}      ${sage('What to do right now')}`,
      `    ${ember('project.json')} ${sage('Constraints (decisionGate): budget, time, skill')}`,
      '',
      `  ${cream('/init')} ${sage('creates them.')} ${cream('/clarify')} ${sage('authors them with AI.')}`,
      `  ${sage('Or just edit the markdown directly.')}`,
    ]
  },
  {
    title: 'Update adapters',
    body: [
      '',
      `  ${cream('/watch')} ${sage('refreshes supported adapters while the command is running:')}`,
      '',
      `  ${b(cream('Claude Code'))}   ${sage('→ CLAUDE.md auto-updates')}`,
      `  ${b(cream('Cursor'))}        ${sage('→ /export writes .phewsh.context')}`,
      `  ${b(cream('ChatGPT'))}       ${sage('→ /export --copy to clipboard')}`,
      `  ${b(cream('MCP agents'))}    ${sage('→ self-brief from .intent/ via protocol')}`,
      '',
      `  ${sage('Switch with a fresh brief. Native transcripts stay with their tool.')}`,
    ]
  },
  {
    title: 'Constraints',
    body: [
      '',
      `  ${cream('/gate')} ${sage('captures what you can actually spend:')}`,
      '',
      `    ${sage('Budget')}     ${cream('$50')}            ${sage('Skill')}      ${cream('expert')}`,
      `    ${sage('Time')}       ${cream('15 hrs/week')}     ${sage('Urgency')}    ${cream('high')}`,
      '',
      `  ${sage('These constraints are included in supported tool briefs.')}`,
      `  ${sage('Ask "what should I do next?" — the answer fits your reality.')}`,
    ]
  },
  {
    title: 'Go',
    body: [
      '',
      `  ${teal('1.')} ${cream('/init')} ${sage('or')} ${cream('/clarify')} ${sage('— create .intent/')}`,
      `  ${teal('2.')} ${sage('Type naturally — context is always loaded')}`,
      `  ${teal('3.')} ${cream('/watch')} ${sage('— sync to all your tools')}`,
      `  ${teal('4.')} ${cream('/gate')} ${sage('— set constraints')}`,
      '',
      `  ${sage('Intent-driven development. Define once. Work everywhere.')}`,
    ]
  },
];

module.exports = {
  // Brand palette
  teal, peach, sage, slate, cream, ember,
  // Standard ANSI
  b, d, w, g, green, cyan, yellow, magenta, blue, red,
  // Components
  spinner, brandReveal, statusPanel, interopLine, divider, typewrite,
  randomTip, TOUR_PAGES,
  // Smart wrap
  wrapAnsi, installSmartWrap, termWidth, rawWidth, setWidth,
  // ANSI helpers
  hide, show, up, clearLine, sleep,
};
