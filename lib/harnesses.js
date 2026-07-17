// Agent harnesses installed on this machine, and how to invoke them headlessly.
//
// PHEWSH is not a harness — it's the layer that uses the ones you already
// have. Each of these carries its OWN auth (Claude Code uses your Claude
// subscription, Codex your ChatGPT plan, Gemini your Google login), so going
// through them needs no API key in phewsh at all.
//
// Used by:
//   phewsh serve     — web-dispatched jobs execute through these
//   phewsh ai        — harnesses double as no-key providers

const { execFileSync, spawn } = require('child_process');

// args: how to run a one-shot prompt headlessly. args: null = we only know
// how to launch it interactively (detection + /work still fully supported —
// never guess flags; a wrong invocation looks like phewsh being broken).
//
// args takes (prompt, model). model is passed straight through to the
// harness's own flag and validated BY the harness — phewsh keeps no model
// list of its own, so it can never go stale. Harnesses without a known
// model flag ignore the preference and use their own config.
const HARNESSES = {
  'claude-code': { bin: 'claude',       label: 'Claude Code',  role: 'writes code',          bestFor: 'repo edits, tests, native coding loops',     auth: 'Claude subscription / Console', models: true, modelHints: ['sonnet', 'opus', 'haiku'], streamFormat: 'claude-json', args: (p, m) => ['-p', p, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...(m ? ['--model', m] : [])], interactiveArgs: (brief, m) => ['--append-system-prompt', brief, ...(m ? ['--model', m] : [])] },
  'codex':       { bin: 'codex',        label: 'Codex CLI',    role: 'reasons & reviews',    bestFor: 'reviews, reasoning, second opinions',       auth: 'ChatGPT plan',                  models: true, args: (p, m) => ['exec', '--skip-git-repo-check', ...(m ? ['-m', m] : []), p], interactiveArgs: (brief, m) => [...(m ? ['-m', m] : []), brief] },
  'gemini':      { bin: 'gemini',       label: 'Gemini CLI',   role: "another model's take", bestFor: 'broad scans, alternate framing',              auth: 'Google login',                  models: true, args: (p, m) => ['-p', p, ...(m ? ['-m', m] : [])], interactiveArgs: (brief, m) => ['--prompt-interactive', brief, ...(m ? ['--model', m] : [])] },
  'cursor':      { bin: 'cursor-agent', label: 'Cursor Agent', role: 'edits files',          bestFor: 'editor-side file edits',                    auth: 'Cursor account',                models: true, args: (p, m) => ['-p', p, '--output-format', 'text', ...(m ? ['--model', m] : [])] },
  'opencode':    { bin: 'opencode',     label: 'OpenCode',     role: 'general agent',        bestFor: 'open-source agent work',                    auth: 'OpenCode Zen / configured',     args: (p) => ['run', p], interactiveArgs: (brief) => ['--prompt', brief] },
  'grok':        { bin: 'grok',         label: 'Grok Build',   role: "xAI's take",           bestFor: 'outside take from xAI',                     auth: 'SuperGrok / X Premium+',        args: (p) => ['-p', p] },
  'kiro':        { bin: 'kiro-cli',     label: 'Kiro CLI',     role: 'spec-driven dev',      bestFor: 'spec-driven development',                   auth: 'Kiro / AWS account',            args: (p) => ['chat', '--no-interactive', p] },
  'copilot':     { bin: 'copilot',      label: 'Copilot CLI',  role: 'github-native',        bestFor: 'GitHub-native tasks',                      auth: 'GitHub Copilot plan',           args: (p) => ['-p', p] },
  'hermes':      { bin: 'hermes',       label: 'Hermes',       role: 'runs loops',           bestFor: 'orchestration and continuity',              auth: 'Nous account',                  args: null },
  'pi':          { bin: 'pi',           label: 'Pi',           role: 'conversation',         bestFor: 'conversation',                             auth: 'Pi login',                      args: null },
  'aider':       { bin: 'aider',        label: 'Aider',        role: 'pair-codes',           bestFor: 'pair-programming patches',                  auth: 'configured keys',               models: true, args: (p, m) => ['--message', p, ...(m ? ['--model', m] : [])] },
  'goose':       { bin: 'goose',        label: 'Goose',        role: 'automates tasks',      bestFor: 'automation runs',                          auth: 'Block / configured',            args: (p) => ['run', '-t', p] },
  'amp':         { bin: 'amp',          label: 'Amp',          role: 'agentic coding',       bestFor: 'agentic coding',                           auth: 'Sourcegraph account',           args: (p) => ['-x', p] },
  'droid':       { bin: 'droid',        label: 'Droid',        role: 'agentic coding',       bestFor: 'agentic coding',                           auth: 'Factory account',               args: (p) => ['exec', p] },
};

