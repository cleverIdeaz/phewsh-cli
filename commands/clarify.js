// phewsh clarify
// Takes raw, messy intent and compiles it into a structured PPS.
// First run: creates .intent/ + pps.json + .md views.
// Subsequent runs: updates pps.json fields and regenerates views.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { readPPS, createPPS, writeGuardedViews } = require('../lib/pps');
const configFile = require('../lib/config-file');

const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');
const INTENT_DIR = path.join(process.cwd(), '.intent');

const args = process.argv.slice(3);
const textFlag = args.indexOf('--text');
const rawFromFlag = textFlag !== -1 ? args.slice(textFlag + 1).join(' ') : null;
const isUpdate = args.includes('--update') || args.includes('-u');

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function getProjectName() {
  const existing = readPPS(INTENT_DIR);
  if (existing?.entity) return existing.entity;
  const visionPath = path.join(INTENT_DIR, 'vision.md');
  if (fs.existsSync(visionPath)) {
    const m = fs.readFileSync(visionPath, 'utf-8').match(/^entity:\s*(.+)$/m);
    if (m) return m[1].trim();
  }
  return path.basename(process.cwd());
}

async function askForInput() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log('\n  Describe what you\'re building. Be as messy as you want.\n');
    console.log('  (You bring the messy idea. PHEWSH compiles it into a clear, structured spec.)\n');
    process.stdout.write('  > ');
    let input = '';
    rl.on('line', (line) => { input += (input ? ' ' : '') + line.trim(); });
    rl.on('close', () => resolve(input.trim()));
  });
}

// The guided walk — nodes of the 12-node Intent Compass, asked one at a
// time. Default: the five strongest (CORE_NODES). --deep: all twelve. The
// web compass helps the user *see* what they're building; this brings that
// to the terminal. Not a form: every question is skippable, and the point
// is to help you think, not interrogate.
const { INTENT_NODES, CORE_NODES } = require('../lib/intent-nodes');
const GUIDE_NODES = CORE_NODES;

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve((a || '').trim())));
}

// rl is injectable so the walk can be driven deterministically in tests.
// nodes defaults to the five-node core walk; --deep passes all twelve.
async function askGuided(rl = readline.createInterface({ input: process.stdin, output: process.stdout }), nodes = GUIDE_NODES) {
  const count = nodes.length === 5 ? 'Five quick questions' : `${nodes.length} questions — the full compass`;
  console.log(`\n  ${count} to align your own thinking first —`);
  console.log('  a sentence or two each. Blank skips. (esc stops, nothing saved.)\n');
  const answers = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    console.log(`  ${i + 1}/${nodes.length}  ${n.title} — ${n.directive}`);
    const a = await ask(rl, `  ${n.q}\n  > `);
    if (a) answers.push({ ...n, answer: a });
    console.log('');
  }
  rl.close();
  return answers;
}

// Label each answer by its node so the compiler keeps the structure the walk
// surfaced (a Purpose answer informs the goal, Scope informs constraints, etc.)
function assembleRaw(answers) {
  return answers.map((a) => `${a.title} (${a.directive}): ${a.answer}`).join('\n');
}

// No-AI spec from the user's own words: the first answer line becomes the
// goal (node label stripped), the raw text survives verbatim in pps.intent.raw,
// and the first task points back at the AI compile.
function fallbackSpec(raw) {
  const first = String(raw).split('\n').find(l => l.trim()) || "Capture this project's intent";
  const goal = first.replace(/^[A-Za-z]+ \([^)]*\):\s*/, '').trim().slice(0, 200);
  return {
    goal,
    success_criteria: [],
    constraints: [],
    inputs: [],
    outputs: [],
    tasks: [
      { text: 'Re-run `phewsh clarify --update` to compile this spec with AI', type: 'copy' },
      { text: 'Refine the vision — complete vision.md', type: 'do' },
      { text: 'Define Phase 1 — what is the smallest thing to ship?', type: 'do' },
    ],
  };
}