// Best-effort install hints, shown when a harness isn't on the machine yet.
// Commands where the install path is well-known and stable; a docs pointer
// otherwise. We never auto-run these — phewsh shows them; the human decides.
// (Install paths and auth change upstream; treat as a guidepost, not gospel.)
const INSTALL = {
  'claude-code': 'npm i -g @anthropic-ai/claude-code',
  'codex':       'npm i -g @openai/codex',
  'gemini':      'npm i -g @google/gemini-cli',
  'cursor':      'curl https://cursor.com/install -fsS | bash',
  'opencode':    'npm i -g opencode-ai',
  'grok':        'npm i -g @vibe-kit/grok-cli',
  'copilot':     'npm i -g @github/copilot',
  'kiro':        'see kiro.dev/downloads',
  'hermes':      'see nousresearch.com',
  'pi':          'see pi.ai',
  'aider':       'python -m pip install aider-chat',
  'goose':       'see block.github.io/goose',
  'amp':         'npm i -g @sourcegraph/amp',
  'droid':       'see factory.ai',
};

// In-flight harness children — so ESC in the session can cancel a turn.
const ACTIVE_CHILDREN = new Set();

function cancelActive() {
  let n = 0;
  for (const c of ACTIVE_CHILDREN) {
    try {
      c._phewshCancelled = true; // close handler rejects even if exit is 0
      c.kill('SIGTERM');
      // Some harnesses (codex) ride out SIGTERM and finish anyway —
      // escalate so esc means esc.
      const t = setTimeout(() => {
        try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* gone */ }
      }, 1200);
      if (t.unref) t.unref();
      n++;
    } catch { /* already gone */ }
  }
  return n;
}

function isInstalled(id) {
  const h = HARNESSES[id];
  if (!h) return false;
  try { execFileSync('which', [h.bin], { stdio: 'pipe' }); return true; } catch { return false; }
}

/** First installed chat-capable harness in preference order, or null. */
function detectInstalled() {
  for (const id of Object.keys(HARNESSES)) {
    if (HARNESSES[id].args && isInstalled(id)) return id;
  }
  return null;
}

function listHarnesses() {
  return Object.entries(HARNESSES).map(([id, h]) => ({ id, ...h, headless: !!h.args, installed: isInstalled(id) }));
}

function interactiveLaunchArgs(id, brief, { model } = {}) {
  const h = HARNESSES[id];
  if (!h) throw new Error(`Unknown harness: ${id}`);
  if (!h.interactiveArgs) return { args: [], briefingPassed: false };
  return {
    args: h.interactiveArgs(brief, h.models ? model : undefined),
    briefingPassed: true,
  };
}

/**
 * Run a prompt through a harness, streaming stdout to the terminal.
 * stderr is buffered and only surfaced on failure (codex/gemini chat on it).
 * Resolves with the full stdout text so callers can keep conversation history.
 */