function buildClarifySystemPrompt(existing) {
  const isRefine = !!(existing?.intent?.goal);
  return `You are a project compiler. Your job is to extract clean, structured intent from messy human input.

Return ONLY valid JSON — no markdown, no explanation, no commentary. The JSON must match this exact schema:

{
  "goal": "one sentence north star (what this is and why it exists)",
  "success_criteria": ["measurable outcome", "measurable outcome"],
  "constraints": ["constraint or non-negotiable", "..."],
  "inputs": ["what this takes in or requires"],
  "outputs": ["what this produces or delivers"],
  "tasks": [
    {"text": "first concrete action to take", "type": "do"},
    {"text": "second action", "type": "do"}
  ]
}

Rules:
- goal: one sentence, no buzzwords, no hedging
- success_criteria: 2-5 items, must be measurable or observable
- constraints: real limits only (budget, time, technical, ethical). 0-3 items.
- inputs: what the project needs to function (data, people, tools). 1-4 items.
- outputs: what the project delivers. 1-4 items.
- tasks: 3-7 concrete next actions, specific enough to act on immediately
- type options: "do" (manual action), "copy" (command to run), "open" (URL to visit), "install" (package to install)
${isRefine ? '\nThis is a refinement of existing intent. The previous goal was: ' + existing.intent.goal : ''}`;
}

// Pull the first valid JSON object out of model output — harnesses may wrap it
// in prose or code fences; the API returns it clean. Throws if none parses.
function extractJson(text) {
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text.trim());
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next candidate */ }
  }
  throw new Error('could not parse a project spec from the model output');
}

async function callClarifyAPI(apiKey, raw, existing) {
  const systemPrompt = buildClarifySystemPrompt(existing);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: require('../lib/providers').DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: raw }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  return extractJson(data.content?.[0]?.text || '');
}

// No API key? Compile through an installed harness instead — pass-through, so
// clarify works for anyone with Claude Code / Codex / etc., no key required.
async function callClarifyViaHarness(harnessId, raw, existing) {
  const { runViaHarness } = require('../lib/harnesses');
  const systemPrompt = buildClarifySystemPrompt(existing) +
    '\n\nReturn ONLY the JSON object — no prose, no code fences, before or after.';
  const out = await runViaHarness(harnessId, systemPrompt, raw, { quiet: true });
  return extractJson(out || '');
}