function runViaHarness(id, systemPrompt, userPrompt, opts = {}) {
  const h = HARNESSES[id];
  if (!h) return Promise.reject(new Error(`Unknown harness: ${id}`));
  if (!h.args) return Promise.reject(new Error(`${h.label} is interactive-only here — launch it with /work ${id}`));
  const prompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
  const model = h.models ? opts.model : undefined;

  // Spinner during the wait, and live token streaming where the harness
  // supports it — no path is ever a dead blank screen. quiet (council) parses
  // silently so parallel runs don't interleave into soup.
  // Output is written whenever this isn't a quiet (council) run. The spinner
  // additionally needs a TTY — piped/test contexts get the text, no spinner.
  const show = !opts.quiet;
  let spin = null;
  if (show && process.stdout.isTTY) {
    try { spin = require('./ui').spinner('thinking'); } catch { spin = null; }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(h.bin, h.args(prompt, model), { stdio: ['pipe', 'pipe', 'pipe'] });
    ACTIVE_CHILDREN.add(child);
    child.on('close', () => ACTIVE_CHILDREN.delete(child));
    // Some harnesses (codex exec, gemini) wait for stdin EOF before running.
    child.stdin.end();

    let stderr = '';
    let assembled = '';        // raw text — returned + kept in history (never ANSI)
    let resultFallback = '';   // claude's final `result` field — never-blank guard
    let jsonBuf = '';
    let firstByte = false;

    // Spinner stop + leading newline fire on first *displayed* output, so the
    // line-buffered renderer never leaves a spinner-stopped-but-blank gap.
    function onFirstShow() {
      if (firstByte) return;
      firstByte = true;
      if (spin) { spin.stop(); spin = null; }
      if (show) process.stdout.write('\n');
    }
    // Render markdown only at a real TTY; pipes/quiet get raw passthrough so
    // council parsing and scripted use stay clean (no stray ANSI).
    const render = (show && process.stdout.isTTY)
      ? require('./md').streamRenderer((out) => { onFirstShow(); process.stdout.write(out); })
      : null;

    function emit(text) {
      if (!text) return;
      assembled += text; // always raw
      if (render) render.push(text);
      else if (show) { onFirstShow(); process.stdout.write(text); }
    }

    child.stdout.on('data', (d) => {
      if (h.streamFormat === 'claude-json') {
        // Newline-delimited JSON: each line is one event. text_delta events
        // carry the live tokens; the final `result` is the fallback.
        jsonBuf += d.toString();
        let nl;
        while ((nl = jsonBuf.indexOf('\n')) !== -1) {
          const line = jsonBuf.slice(0, nl).trim();
          jsonBuf = jsonBuf.slice(nl + 1);
          if (!line) continue;
          let obj;
          // A complete line that isn't JSON is real output (plain-text error,
          // or a non-streaming stub) — show it rather than swallow it.
          try { obj = JSON.parse(line); } catch { emit(line + '\n'); continue; }
          if (obj.type === 'stream_event'
              && obj.event?.type === 'content_block_delta'
              && obj.event.delta?.type === 'text_delta') {
            emit(obj.event.delta.text);
          } else if (obj.type === 'result' && typeof obj.result === 'string') {
            resultFallback = obj.result;
          }
        }
      } else {
        emit(d.toString());
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (spin) { spin.stop(); spin = null; }
      if (h.streamFormat === 'claude-json' && jsonBuf.trim()) {
        try {
          const obj = JSON.parse(jsonBuf.trim());
          if (obj.type === 'result' && typeof obj.result === 'string') resultFallback = obj.result;
        } catch { /* partial trailing line */ }
      }
      if (render) render.flush(); // render any trailing partial line
      // Streaming produced nothing but the result has text → show it. Never blank.
      let finalText = assembled;
      if (!assembled.trim() && resultFallback) {
        finalText = resultFallback;
        if (render) { render.push(resultFallback); render.flush(); }
        else if (show) { onFirstShow(); process.stdout.write(resultFallback); }
      }
      if (show) process.stdout.write('\n');
      if (child._phewshCancelled) return reject(new Error(`${h.label} cancelled`));
      if (code === 0) resolve(finalText);
      else reject(new Error(`${h.label} exited ${code}${stderr ? `\n  ${stderr.trim().split('\n').slice(-3).join('\n  ')}` : ''}`));
    });
    child.on('error', (e) => {
      if (spin) { spin.stop(); spin = null; }
      reject(new Error(`Could not run ${h.bin}: ${e.message}`));
    });
  });
}

// Resolve a user-typed token to a harness id. Accepts the canonical id, the
// tool's actual binary (so `phewsh claude` → claude-code, since `claude` is the
// Claude Code binary; `phewsh cursor-agent` → cursor), or a friendly alias.
// Returns the harness id, or null if nothing matches.
const HARNESS_ALIASES = {
  claude: 'claude-code',
  cc: 'claude-code',
  'cursor-agent': 'cursor',
  'kiro-cli': 'kiro',
  copilot: 'copilot',
};
function resolveHarness(token) {
  if (!token) return null;
  const t = String(token).toLowerCase();
  if (HARNESSES[t]) return t;
  if (HARNESS_ALIASES[t]) return HARNESS_ALIASES[t];
  for (const [id, h] of Object.entries(HARNESSES)) {
    if (h.bin && h.bin.toLowerCase() === t) return id;
  }
  return null;
}

module.exports = {
  HARNESSES,
  INSTALL,
  resolveHarness,
  isInstalled,
  detectInstalled,
  interactiveLaunchArgs,
  listHarnesses,
  runViaHarness,
  cancelActive,
};