async function main() {
  // ESC backs out cleanly at any point — nothing half-written, no error.
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', (str, key) => {
      if (key && key.name === 'escape') {
        console.log('\n\n  stopped — esc. Nothing changed.\n');
        process.exit(0);
      }
    });
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  😮‍💨🤫  phewsh clarify

  Usage:
    phewsh clarify                    Guided: a 5-question walk that aligns your thinking, then compiles
    phewsh clarify --deep             The full 12-node compass, one question at a time
    phewsh clarify --freeform         Free-form: describe it all in one messy blob
    phewsh clarify --text "..."       Inline: pass raw text directly
    phewsh clarify --update           Refine existing intent with new input

  What it does:
    Walks you through the strongest nodes of the 12-node Intent Compass —
    Purpose, Audience, Method, Scope, Edge (--deep adds Context, Resources,
    Strategy, Signals, Risks, Values, Impact) — one question at a time, so
    the terminal helps you *think*, not just compile. Then it writes
    vision.md, plan.md, next.md — YOUR files, project truth supported tool
    adapters can read. Files you've edited by hand are never overwritten.
    (.intent/pps.json holds the compiled spec + generation receipts.)

  Requires:
    An installed agent CLI (Claude Code, Codex, Gemini…) — phewsh uses its
    login, no key. Or run "phewsh login --set-key" to use an Anthropic API key.

  Examples:
    phewsh clarify
    phewsh clarify --text "I want to build a thing that helps people track habits with AI"
    phewsh clarify --update           After new context or direction change
    `);
    return;
  }

  const config = loadConfig();
  // Pass-through: with no API key, compile through an installed harness
  // (Claude Code, Codex, …) — the same login the rest of phewsh rides on.
  const harnessId = config?.apiKey ? null : require('../lib/harnesses').detectInstalled();
  if (!config?.apiKey && !harnessId) {
    console.log('\n  Nothing to compile with yet. Either:');
    console.log('    • install an agent CLI (Claude Code, Codex, Gemini…) — phewsh uses its login, or');
    console.log('    • run `phewsh login --set-key` to add an API key.\n');
    process.exit(1);
  }

  const existing = readPPS(INTENT_DIR);
  if (existing && !isUpdate) {
    console.log('\n  .intent/pps.json already exists.');
    console.log('  Run `phewsh clarify --update` to refine, or `phewsh intent --status` to view.\n');
    return;
  }

  console.log('\n  😮‍💨🤫  phewsh clarify\n');

  const freeform = args.includes('--freeform') || args.includes('-f');
  let raw = rawFromFlag;
  if (!raw) {
    if (!process.stdin.isTTY) {
      console.error('\n  Pipe input or use --text "your description"\n');
      process.exit(1);
    }
    if (freeform) {
      raw = await askForInput();
    } else {
      // Guided is the default interactive path: help the user think first.
      // --deep walks the full 12-node compass instead of the strongest five.
      const deep = args.includes('--deep') || args.includes('-d');
      const answers = await askGuided(undefined, deep ? INTENT_NODES : GUIDE_NODES);
      raw = assembleRaw(answers);
      if (!raw) {
        // Skipped every question — fall back to a single free-form description.
        console.log('  No problem — describe it your own way instead.');
        raw = await askForInput();
      }
    }
  }

  if (!raw) {
    console.log('\n  Nothing to clarify.\n');
    return;
  }

  const { HARNESSES } = require('../lib/harnesses');
  const via = harnessId ? ` via ${HARNESSES[harnessId]?.label || harnessId}` : '';
  console.log(`\n  Compiling your intent into a spec${via}...\n`);

  let extracted;
  try {
    extracted = harnessId
      ? await callClarifyViaHarness(harnessId, raw, existing)
      : await callClarifyAPI(config.apiKey, raw, existing);
  } catch (err) {
    // A failed compile must NEVER eat the user's answers. They just walked
    // the compass — write a plain no-AI spec from what they typed, and let
    // `clarify --update` enrich it when a route works again.
    console.log(`\n  AI compile unavailable (${err.message}).`);
    console.log('  Saving your answers as a plain spec instead — nothing you typed is lost.');
    extracted = fallbackSpec(raw);
  }

  const entity = getProjectName();
  let pps;

  if (existing && isUpdate) {
    // Patch existing PPS with new intent fields, preserve id/created/tasks state
    pps = {
      ...existing,
      intent: {
        raw,
        goal: extracted.goal,
        success_criteria: extracted.success_criteria || [],
        constraints: extracted.constraints || [],
        inputs: extracted.inputs || [],
        outputs: extracted.outputs || [],
      },
    };
    // Merge new tasks (preserve done tasks, add new ones)
    const doneTasks = existing.tasks.filter(t => t.status === 'done');
    const newTasks = (extracted.tasks || []).map((t, i) => ({
      id: `t_${String(Date.now() + i).slice(-6)}`,
      text: t.text,
      status: 'open',
      type: t.type || 'do',
      blocked_by: null,
    }));
    pps.tasks = [...doneTasks, ...newTasks];
    pps.state.phase = 'plan';
  } else {
    pps = createPPS({ entity, raw, intent: extracted });
    pps.state.phase = 'plan';
  }

  // The truth guard: the .md files are user-owned truth. Hand-edited (or
  // pre-existing hand-authored) files are preserved, never regenerated.
  const { written, preserved } = writeGuardedViews(INTENT_DIR, pps);

  console.log(`  ✓ .intent/pps.json       — compiled spec (the .md files are the truth)`);
  const detail = {
    'vision.md': pps.intent.goal,
    'plan.md': `${pps.intent.success_criteria.length} outcomes, ${pps.intent.constraints.length} constraints`,
    'next.md': `${pps.tasks.length} actions`,
  };
  for (const f of written) console.log(`  ✓ .intent/${f.padEnd(14)} — ${detail[f]}`);
  for (const f of preserved) console.log(`  ● .intent/${f.padEnd(14)} — kept as-is (yours — edited by hand, phewsh won't overwrite it)`);
  console.log('');
  console.log(`  Goal: ${pps.intent.goal}\n`);
  if (pps.tasks.length > 0) {
    console.log('  First actions:');
    pps.tasks.slice(0, 3).forEach(t => console.log(`    ·  ${t.text}`));
  }
  console.log(`
  Next:
    phewsh intent --status     Review your artifacts
    phewsh clarify --update    Refine with more context
    phewsh ai run "..."        Run AI with this context
  `);
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n  Error:', err.message);
    process.exit(1);
  });
}

module.exports = { run: main, GUIDE_NODES, INTENT_NODES, assembleRaw, askGuided, extractJson, fallbackSpec };
