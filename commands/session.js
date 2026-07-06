// phewsh session — persistent agent shell
// Drops you into a REPL where you type naturally.
// Under the hood: routes to Claude, injects .intent/ context, tracks SAP.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { trackSap } = require('../lib/supabase');
const ui = require('../lib/ui');

const CONFIG_DIR = path.join(os.homedir(), '.phewsh');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
// Dynamic — the session can chdir into a project from the root bootstrap
const intentDir = () => path.join(process.cwd(), '.intent');

const { select, refreshSession: refreshSess } = require('../lib/supabase');
const { readPPS } = require('../lib/pps');
const { push, pull, ensureValidToken } = require('./sync');
const { HARNESSES, INSTALL, interactiveLaunchArgs, listHarnesses, runViaHarness, cancelActive } = require('../lib/harnesses');
const { recordDecision, labelOutcome, pendingDecisions, recentDecisions, outcomeStats, OUTCOMES } = require('../lib/outcomes');
const { suggest, suggestAll } = require('../lib/suggest');
const continuity = require('../lib/continuity');
const selfheal = require('../lib/selfheal');
const learning = require('../lib/learning');
const recall = require('../lib/recall');
const { routeCoach } = require('../lib/route-coach');
const { closest } = require('../lib/closest');
const cmdHistory = require('../lib/history');
const { recordSessionEvent } = require('../lib/receipts-data');
const configFile = require('../lib/config-file');
const { loadIntentContext } = require('../lib/intent-context');
const { auditTruth, formatTruth, quickVerifiedState } = require('../lib/truth');
const { generateBrief, persistBrief } = require('../lib/brief');
const {
  applyReconciliation,
  captureSnapshot,
  createPostflight,
  formatObservedReport,
  observeCurrent,
  reconciliationProposal,
} = require('../lib/lifecycle');
const { formatSourceContract } = require('../lib/source-contract');
const { createFailureTracker, createLineDispatcher } = require('../lib/session-input');
const {
  echoedRows,
  estimateTokens,
  formatPasteSummary,
  formatTokenCount,
  relativeFolder,
  shouldCollapsePaste,
} = require('../lib/session-display');
const { recordProject, listProjects, scanForProjects, scanForCandidates, fmtAgo } = require('../lib/projects-index');

// Brand palette shortcuts
const { b, d, w, g, green, cyan, yellow,
        teal, peach, sage, slate, cream, ember } = ui;

// Best-effort copy to the system clipboard so the brief survives the native
// tool taking over the terminal (and any trust/permission gate). Returns true
// if a clipboard tool accepted it. Never throws — it's a convenience.
function copyToClipboard(text) {
  const { spawnSync } = require('child_process');
  const tries = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [bin, args] of tries) {
    try {
      const r = spawnSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      if (r.status === 0) return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

// Show the cross-harness handoff — the heart of phewsh's continuity promise:
// the verified brief that travels to whatever AI tool you pick up next, now
// rendered as readable markdown instead of raw text and saved so the next tool
// (or the next phewsh session) inherits it. Best-effort and fail-soft; a
// handoff that can't generate must never block exit or a switch.
async function showHandoff({ projectName, route, reason = '', nextHint = true } = {}) {
  let result = { shown: false, file: null };
  try {
    const { content } = await generateBrief();
    const { renderMarkdown } = require('../lib/md');
    const saved = persistBrief(content, { project: projectName, route: route || 'unknown' });
    console.log('');
    console.log(`  ${teal('●')} ${b(cream('Handoff ready'))}${reason ? ' ' + slate('— ' + reason) : ''}`);
    console.log(`  ${slate('This is exactly what travels to the next AI tool — nothing re-explained.')}`);
    ui.divider('line');
    console.log(renderMarkdown(content));
    ui.divider('line');
    if (saved.written) console.log(`  ${slate('saved · ' + saved.file.replace(require('os').homedir(), '~'))}`);
    copyToClipboard(content);
    console.log(`  ${slate('copied to clipboard · paste into any tool, or')} ${cream('/use codex')} ${slate('to continue here')}`);
    if (nextHint) console.log(`  ${slate('full verified brief anytime:')} ${cream('/brief')} ${slate('·')} ${cream('/handoff')}`);
    console.log('');
    result = { shown: true, file: saved.file };
  } catch (err) {
    console.log(`  ${ember('!')} ${slate('Could not build the handoff: ' + err.message)}`);
  }
  return result;
}

// Sync awareness: compare local .intent/ timestamps with cloud updated_at
async function checkSyncStatus(config) {
  if (!config?.supabaseUserId || !config?.supabaseAccessToken) return null;
  if (!fs.existsSync(intentDir())) return null;

  try {
    const token = await ensureValidToken(config);
    if (!token) return null;

    const pps = readPPS(intentDir());
    const cloudId = pps?.adapters?.phewsh?.cloud_id;
    const projectName = path.basename(process.cwd());

    const query = cloudId
      ? `id=eq.${cloudId}&user_id=eq.${config.supabaseUserId}&select=id,updated_at`
      : `name=eq.${encodeURIComponent(projectName)}&user_id=eq.${config.supabaseUserId}&select=id,updated_at`;

    const projects = await select('projects', query, token);
    if (projects.length === 0) return { status: 'local-only' };

    const project = projects[0];

    const artifacts = await select(
      'artifacts',
      `project_id=eq.${project.id}&user_id=eq.${config.supabaseUserId}&select=kind,updated_at&order=updated_at.desc&limit=1`,
      token
    );

    const cloudTime = artifacts.length > 0
      ? new Date(artifacts[0].updated_at).getTime()
      : new Date(project.updated_at).getTime();

    const localFiles = ['vision.md', 'plan.md', 'next.md'];
    let latestLocal = 0;
    for (const file of localFiles) {
      const filePath = path.join(intentDir(), file);
      if (fs.existsSync(filePath)) {
        const mtime = fs.statSync(filePath).mtimeMs;
        if (mtime > latestLocal) latestLocal = mtime;
      }
    }

    if (latestLocal === 0) return { status: 'local-only' };

    const drift = Math.abs(cloudTime - latestLocal);
    if (drift < 60000) return { status: 'synced' };

    if (cloudTime > latestLocal) {
      const ago = formatAgo(Date.now() - cloudTime);
      return { status: 'cloud-newer', ago };
    } else {
      const ago = formatAgo(Date.now() - latestLocal);
      return { status: 'local-newer', ago };
    }
  } catch {
    return null;
  }
}

function formatAgo(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Shortcuts, not a gate. Any string the user types that doesn't match an
// alias is passed through verbatim — the provider/harness validates it.
// PHEWSH must never block a model it hasn't heard of (it WILL go stale
// faster than the providers ship).
const MODELS = {
  'claude-fable': { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic' },
  'claude-opus': { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'anthropic' },
  'claude-sonnet': { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
  'claude-haiku': { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic' },
};

const DEFAULT_MODEL = 'claude-sonnet';

// currentModel may be an alias key OR a raw model id the user passed through.
function modelId(m) { return MODELS[m]?.id || m; }
function modelName(m) { return MODELS[m]?.name || m; }

// ── Routing: where plain typed input goes ─────────────────────────────────
// A route is either an installed harness (your existing subscription — no
// API key needed in phewsh) or the direct API (your key). Precedence:
// explicit config.defaultRoute → API key if set → first installed harness.

function resolveRoute(config, harnesses) {
  // Chat routing needs a headless-capable harness; interactive-only ones
  // (Hermes, Pi) are still detected and reachable via /work.
  const chatCapable = harnesses.filter(h => h.installed && h.headless);
  const preferred = config?.defaultRoute;
  if (preferred === 'api' && config?.apiKey) return { type: 'api' };
  if (preferred && chatCapable.some(h => h.id === preferred)) {
    return { type: 'harness', id: preferred };
  }
  if (config?.apiKey) return { type: 'api' };
  if (chatCapable.length > 0) return { type: 'harness', id: chatCapable[0].id };
  return null;
}

function routeLabel(route, config) {
  if (!route) return 'no route — /setup';
  if (route.type === 'api') {
    return `API (${config?.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'} key)`;
  }
  const h = HARNESSES[route.id];
  return `${h.label} (your ${h.auth.split(' / ')[0].toLowerCase()})`;
}

// ── Intent modes: "What are you trying to do?" ────────────────────────────
// Picked by number at the start of a session. Shapes the system prompt; the
// route stays whatever it is. Mode 5 is a route switcher, handled inline.

const INTENT_MODES = {
  1: { id: 'build',    label: 'Build',    hint: 'The user is in execution mode. Bias toward concrete next steps, working code, and shipping. Flag scope creep — it is their most common failure pattern.' },
  2: { id: 'research', label: 'Research', hint: 'The user is exploring. Compare options honestly, surface trade-offs, and say what you would pick and why. Do not pad.' },
  3: { id: 'decide',   label: 'Decide',   hint: 'The user needs to make a decision. Force clarity: name the actual decision, the options, the constraints from .intent/, and give one recommendation with reasoning. Small constrained choices beat big vague ones.' },
  4: { id: 'review',   label: 'Review',   hint: 'The user wants critical review. Find what is wrong or risky before praising anything. Be specific about severity.' },
};

const BARE_COMMANDS = {
  help: '/help',
  h: '/help',
  next: '/next',
  guide: '/next',
  recommend: '/next',
  tools: '/harnesses',
  tool: '/harnesses',
  agents: '/harnesses',
  harnesses: '/harnesses',
  routes: '/provider',
  route: '/provider',
  provider: '/provider',
  status: '/status',
  truth: '/truth',
  brief: '/brief',
  thread: '/thread',
  outcomes: '/outcomes',
  clarify: '/clarify',
  setup: '/setup',
  work: '/work',
  quit: '/quit',
  exit: '/quit',
};

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function saveConfig(config) {
  try {
    configFile.saveConfig(CONFIG_PATH, config);
    return true;
  } catch {
    return false;
  }
}

function buildSystemPrompt(intentFiles) {
  const base = `You are PHEWSH — a focused execution assistant. You help the user think clearly, build intentionally, and ship without drift. Be concise, direct, and opinionated. Respond in plain text, not markdown, unless the user asks for formatted output.`;

  if (intentFiles.length === 0) {
    return base + `\n\nNo .intent/ artifacts found in the current directory. The user hasn't set up project context yet — help them think through what they're building if they ask.`;
  }

  const sections = intentFiles.map(({ file, promptContent, content }) =>
    `## ${file}\n\n${(promptContent || content).trim()}`
  ).join('\n\n---\n\n');

  return `${base}\n\nThe user has structured intent artifacts for this project. Use them as primary context — stay aligned with their vision, plan, and next actions.\n\n${sections}`;
}

// Harness CLIs are one-shot — fold the recent conversation into the prompt
// so a session through Claude Code / Codex still feels continuous.
function buildHarnessPrompt(messages, input) {
  const tail = messages.slice(-6);
  if (tail.length === 0) return input;
  const transcript = tail
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`)
    .join('\n\n');
  return `Conversation so far:\n\n${transcript}\n\n---\n\nUser: ${input}\n\nRespond to the last user message.`;
}

async function streamChat(apiKey, messages, systemPrompt, modelId, opts = {}) {
  const body = { model: modelId, max_tokens: 2048, messages, stream: true };
  if (systemPrompt) body.system = systemPrompt;

  const spin = ui.spinner('thinking');

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    spin.stop();
    throw err;
  }

  if (!response.ok) {
    spin.stop();
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `API error ${response.status}`;
    if (response.status === 401 || msg.includes('invalid')) {
      throw new Error(`${msg}\n\n  Your API key may be invalid or expired. Run /key to update it.\n  Get a key at: https://console.anthropic.com/settings/keys`);
    }
    throw new Error(msg);
  }

  let fullResponse = '';
  let promptTokens = null;
  let completionTokens = null;
  let firstToken = true;

  // Line-buffered markdown render at a TTY; raw passthrough otherwise. The
  // spinner stops on first rendered output, not first raw token.
  const stopSpin = () => { if (firstToken) { spin.stop(); firstToken = false; } };
  const render = process.stdout.isTTY
    ? require('../lib/md').streamRenderer((out) => { stopSpin(); process.stdout.write(out); })
    : null;

  for await (const chunk of response.body) {
    const text = Buffer.from(chunk).toString('utf-8');
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          if (render) render.push(parsed.delta.text);
          else { stopSpin(); process.stdout.write(parsed.delta.text); }
          fullResponse += parsed.delta.text;
        }
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          promptTokens = parsed.message.usage.input_tokens;
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          completionTokens = parsed.usage.output_tokens;
        }
      } catch { /* skip */ }
    }
  }

  if (render) render.flush();
  if (firstToken) spin.stop();
  process.stdout.write('\n');

  return { content: fullResponse, promptTokens, completionTokens, model: modelId };
}

async function main() {
  let config = loadConfig();
  let intentFiles = loadIntentContext();
  let systemPrompt = buildSystemPrompt(intentFiles);
  const messages = [];
  let projectName = path.basename(process.cwd());

  // Index this project so `phewsh` from anywhere can offer it as a recent
  if (intentFiles.length > 0) {
    try { recordProject(process.cwd()); } catch { /* index is best-effort */ }
  }
  let currentModel = DEFAULT_MODEL;
  let harnessModel = null; // pass-through preference; the harness validates it
  let liveModelsCache = null; // fetched once per session from the provider's own list

  // Discovery, not hardcoding: the provider's models endpoint is the truth.
  async function fetchLiveModels() {
    if (liveModelsCache) return liveModelsCache;
    try {
      if (config?.provider === 'openrouter') {
        const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const data = await res.json();
          liveModelsCache = (data.data || []).map(m => m.id);
        }
      } else if (config?.apiKey) {
        const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
          headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = await res.json();
          liveModelsCache = (data.data || []).map(m => m.id);
        }
      }
    } catch { /* offline or no key — aliases still work */ }
    return liveModelsCache;
  }
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // ── Detect capabilities, resolve the route ──────────────
  const harnesses = listHarnesses();
  const installedHarnesses = harnesses.filter(h => h.installed);
  let route = resolveRoute(config, harnesses);
  let sessionMode = null;          // INTENT_MODES id once picked
  let awaitingOutcome = null;      // decision id eligible for 1-4 labeling
  let provisionalOutcome = null;   // verdict phewsh inferred from the diff — Enter ↵ confirms it
  let awaitingWhy = null;          // { id, outcome } — next line is the reason
  let awaitingReconcile = null;    // exact proposed append, applied only after y
  let lastTransitionReport = null; // latest native preflight -> postflight comparison
  let awaitingFallback = null;     // { input, fullSystem, options } after a route failure
  let bootstrapChoices = null;     // root-bootstrap menu entries when no project here
  let nextChoices = null;          // ranked /next suggestions awaiting a numeric pick
  let pendingDidYouMean = null;    // a suggested command; bare Enter accepts + runs it
  let decisionsThisSession = 0;
  let lastRouteCoachId = null;     // avoid repeating the same best-door hint

  // ── The Exhale: animated brand reveal ──────────────────
  await ui.brandReveal();

  // The welcome beat — warm, plain-language, and continuity-first. This is the
  // "you made it" moment that frames what phewsh is FOR: one thread across every
  // AI tool, so you switch harnesses mid-work and nothing gets re-explained.
  // Non-technical readers get one inviting sentence; the cockpit rows below give
  // engineers the exact facts. Fail-soft: a missing piece shortens the line, it
  // never blocks the door.
  (function welcome() {
    try {
      const toolCount = harnesses.filter(h => h.installed).length;
      const hasProject = intentFiles.length > 0;
      const dot = teal('●');
      const tools = `${toolCount} AI tool${toolCount !== 1 ? 's' : ''}`;
      if (hasProject && toolCount > 1) {
        console.log(`  ${dot} ${sage('phew — you made it.')} ${slate('shh,')} ${cream(projectName)} ${sage(`and your ${tools} are aligned to one thread`)} ${slate('— switch mid-thought, nothing re-explained.')}`);
      } else if (hasProject) {
        console.log(`  ${dot} ${sage('phew — you made it.')} ${slate('shh,')} ${sage('one verified memory of')} ${cream(projectName)} ${sage('— ready for whatever tool you reach for next.')}`);
      } else if (toolCount > 1) {
        console.log(`  ${dot} ${sage(`phew — you made it.`)} ${slate('shh,')} ${sage(`time to align your ${tools} to you and get down to business.`)} ${cream('/init')} ${sage('to begin.')}`);
      } else if (toolCount === 1) {
        console.log(`  ${dot} ${sage('phew — you made it.')} ${slate('shh,')} ${sage('add Codex or Gemini and phewsh keeps every tool aligned to you.')}`);
      } else {
        console.log(`  ${dot} ${sage('phew — you made it.')} ${slate('shh,')} ${sage('install Claude Code, Codex, or Gemini and phewsh keeps them aligned to you.')}`);
      }
      console.log('');
    } catch { /* the welcome is a flourish, never a blocker */ }
  })();

  if (config?.apiKey && !config.apiKey.startsWith('sk-')) {
    // Persist the cleanup so this never nags again — an unusable key
    // (not sk-…) helps nobody, and harness routes need no key at all.
    console.log(`  ${ember('!')} ${sage('Cleared an unusable stored API key.')} ${slate('harness routes need none — /key to add one')}`);
    console.log('');
    config.apiKey = null;
    try { saveConfig(config); } catch { /* read-only home — in-memory clear still holds */ }
    route = resolveRoute(config, harnesses);
  }

  // ── Mission control: the whole state of your AI work, one screen ──────
  // PROJECT what am I in · ROUTE where typing goes · BACKUP what's ready if
  // the route hits a wall · WEB am I mirrored · RECORD what's accumulated
  let syncState = null;
  const row = (label, value) => console.log(`  ${slate(label.padEnd(9))}${value}`);

  // realpath both sides — macOS /tmp and /var are symlinks into /private
  const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const tildify = (p) => {
    const home = realPath(os.homedir());
    const rp = realPath(p);
    return rp.startsWith(home) ? '~' + rp.slice(home.length) : p;
  };
  let atHome = false;
  let recents = [];

  // Fail-soft render: corrupt data or a network hiccup may cost a row —
  // it must never kill the session.
  try {
  if (config?.supabaseUserId && intentFiles.length > 0) {
    syncState = await Promise.race([
      checkSyncStatus(config),
      new Promise(resolve => setTimeout(() => resolve(null), 3000)),
    ]);
  }

  atHome = realPath(process.cwd()) === realPath(os.homedir());
  recents = intentFiles.length === 0
    ? listProjects().filter(p => realPath(p.path) !== realPath(process.cwd())).slice(0, 3)
    : [];

  if (intentFiles.length > 0) {
    row('PROJECT', cream(projectName) + slate(' · ') + teal('●')
      + sage(` .intent/ ${intentFiles.length} file${intentFiles.length !== 1 ? 's' : ''}`));
  } else if (atHome || recents.length > 0) {
    row('PROJECT', slate('none here — your projects are listed below'));
  } else {
    row('PROJECT', cream(projectName) + slate(' · no memory yet — ') + sage('/init') + slate(' fast · ') + sage('/clarify') + slate(' guided'));
  }

  row('ROUTE', route
    ? cream(routeLabel(route, config)) + (route.type === 'harness' ? slate(' · no API key needed') : '')
    : ember('none — /key or install an agent CLI'));

  const backups = harnesses.filter(h => h.installed && h.headless && !(route?.type === 'harness' && route.id === h.id));
  const workOnly = installedHarnesses.filter(h => !h.headless);
  const backupParts = backups.map(h => `${teal('✓')} ${sage(h.label)}`);
  if (config?.apiKey && route?.type !== 'api') backupParts.push(`${teal('✓')} ${sage('direct API')}`);
  workOnly.forEach(h => backupParts.push(sage(h.label) + slate(' /work')));
  row('BACKUP', backupParts.length > 0
    ? backupParts.join(slate(' · ')) + slate('  — context travels if the route hits a wall')
    : slate('none — install Codex or Gemini to cover usage limits'));

  if (config?.supabaseUserId) {
    // Cloud project count, best-effort with a hard 2s budget — the cockpit
    // never blocks on the network.
    let cloudCount = null;
    try {
      const token = await Promise.race([
        ensureValidToken(config),
        new Promise(r => setTimeout(() => r(null), 2000)),
      ]);
      if (token) {
        const rows = await Promise.race([
          select('projects', `user_id=eq.${config.supabaseUserId}&select=id`, token),
          new Promise(r => setTimeout(() => r(null), 2000)),
        ]);
        if (Array.isArray(rows)) cloudCount = rows.length;
      }
    } catch { /* offline — cockpit still renders */ }

    const syncLabel = syncState?.status === 'synced' ? teal('↕ ') + sage('mirrored')
      : syncState?.status === 'cloud-newer' ? ember('↓ ') + sage(`cloud newer (${syncState.ago}) — /pull`)
      : syncState?.status === 'local-newer' ? ember('↑ ') + sage('local ahead — /push')
      : sage('linked');
    row('WEB', cream(config.email || 'logged in') + slate(' · ') + syncLabel
      + (cloudCount !== null ? slate(' · ') + sage(`${cloudCount} cloud project${cloudCount !== 1 ? 's' : ''}`) : ''));
  } else {
    row('WEB', sage('local-only (works fine)') + slate(' · /login mirrors this at phewsh.com/intent'));
  }

  // VERIFIED — the product thesis made visible: what's actually true in this
  // repo right now, checked (not remembered). Fast + offline + fail-soft.
  try {
    const v = quickVerifiedState();
    if (!v.available) {
      row('VERIFIED', slate('not a git repo here — ') + sage('/truth') + slate(' audits whatever is present'));
    } else {
      const parts = [cream('HEAD ' + v.shortHead)];
      parts.push(v.dirtyCount ? peach(`${v.dirtyCount} uncommitted`) : sage('clean'));
      if (v.driftCommits > 0) parts.push(ember(`⚠ ${v.driftCommits} commit${v.driftCommits !== 1 ? 's' : ''} since .intent updated`));
      // Sharper than recency: the docs still name an older version than shipped.
      if (v.versionDrift) parts.push(ember(`⚠ .intent says ${v.versionDrift.claimed}, shipped ${v.versionDrift.shipped} — /reconcile`));
      row('VERIFIED', parts.join(slate(' · ')) + slate('  — /truth · /brief'));
    }
  } catch { /* the verified row is a glance, never a blocker */ }

  const oStats = outcomeStats();
  if (oStats.total > 0) {
    // Plain language: what phewsh has logged vs what you've taught it. The
    // kept-rate counts only the calls you actually judged (auto route-errors
    // don't drag it down) — see /outcomes for the full picture + payoff.
    const tail = oStats.judged > 0
      ? slate(' · ') + sage(`${Math.round((oStats.kept / oStats.judged) * 100)}% of what you judged, you kept`)
      : slate(' · ') + peach('none judged yet — tell it what you kept');
    row('RECORD', cream(`${oStats.total} routed`) + tail + slate(' — /outcomes'));
  } else {
    row('RECORD', slate('empty — phewsh starts logging what you route as you work'));
  }
  } catch (cockpitErr) {
    console.log(`  ${slate('(cockpit row unavailable — ' + cockpitErr.message + ' · PHEWSH_DEBUG=1 phewsh for details)')}`);
    if (process.env.PHEWSH_DEBUG) console.error(cockpitErr.stack);
  }

  // Chat-routable options as they exist on THIS machine — every usage hint
  // derives from this so /use, /provider, and reality never disagree.
  function useOptions() {
    const opts = harnesses.filter(h => h.installed && h.headless).map(h => h.id);
    if (config?.apiKey) opts.push('api');
    return opts;
  }

  function showModeMenu() {
    console.log(`  ${b(cream('What are you trying to do?'))}`);
    console.log(`  ${teal('1')} ${sage('Build')}  ${slate('·')}  ${teal('2')} ${sage('Research')}  ${slate('·')}  ${teal('3')} ${sage('Decide')}  ${slate('·')}  ${teal('4')} ${sage('Review')}  ${slate('·')}  ${teal('5')} ${sage('Ask another model')}`);
    console.log(`  ${slate('pick a number, or just type — your context travels with every route')}`);
    // One quiet line to the deeper power, without dumping the whole command list:
    // the moves that make phewsh more than a chat box — true continuity across
    // harnesses. /help opens everything when they're ready.
    console.log(`  ${slate('⌄ deeper:')} ${cream('/work')} ${slate('hand to a tool')} ${slate('·')} ${cream('/council')} ${slate('ask them all')} ${slate('·')} ${cream('/handoff')} ${slate('what carries over')} ${slate('·')} ${cream('/help')} ${slate('all')}`);
  }

  // Self-aware guidance: snapshot the session's state so phewsh can recommend
  // the one next step worth taking, instead of leaving the user to know commands.
  function buildSuggestState() {
    let seqStale = false;
    try {
      const cwd = process.cwd();
      const claudePath = path.join(cwd, 'CLAUDE.md');
      const intentDir = path.join(cwd, '.intent');
      if (fs.existsSync(claudePath) && fs.existsSync(intentDir)) {
        const claudeT = fs.statSync(claudePath).mtimeMs;
        const newestIntent = fs.readdirSync(intentDir)
          .filter(f => f.endsWith('.md') || f.endsWith('.json'))
          .reduce((m, f) => Math.max(m, fs.statSync(path.join(intentDir, f)).mtimeMs), 0);
        seqStale = newestIntent > claudeT + 1000; // >1s newer = drift
      }
    } catch { /* drift detection is best-effort */ }

    let ambientOn = false;
    try {
      const s = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf-8');
      ambientOn = s.includes('phewsh hook session-start');
    } catch { /* no settings = ambient off */ }

    let shimOn = false;
    try { shimOn = require('../lib/shims').shimStatus().installed.length > 0; } catch { /* shims off */ }

    let packsInstalled = false;
    try {
      const { PACKS, isInstalled } = require('../lib/packs');
      packsInstalled = Object.keys(PACKS).some(name => isInstalled(name));
    } catch { /* packs nudge is optional */ }

    let pending = 0;
    // Only substantive calls — never nag the user to "judge" a greeting.
    try { pending = pendingDecisions({ project: projectName, substantive: true }).length; } catch { /* best-effort */ }

    let installed = [];
    try { installed = listHarnesses().filter(h => h.installed).map(h => h.id); } catch { /* best-effort */ }

    let bestKeeper = null;
    try {
      const br = learning.bestRoute(outcomeStats({ project: projectName }), { minSample: 4 });
      if (br) bestKeeper = { route: br.route, label: continuity.labelFor(br.route), keptRate: br.keptRate, total: br.total };
    } catch { /* best-effort */ }

    return {
      hasIntentDir: fs.existsSync(path.join(process.cwd(), '.intent')),
      intentFileCount: intentFiles.length,
      pendingOutcomes: pending,
      installedHarnesses: installed,
      route: route?.id || route,
      turnsThisSession: Math.floor(messages.length / 2),
      seqStale,
      ambientOn,
      shimOn,
      packsInstalled,
      commitsSinceIntent: (() => { try { return selfheal.commitsSinceIntent(); } catch { return 0; } })(),
      bestKeeper,
    };
  }

  // Self-healing continuity on entry: if any existing harness projection
  // drifted, quietly refresh every managed block from the same canonical core.
  function maybeHealOnEntry() {
    try {
      if (!selfheal.isStale()) return;
      const h = selfheal.heal();
      if (h.healed) console.log(`  ${teal('↻')} ${sage('Synced .intent/ across your harness files — kept current automatically')}`);
    } catch { /* self-heal is a nicety, never a blocker */ }
  }

  // "Nothing lost" — surface where you left off, across every tool, so opening
  // phewsh feels like resuming a thread rather than starting cold.
  function showContinuity() {
    try {
      const decisions = recentDecisions(50, { project: projectName });
      const line = continuity.continuityLine(decisions, { project: projectName });
      if (!line) return;
      const tools = continuity.toolsInThread(decisions, { project: projectName });
      const span = tools >= 2 ? slate(` · ${tools} tools, one thread`) : '';
      console.log(`  ${teal('↻')} ${sage('Picking up — ' + line)}${span} ${slate('· /thread')}`);
      console.log(''); // breathe before "What are you trying to do?"
    } catch { /* continuity is a nicety, never a blocker */ }
  }

  // One subtle line under the menu — the single highest-leverage nudge, if any.
  function showInlineTip(filter = null) {
    let tip = null;
    try { tip = suggest(buildSuggestState()); } catch { /* never block the prompt on guidance */ }
    if (!tip) return;
    if (filter && !filter(tip)) return;
    console.log(`  ${teal('⤷')} ${sage(tip.message)} ${cream(tip.command.trim())} ${slate('· /next for options')}`);
  }

  // The front door should steer, not trap. For a plain-language ask, point to
  // the better native door when the pattern is obvious, then still run the turn.
  function showRouteCoach(input) {
    try {
      const advice = routeCoach(input, {
        route,
        harnesses,
        hasIntentDir: intentFiles.length > 0,
        turnsThisSession: Math.floor(messages.length / 2),
      });
      if (!advice || advice.id === lastRouteCoachId) return;
      lastRouteCoachId = advice.id;
      console.log(`  ${peach('↪')} ${sage(advice.message)} ${cream(advice.command)} ${slate('· still sending this turn')}`);
    } catch { /* route coaching is advisory, never a blocker */ }
  }

  // Open a known project from the bootstrap menu: chdir, reload memory,
  // back to the normal flow. The session is the cockpit; projects swap in.
  function openProjectAt(dir) {
    try { process.chdir(dir); } catch (err) {
      console.log(`  ${ember('!')} ${sage('Could not open ' + dir + ': ' + err.message)}`);
      return;
    }
    projectName = path.basename(dir);
    intentFiles = loadIntentContext();
    systemPrompt = buildSystemPrompt(intentFiles);
    try { recordProject(dir); } catch { /* best-effort */ }
    bootstrapChoices = null;
    console.log('');
    if (intentFiles.length === 0) {
      // A candidate, not yet a project — invite intent, don't fake context.
      console.log(`  ${teal('●')} ${cream(projectName)} ${slate('·')} ${sage('no .intent/ yet')} ${slate('· via ' + routeLabel(route, config))}`);
      console.log(`  ${sage('Ground it:')} ${cream('/init')} ${sage('two questions, instant artifacts')} ${slate('·')} ${cream('/clarify')} ${sage('guided — compiles your messy idea into a spec')}`);
    } else {
      console.log(`  ${teal('●')} ${cream(projectName)} ${slate('·')} ${sage(`.intent/ ${intentFiles.length} file${intentFiles.length !== 1 ? 's' : ''} loaded`)} ${slate('· via ' + routeLabel(route, config))}`);
    }
    console.log('');
    maybeHealOnEntry();
    showContinuity();
    showModeMenu();
    showInlineTip();
    console.log('');
  }

  // The project scanner — bootstrap option AND /scan slash command. Lists
  // .intent/ projects plus likely candidates (git, no .intent yet, reason
  // shown) from the usual folders, numbered so a bare digit opens one.
  function runScanMenu() {
    const spin = ui.spinner('scanning your usual folders');
    const found = scanForProjects();
    let candidates = [];
    try { candidates = scanForCandidates(); } catch { /* advisory — scan still useful without it */ }
    spin.stop();
    if (found.length === 0 && candidates.length === 0) {
      bootstrapChoices = null;
      console.log(`  ${sage('No .intent/ projects found in the usual folders.')}`);
      console.log(`  ${slate('cd into a project and run phewsh, or /init to start one here.')}`);
      return;
    }
    bootstrapChoices = [];
    if (found.length > 0) {
      console.log(`  ${teal('●')} ${sage(`Found ${found.length} project${found.length !== 1 ? 's' : ''} with .intent/:`)}`);
      for (const p of found) {
        bootstrapChoices.push({ kind: 'open', path: p.path });
        console.log(`  ${teal(String(bootstrapChoices.length))} ${cream(p.name)} ${slate('· ' + tildify(p.path))}`);
      }
    }
    if (candidates.length > 0) {
      console.log(`  ${teal('●')} ${sage(`${candidates.length} likely candidate${candidates.length !== 1 ? 's' : ''} — no shared memory yet:`)}`);
      for (const p of candidates) {
        bootstrapChoices.push({ kind: 'open', path: p.path });
        console.log(`  ${teal(String(bootstrapChoices.length))} ${cream(p.name)} ${slate('· ' + tildify(p.path) + ' · ' + p.reason)}`);
      }
    }
    console.log(`  ${slate('pick a number to open it')}`);
  }

  function showBootstrapMenu(projects) {
    console.log(`  ${b(cream('Where do you want to work?'))}`);
    bootstrapChoices = [];
    for (const p of projects) {
      bootstrapChoices.push({ kind: 'open', path: p.path });
      console.log(`  ${teal(String(bootstrapChoices.length))} ${cream(p.name)} ${slate('— ' + fmtAgo(p.lastOpened) + ' · ' + tildify(p.path))}`);
    }
    bootstrapChoices.push({ kind: 'init' });
    const initN = bootstrapChoices.length;
    bootstrapChoices.push({ kind: 'scan' });
    console.log(`  ${teal(String(initN))} ${sage('Start a project here')} ${slate('(/init)')}  ${slate('·')}  ${teal(String(initN + 1))} ${sage('Scan my folders for projects')}`);
    console.log(`  ${slate('pick a number, or just type to chat — no project required')}`);
  }

  console.log('');
  if (!route) {
    // Nothing to route through: no key, no agent CLIs found on this machine.
    console.log(`  ${b(cream('Two ways to get running:'))}`);
    console.log(`  ${slate('No agent CLI found (Claude Code, Codex, Gemini, Cursor, OpenCode) and no API key yet.')}`);
    console.log('');
    console.log(`    ${teal('/key')}    ${sage('Set an API key (10 seconds)')}`);
    console.log(`    ${teal('/tour')}   ${sage('See what this does (nothing needed)')}`);
    console.log(`  ${slate('Or install Claude Code / Codex — phewsh uses their login automatically.')}`);
  } else if (intentFiles.length === 0 && (atHome || recents.length > 0)) {
    showBootstrapMenu(recents);
  } else {
    maybeHealOnEntry();
    showContinuity();
    showModeMenu();
    showInlineTip();
  }
  console.log('');

  // ── Turn runners — every route records a decision, leaves a receipt ────
  // Both return true on success so the fallback flow can chain them.
  const failureTracker = createFailureTracker();
  let lastTurnFailure = null;

  // The gate looking backward: if this is close to something you already
  // reverted or failed, say so once — quietly, before the turn runs.
  let lastRecallId = null;
  function recallHeadsUp(input) {
    try {
      const past = recentDecisions(300, { project: projectName });
      const hit = recall.closestRegret(past, input, { project: projectName, minSimilarity: 0.5 });
      if (!hit || hit.id === lastRecallId) return;
      lastRecallId = hit.id;
      let s = (hit.summary || '').replace(/\s+/g, ' ');
      if (s.length > 50) s = s.slice(0, 49).trimEnd() + '…';
      const verb = hit.outcome === 'failed' ? 'failed' : 'reverted';
      console.log(`  ${peach('↩')} ${sage(`You ${verb} something close before:`)} ${slate('“' + s + '” · via ' + continuity.labelFor(hit.route) + ' · ' + continuity.agoText(hit.ts))}`);
      if (hit.why) console.log(`  ${slate('  why it didn\'t hold: ')}${sage(hit.why)}`);
      console.log(`  ${slate('  not a block — just so the record doesn\'t let you repeat it blind.')}`);
    } catch { /* recall is advisory, never blocks a turn */ }
  }

  async function runHarnessTurn(input, harnessId, fullSystem) {
    recallHeadsUp(input);
    const decisionId = recordDecision({
      project: projectName, route: harnessId, mode: sessionMode, summary: input,
    });
    decisionsThisSession++;
    try {
      turnInFlight = true;
      const output = await runViaHarness(harnessId, fullSystem, buildHarnessPrompt(messages, input), { model: harnessModel });
      turnInFlight = false;
      userCancelled = false; // a SIGTERM the harness rode out must not mislabel the next turn
      messages.push({ role: 'user', content: input });
      messages.push({ role: 'assistant', content: (output || '').trim() });
      recordSessionEvent(harnessId, projectName, 'task_complete', {
        taskId: decisionId, success: true, summary: input.slice(0, 140),
      });
      lastTurnFailure = null;
      awaitingOutcome = decisionId;
      console.log(slate(`  via ${HARNESSES[harnessId].label} · how'd it go? 1 kept · 2 undid · 3 redid · 4 flopped · or keep typing`));
      showInlineTip((tip) => tip.id === 'capture-intent');
      return true;
    } catch (err) {
      turnInFlight = false;
      if (userCancelled) {
        userCancelled = false;
        console.log(`\n  ${slate('cancelled — esc')}`);
        return true; // user's call, not a failure: no fallback offer
      }
      try { labelOutcome(decisionId, 'failed', null, { auto: true }); } catch { /* keep going */ }
      recordSessionEvent(harnessId, projectName, 'task_complete', {
        taskId: decisionId, success: false, summary: input.slice(0, 140),
      });
      const failure = failureTracker.classify(harnessId, err.message);
      lastTurnFailure = { ...failure, harnessId };
      if (!failure.duplicate) {
        console.error(`\n  ${ember('!')} ${cream(HARNESSES[harnessId].label)} ${sage(failure.kind === 'usage-limit' ? 'hit a usage wall' : 'failed')}${slate(' — ' + err.message.split('\n')[0])}`);
      }
      return false;
    }
  }

  async function runApiTurn(input, fullSystem) {
    recallHeadsUp(input);
    const decisionId = recordDecision({
      project: projectName, route: 'api', mode: sessionMode, summary: input,
    });
    decisionsThisSession++;
    messages.push({ role: 'user', content: input });
    console.log('');
    try {
      turnInFlight = true;
      turnAbort = new AbortController();
      const result = await streamChat(config.apiKey, messages, fullSystem, modelId(currentModel), { signal: turnAbort.signal });
      turnInFlight = false;
      turnAbort = null;
      messages.push({ role: 'assistant', content: result.content });
      if (result.promptTokens) totalPromptTokens += result.promptTokens;
      if (result.completionTokens) totalCompletionTokens += result.completionTokens;
      if (result.promptTokens || result.completionTokens) {
        console.log(slate(`  ${result.promptTokens || '?'}→${result.completionTokens || '?'} tokens · ${modelName(currentModel)} · how'd it go? 1-4 or keep typing`));
      }
      awaitingOutcome = decisionId;
      trackSap({
        userId: config.supabaseUserId,
        source: 'cli',
        model: modelId(currentModel),
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        accessToken: config.supabaseAccessToken,
      });
      showInlineTip((tip) => tip.id === 'capture-intent');
      return true;
    } catch (err) {
      turnInFlight = false;
      turnAbort = null;
      if (userCancelled || err.name === 'AbortError') {
        userCancelled = false;
        messages.pop();
        console.log(`\n  ${slate('cancelled — esc')}`);
        return true; // user's call, not a failure: no fallback offer
      }
      try { labelOutcome(decisionId, 'failed', null, { auto: true }); } catch { /* keep going */ }
      messages.pop();
      console.error(`\n  ${ember('!')} ${sage('API route failed')}${slate(' — ' + err.message.split('\n')[0])}`);
      return false;
    }
  }

  // Fallbacks are a first-class flow: the route changes, the context and
  // record do not. Ask by default; auto-switch only if setup said so.
  async function offerFallbacks(input, fullSystem, failedId) {
    if (lastTurnFailure?.duplicate && lastTurnFailure.harnessId === failedId) {
      return;
    }

    const options = harnesses
      .filter(h => h.installed && h.headless && h.id !== failedId)
      .map(h => h.id);
    if (config?.apiKey && failedId !== 'api') options.push('api');
    if (lastTurnFailure?.kind === 'usage-limit' && lastTurnFailure.harnessId === failedId) {
      options.push(failedId);
    }

    if (options.length === 0) {
      console.log(`  ${sage('No fallback ready.')} ${slate('Install Codex or Gemini, or add an API key with /key — context would travel automatically.')}`);
      console.log('');
      return;
    }

    if (config?.fallback === 'auto') {
      const fb = options[0];
      const fbLabel = fb === 'api' ? 'direct API' : HARNESSES[fb].label;
      console.log(`  ${peach('↻')} ${sage('auto-fallback →')} ${cream(fbLabel)} ${slate('· same context, same record')}`);
      const ok = fb === 'api'
        ? await runApiTurn(input, fullSystem)
        : await runHarnessTurn(input, fb, fullSystem);
      if (!ok) console.log(`  ${ember('!')} ${sage('Fallback failed too — /provider to inspect routes.')}`);
      console.log('');
      return;
    }

    const list = options.map((id, i) =>
      `${teal(String(i + 1))} ${sage(id === 'api'
        ? 'direct API (your key)'
        : id === failedId ? HARNESSES[id].label + ' (retry once)' : HARNESSES[id].label)}`
    ).join(slate(' · '));
    if (lastTurnFailure?.kind === 'usage-limit' && lastTurnFailure.harnessId === failedId) {
      const codexReady = options.includes('codex');
      console.log(`  ${sage(codexReady ? '/use codex switches the session now, or retry Claude once below.' : 'You can retry this route once below, or /use another installed route.')}`);
    }
    console.log(`  ${sage('Retry with your context intact:')} ${list} ${slate('· enter = skip')}`);
    console.log(`  ${slate('prefer auto-switching? phewsh setup sets it once')}`);
    awaitingFallback = { input, fullSystem, options };
    console.log('');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `  ${teal('phewsh')} ${sage('>')} `,
    historySize: 100,
    history: cmdHistory.loadForReadline(100),  // up-arrow remembers across sessions
  });
  const promptText = `  phewsh > `;
  let lastPaste = null;

  function currentContextTokens() {
    const conversation = messages.map(message => message.content).join('\n');
    return estimateTokens(`${systemPrompt}\n${conversation}`);
  }

  // One quiet line, Claude Code-bar style: route + model · context gauge ·
  // mode. Hints live in /help — the rail is glanceable state, not a manual.
  function renderStatusRail() {
    if (!process.stdout.isTTY) return;
    const folder = relativeFolder(process.cwd(), os.homedir());
    const routeName = route?.type === 'harness' ? HARNESSES[route.id].label : routeLabel(route, config);
    const model = route?.type === 'harness'
      ? (harnessModel || 'default model')
      : modelName(currentModel);
    const tokens = currentContextTokens();
    const pct = Math.min(99, Math.round((tokens / 200000) * 100));
    const bar = '█'.repeat(Math.max(1, Math.round(pct / 10))) + '░'.repeat(10 - Math.max(1, Math.round(pct / 10)));
    const modeLabel = sessionMode
      ? Object.values(INTENT_MODES).find(m => m.id === sessionMode)?.label.toLowerCase()
      : 'open';
    console.log(`  ${slate(folder)} ${slate('│')} ${cream(routeName)} ${slate(model)} ${slate('│')} ${slate(bar)} ${slate(pct + '%')} ${slate('│')} ${sage('⏵ ' + modeLabel)} ${slate('(shift+tab)')}`);
  }

  const readlinePrompt = rl.prompt.bind(rl);
  rl.prompt = function promptWithStatusRail(preserveCursor) {
    renderStatusRail();
    return readlinePrompt(preserveCursor);
  };

  function collapsePastedEcho(lines, input) {
    if (!process.stdout.isTTY || !shouldCollapsePaste(lines, input)) return;
    const rows = echoedRows(lines, promptText, process.stdout.columns || 80);
    for (let i = 0; i < rows; i++) process.stdout.write('\x1b[1A\x1b[2K\r');
    lastPaste = input;
    console.log(`  ${peach(formatPasteSummary(input, lines.length))}`);
  }

  // Live input coloring — like Claude Code: text stays normal, and only a
  // RECOGNIZED leading /command (or @harness) token turns teal (peach for @)
  // so you know it registered. Arguments stay plain. TTY-only, fail-soft.
  const KNOWN_COMMANDS = new Set([
    'quit', 'exit', 'q', 'help', 'h', 'init', 'intent', 'clarify', 'scan', 'model',
    'models', 'council', 'all', 'provider', 'route', 'use', 'work', 'switch', 'run',
    'clear', 'status', 'key', 'login', 'export', 'push', 'pull', 'serve',
    'sync', 'harnesses', 'fallback', 'outcomes', 'tour', 'update', 'upgrade',
    'agents', 'context', 'truth', 'brief', 'wrap', 'reconcile', 'gate', 'reload', 'sequence', 'seq', 'setup', 'system', 'watch',
    'next', 'recommend', 'guide', 'thread', 'continuity', 'learn', 'stats',
    'pack', 'packs', 'remember', 'commands', 'width', 'handoff',
  ]);
  const installedIds = harnesses.filter(h => h.installed).map(h => h.id);
  let turnAbort = null;       // AbortController while an API turn streams
  let turnInFlight = false;   // any route — ESC cancels
  let userCancelled = false;  // distinguishes esc from real failures

  function colorizeInput(cur) {
    const tok = cur.slice(1).split(/\s/)[0].toLowerCase();
    if (!tok) return null;
    if (cur[0] === '/' && KNOWN_COMMANDS.has(tok)) {
      return `\x1b[38;5;79m/${cur.slice(1, 1 + tok.length)}\x1b[0m${cur.slice(1 + tok.length)}`;
    }
    if (cur[0] === '@' && installedIds.some(id => id === tok || id.startsWith(tok))) {
      return `\x1b[38;5;216m@${cur.slice(1, 1 + tok.length)}\x1b[0m${cur.slice(1 + tok.length)}`;
    }
    return null;
  }

  if (process.stdout.isTTY && typeof rl._writeToOutput === 'function') {
    const origWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = function (s) {
      try {
        const cur = rl.line || '';
        if (typeof s === 'string' && cur && s.includes(cur)) {
          const colored = colorizeInput(cur);
          if (colored) s = s.split(cur).join(colored);
        }
      } catch { /* never break input */ }
      origWrite(s);
    };
  }

  // ── Bracketed paste: like Claude Code, a paste lands in the input line as
  // a collapsed placeholder and NEVER auto-submits — Enter sends it. The
  // terminal marks paste boundaries (\x1b[200~ … \x1b[201~); Node's keypress
  // decoder surfaces them as paste-start/paste-end. While pasting we detach
  // readline so embedded newlines can't fire 'line' events.
  const PASTE_ON = '\x1b[?2004h';
  const PASTE_OFF = '\x1b[?2004l';
  let pasting = false;
  let pasteChunks = [];
  let detachedListeners = null;
  let pasteCounter = 0;
  const pendingPastes = new Map();

  function pasteMode(on) {
    if (process.stdout.isTTY) process.stdout.write(on ? PASTE_ON : PASTE_OFF);
  }

  // Substitute placeholders back to the real pasted text at submit time.
  function expandPastes(input) {
    let out = input;
    for (const [tag, text] of pendingPastes) {
      if (out.includes(tag)) {
        out = out.split(tag).join(text);
        pendingPastes.delete(tag);
      }
    }
    return out;
  }

  let wasSpecialInput = false; // recolor must also fire when the token STOPS matching

  if (process.stdin.isTTY) {
    const phewshKeypress = (str, key) => {
      try {
        // Paste interception comes first — everything inside the paste is data.
        if (key && key.name === 'paste-start') {
          pasting = true;
          pasteChunks = [];
          detachedListeners = process.stdin.listeners('keypress').filter(l => l !== phewshKeypress);
          for (const l of detachedListeners) process.stdin.removeListener('keypress', l);
          return;
        }
        if (pasting) {
          if (key && key.name === 'paste-end') {
            pasting = false;
            for (const l of detachedListeners || []) process.stdin.on('keypress', l);
            detachedListeners = null;
            const text = pasteChunks.join('');
            pasteChunks = [];
            if (!text) return;
            const lineCount = text.split('\n').length;
            if (lineCount > 1 || text.length > 200) {
              pasteCounter++;
              const chars = text.length.toLocaleString('en-US');
              const tag = lineCount > 1
                ? `[paste #${pasteCounter}: ${chars} chars, ${lineCount} lines]`
                : `[paste #${pasteCounter}: ${chars} chars]`;
              pendingPastes.set(tag, text);
              lastPaste = text;
              rl.write(tag);
            } else {
              rl.write(text);
            }
            return;
          }
          pasteChunks.push(str !== undefined && str !== null ? String(str) : (key && key.sequence) || '');
          return;
        }

        if (key?.ctrl && key.name === 'o' && lastPaste) {
          setImmediate(() => {
            rl.line = '';
            rl.cursor = 0;
            process.stdout.write('\x1b[2K\r');
            console.log(`  ${b(cream('Last paste'))} ${slate(`(${lastPaste.length.toLocaleString('en-US')} chars)`)}`);
            console.log(lastPaste.split('\n').map(line => `  ${line}`).join('\n'));
            console.log('');
            rl.prompt();
          });
          return;
        }
        // shift+tab cycles the session mode — open → build → research → decide → review
        if (key && key.name === 'tab' && key.shift) {
          const ids = [null, ...Object.values(INTENT_MODES).map(m => m.id)];
          const next = ids[(ids.indexOf(sessionMode) + 1) % ids.length];
          sessionMode = next;
          const label = next ? Object.values(INTENT_MODES).find(m => m.id === next).label : 'Open';
          process.stdout.write('\x1b[2K\r');
          console.log(`  ${teal('⏵')} ${sage('mode:')} ${cream(label.toLowerCase())}${next ? slate(' — ' + 'shapes how routes respond') : slate(' — no slant')}`);
          rl.prompt();
          return;
        }
        // ESC: cancel an in-flight turn, or clear the input line.
        if (key && key.name === 'escape') {
          if (turnInFlight) {
            userCancelled = true;
            process.stdout.write('\n  \x1b[38;5;247mcancelling…\x1b[0m\n');
            if (turnAbort) turnAbort.abort();
            cancelActive();
          } else if (rl.line) {
            rl.line = '';
            rl.cursor = 0;
            rl._refreshLine();
          }
          return;
        }
        // Re-render so token coloring tracks edits — including the keystroke
        // where the token stops matching and must un-color. Deferred one tick:
        // this is a prependListener, so readline hasn't appended the just-typed
        // char yet; without the defer, rl.line is stale by one and /model only
        // ever evaluates as /mode.
        setImmediate(() => {
          try {
            const cur = rl.line || '';
            const special = cur[0] === '/' || cur[0] === '@';
            if (special || wasSpecialInput) rl._refreshLine();
            wasSpecialInput = special;
          } catch { /* never break input */ }
        });
      } catch { /* never break input */ }
    };
    process.stdin.prependListener('keypress', phewshKeypress);
    pasteMode(true);
    process.on('exit', () => pasteMode(false)); // never leave the terminal in paste mode
  }

  rl.prompt();

  async function handleInput(input) {
    input = expandPastes(input);

    // Answering the "why?" prompt — the whole line is the reason, not a command.
    if (awaitingWhy) {
      const { id, outcome } = awaitingWhy;
      awaitingWhy = null;
      try { labelOutcome(id, outcome, input); console.log(`  ${slate('noted — the record will remember why.')}`); } catch { /* gone */ }
      console.log('');
      rl.prompt();
      return;
    }

    // /reconcile confirmation: apply only the exact diff the user just saw.
    if (awaitingReconcile) {
      const proposal = awaitingReconcile;
      awaitingReconcile = null;
      if (/^(y|yes)$/i.test(input.trim())) {
        const r = applyReconciliation(proposal);
        if (r.written) {
          const synced = (selfheal.syncContextFiles().synced) || [];
          intentFiles = loadIntentContext();
          systemPrompt = buildSystemPrompt(intentFiles);
          console.log(`  ${green('✓')} ${sage('Applied the approved diff to ' + r.target + '.')}`);
          console.log(`  ${slate(synced.length ? 'Synced every tool from the approved change: ' + synced.join(', ') + '.' : 'Intent updated; tool context already current.')}`);
        } else {
          console.log(`  ${ember('!')} ${sage('Reconciliation was not applied: ' + r.reason)}`);
        }
      } else {
        console.log(`  ${slate('No authoritative files were changed.')}`);
      }
      console.log('');
      rl.prompt();
      return;
    }

    // Any typed input supersedes a pending "did you mean" offer.
    if (pendingDidYouMean) pendingDidYouMean = null;

    // Exact bare words are front-door controls too. Keep this exact-match only:
    // "help" opens help; "help me build X" still routes as natural language.
    if (!input.startsWith('/')) {
      const bare = input.trim().toLowerCase();
      if (BARE_COMMANDS[bare]) {
        await handleInput(BARE_COMMANDS[bare]);
        return;
      }
    }

    // A bare number right after a route failure picks the fallback
    if (awaitingFallback) {
      const af = awaitingFallback;
      awaitingFallback = null;
      const n = parseInt(input, 10);
      if (n >= 1 && n <= af.options.length) {
        const fb = af.options[n - 1];
        const ok = fb === 'api'
          ? await runApiTurn(af.input, af.fullSystem)
          : await runHarnessTurn(af.input, fb, af.fullSystem);
        if (!ok) await offerFallbacks(af.input, af.fullSystem, fb);
        console.log('');
        rl.prompt();
        return;
      }
      // anything else: drop the offer and treat it as fresh input
    }

    // Enter ↵ confirms the provisional verdict phewsh inferred from the diff —
    // ambient capture so you never have to remember to run /outcomes.
    if (awaitingOutcome && provisionalOutcome && input.trim() === '') {
      const outcome = provisionalOutcome;
      try {
        labelOutcome(awaitingOutcome, outcome);
        console.log(`  ${teal('●')} ${sage('outcome:')} ${green(outcome)} ${slate('· confirmed')}`);
      } catch { /* decision vanished */ }
      awaitingOutcome = null; provisionalOutcome = null;
      console.log('');
      rl.prompt();
      return;
    }
    // Typed something other than a verdict? They've moved on — drop the
    // provisional so a later stray Enter can't auto-confirm it.
    if (awaitingOutcome && provisionalOutcome && input.trim() !== '' && !/^[1-4]$/.test(input.trim())) {
      provisionalOutcome = null;
    }

    // A bare 1-4 right after a routed action labels its outcome
    if (awaitingOutcome && /^[1-4]$/.test(input)) {
      const outcome = OUTCOMES[parseInt(input, 10) - 1];
      let labeled = null;
      try {
        labeled = labelOutcome(awaitingOutcome, outcome);
        const color = outcome === 'kept' ? green : outcome === 'superseded' ? peach : ember;
        console.log(`  ${teal('●')} ${sage('outcome:')} ${color(outcome)}`);
      } catch { /* decision vanished — nothing to do */ }
      const id = awaitingOutcome;
      awaitingOutcome = null;
      provisionalOutcome = null;
      // For a regret, the reason is the gold — capture one line so /recall can
      // tell you *why* next time. Kept/superseded stay frictionless.
      if (labeled && (outcome === 'reverted' || outcome === 'failed')) {
        awaitingWhy = { id, outcome };
        console.log(`  ${slate('why? one line — feeds /recall next time · enter to skip')}`);
        rl.prompt();
        return;
      }
      console.log('');
      rl.prompt();
      return;
    }

    // /next pick: a bare number runs the chosen suggestion (slash = in place).
    // Any non-digit input means the user moved on — drop the offer so it never
    // shadows a later mode pick.
    if (nextChoices && !/^[0-9]$/.test(input)) nextChoices = null;
    if (nextChoices && /^[0-9]$/.test(input)) {
      const pick = nextChoices[parseInt(input, 10) - 1];
      if (!pick) {
        console.log(`  ${sage('Pick 1-' + nextChoices.length + ', or keep typing')}`);
        rl.prompt();
        return;
      }
      const command = pick.command.trim();
      nextChoices = null;
      if (command.startsWith('/')) {
        await handleInput(command);   // re-dispatch the slash command in place
        return;
      }
      console.log(`  ${teal('⤷')} ${sage('run this in your shell:')} ${cream(command)}`);
      console.log('');
      rl.prompt();
      return;
    }

    // Scan/bootstrap menu: a bare number opens a project, inits, or scans.
    // Any other input means the user moved on — drop the menu so it never
    // shadows a later digit (mirrors the nextChoices rule above).
    if (bootstrapChoices && !/^[0-9]{1,2}$/.test(input)) bootstrapChoices = null;
    if (bootstrapChoices && /^[0-9]{1,2}$/.test(input)) {
      const choice = bootstrapChoices[parseInt(input, 10) - 1];
      if (!choice) {
        console.log(`  ${sage('Pick 1-' + bootstrapChoices.length)}`);
        rl.prompt();
        return;
      }
      if (choice.kind === 'open') {
        openProjectAt(choice.path);
        rl.prompt();
        return;
      }
      if (choice.kind === 'init') {
        bootstrapChoices = null;
        try {
          const { execSync } = require('child_process');
          execSync('node ' + path.join(__dirname, 'intent.js') + ' --init', { stdio: 'inherit' });
          intentFiles = loadIntentContext();
          systemPrompt = buildSystemPrompt(intentFiles);
          if (intentFiles.length > 0) {
            try { recordProject(process.cwd()); } catch { /* best-effort */ }
            console.log(`  ${teal('●')} ${sage('Project started — context loaded:')} ${cream(intentFiles.map(f => f.file).join(', '))}`);
          }
        } catch (err) {
          console.error(`  ${ember('!')} ${sage('Init failed:')} ${err.message}`);
        }
        console.log('');
        rl.prompt();
        return;
      }
      if (choice.kind === 'scan') {
        runScanMenu();
        console.log('');
        rl.prompt();
        return;
      }
    }

    // A bare 1-5 on an empty conversation picks an intent mode
    if (messages.length === 0 && !awaitingOutcome && /^[1-5]$/.test(input)) {
      const n = parseInt(input, 10);
      if (n === 5) {
        console.log('');
        console.log(`  ${b(cream('Ask another model — switch the route'))}`);
        let mStats = null, best = null;
        try {
          mStats = outcomeStats({ project: projectName });
          best = learning.bestRoute(mStats, { minSample: 3 });
        } catch { /* best-effort */ }
        // Only celebrate a route that actually holds up (≥50% kept) — a star on
        // a poor rate would be dishonest. The badge shows regardless.
        const starRoute = best && best.keptRate >= 0.5 ? best.route : null;
        for (const h of harnesses) {
          if (!h.installed) continue;
          const badge = mStats ? learning.keptBadge(mStats, h.id) : '';
          const star = starRoute === h.id ? ` ${green('★ keeps best')}` : '';
          const rec = badge ? ` ${slate('· ' + badge)}` : '';
          console.log(`    ${teal('/use ' + h.id.padEnd(12))} ${sage(h.label)} ${slate('(' + h.auth + ')')}${rec}${star}`);
        }
        if (config?.apiKey) console.log(`    ${teal('/use api'.padEnd(17))} ${sage('Direct API')} ${slate('(your key)')}`);
        if (starRoute) console.log(`  ${slate('★ = highest kept-rate in your record so far')}`);
        console.log('');
        rl.prompt();
        return;
      }
      sessionMode = INTENT_MODES[n].id;
      console.log('');
      console.log(`  ${teal('●')} ${cream(INTENT_MODES[n].label)} ${sage('mode · via ' + routeLabel(route, config))}`);
      if (sessionMode === 'review' && route?.id !== 'codex' && installedHarnesses.some(h => h.id === 'codex')) {
        console.log(`  ${slate('tip: a second model reviews more honestly — /use codex')}`);
      }
      if (sessionMode === 'build' && route?.type === 'harness') {
        console.log(`  ${slate('tip: when this needs real file edits, /work drops you into ' + HARNESSES[route.id].label + ' and brings you back')}`);
      }
      console.log(`  ${sage('Describe it.')}`);
      console.log('');
      rl.prompt();
      return;
    }

    // Slash commands
    if (input.startsWith('/')) {
      const parts = input.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const cmdArg = parts.slice(1).join(' ');

      if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
        const turns = messages.length / 2;
        // Clean up background children
        if (global._phewshChildren) {
          global._phewshChildren.forEach(c => { try { c.kill(); } catch {} });
        }
        // Leave every existing harness projection current for whichever tool
        // opens this project next.
        try {
          const h = selfheal.heal();
          if (h.healed) console.log(`  ${teal('↻')} ${sage("Harness context refreshed from .intent/ — you didn't have to")}`);
        } catch { /* self-heal must never block exit */ }
        // The handoff is given, not asked for: leaving a project hands you the
        // verified brief that the next AI tool inherits — the continuity promise
        // made visible on the way out. Only in a real project; never blocks exit.
        if (intentFiles.length > 0) {
          await showHandoff({ projectName, route: route?.id, reason: 'carry this into your next tool', nextHint: false });
        }
        try { require('../lib/intro').farewell(); } catch { /* sign-off is a nicety */ }
        console.log(`  ${sage('session ended · ' + turns + ' exchanges · ' + (totalPromptTokens + totalCompletionTokens) + ' tokens')}`);
        if (decisionsThisSession > 0) {
          const stillPending = pendingDecisions().length;
          console.log(`  ${sage(decisionsThisSession + ' decision' + (decisionsThisSession !== 1 ? 's' : '') + ' recorded')}${stillPending > 0 ? slate(` · ${stillPending} awaiting outcome — phewsh outcomes label`) : ''}`);
        }
        console.log('');
        process.exit(0);
      }

      // ── /next ──────────────────────────────────────────
      // The self-aware "what should I do?" button: phewsh reads the session's
      // state and hands back ranked, pickable next steps — no command to recall.
      if (cmd === 'next' || cmd === 'recommend' || cmd === 'guide') {
        // "Next" is one of the four words: your list (.intent/next.json) +
        // phewsh's own recommendation, unified under one verb.
        const nx = require('../lib/next');
        const nparts = cmdArg.split(/\s+/);
        const nsub = (nparts[0] || '').toLowerCase();
        const TASK_SUBS = ['add', 'a', 'start', 'now', 'done', 'drop', 'rm', 'list', 'ls', 'clear', 'criteria', 'criterion'];
        const renderTasks = () => {
          const items = nx.ordered(nx.load());
          console.log('');
          console.log(`  ${b(cream('NEXT'))} ${slate('— what should happen next · .intent/next.json')}`);
          if (items.length === 0) {
            console.log(`  ${slate('Empty.')} ${cream('/next add "the thing you want done"')}`);
          } else {
            items.forEach((it, i) => {
              const mark = it.state === 'now' ? green('◐') : it.state === 'done' ? slate('✓') : slate('○');
              const title = it.state === 'done' ? slate(it.title) : cream(it.title);
              console.log(`  ${slate(String(i + 1).padStart(2))} ${mark} ${title}`);
              if (Array.isArray(it.criteria) && it.criteria.length) {
                const { results } = require('../lib/verify').verifyAll(it.criteria);
                const symbols = {
                  pass: green('✓'),
                  partial: yellow('~'),
                  fail: ember('✗'),
                  unknown: slate('?'),
                  human: peach('◇'),
                  proposed: slate('○'),
                };
                results.forEach(result => {
                  console.log(`       ${symbols[result.status] || slate('·')} ${slate(result.expected + ' · ' + result.note)}`);
                });
              }
            });
            console.log(`  ${slate('/next start # · /next done # · /next criteria # … · /next drop # · /next add "…"')}`);
          }
          console.log('');
        };
        if (TASK_SUBS.includes(nsub)) {
          if (nsub === 'add' || nsub === 'a') nx.add(cmdArg.replace(/^\S+\s*/, '').replace(/^["']|["']$/g, ''));
          else if (nsub === 'clear') { const dd = nx.load(); dd.items = dd.items.filter(i => i.state !== 'done'); nx.save(dd); }
          else if (nsub === 'list' || nsub === 'ls') { /* render only */ }
          else if (nsub === 'criteria' || nsub === 'criterion') {
            const ref = nparts[1];
            const kind = (nparts[2] || '').toLowerCase();
            const args = nparts.slice(3);
            if (!ref) {
              console.log(`\n  ${slate('Which item? e.g.')} ${cream('/next criteria 1 file out.txt')}\n`);
              rl.prompt();
              return;
            }
            if (kind === 'accept') nx.acceptCriteria(ref);
            else if (kind === 'clear') nx.clearCriteria(ref);
            else if (kind === 'human') {
              nx.addCriterion(ref, {
                expected: args.join(' ').replace(/^["']|["']$/g, '') || 'human judgment required',
                type: 'human',
              });
            } else if (kind === 'file' || kind === 'changed') {
              const p = args[0];
              if (!p) {
                console.log(`\n  ${slate('Need a path. e.g.')} ${cream('/next criteria ' + ref + ' ' + kind + ' cli/lib/verify.js')}\n`);
                rl.prompt();
                return;
              }
              nx.addCriterion(ref, {
                expected: args.slice(1).join(' ').replace(/^["']|["']$/g, '') || `${p} ${kind === 'file' ? 'exists' : 'changed'}`,
                type: 'measurable',
                check: { kind, path: p },
              });
            } else if (kind === 'contains') {
              const p = args[0];
              const text = args.slice(1).join(' ').replace(/^["']|["']$/g, '');
              if (!p || !text) {
                console.log(`\n  ${slate('Need a path and text. e.g.')} ${cream('/next criteria ' + ref + ' contains README.md "Four words"')}\n`);
                rl.prompt();
                return;
              }
              nx.addCriterion(ref, {
                expected: `${p} contains "${text}"`,
                type: 'measurable',
                check: { kind: 'contains', path: p, text },
              });
            } else if (kind) {
              console.log(`\n  ${slate('Kinds:')} ${cream('human <expected> | file <path> | contains <path> <text> | changed <path> | accept | clear')}\n`);
              rl.prompt();
              return;
            }
          }
          else { const ref = nparts[1]; if (nsub === 'drop' || nsub === 'rm') nx.remove(ref); else nx.setState(ref, (nsub === 'start' || nsub === 'now') ? 'now' : 'done'); }
          renderTasks();
          rl.prompt();
          return;
        }
        const c = nx.counts();
        let ranked = [];
        try { ranked = suggestAll(buildSuggestState()); } catch { /* best-effort */ }
        console.log('');
        if (c.total > 0) {
          const bits = [];
          if (c.now) bits.push(green(c.now + ' in progress'));
          if (c.next) bits.push(teal(c.next + ' queued'));
          if (c.done) bits.push(slate(c.done + ' done'));
          console.log(`  ${cream('your NEXT list:')} ${bits.join(slate(' · '))}  ${slate('— /next list')}`);
          console.log('');
        }
        if (ranked.length === 0) {
          if (c.total === 0) console.log(`  ${teal('●')} ${sage("You're aligned — nothing pressing. Note what's next with /next add, or keep working.")}`);
          else console.log(`  ${teal('●')} ${sage("That's your list. Nothing else pressing from phewsh.")}`);
          console.log('');
          nextChoices = null;
          rl.prompt();
          return;
        }
        console.log(`  ${b(cream('What would move you forward'))} ${slate('— pick a number, or ignore me')}`);
        console.log('');
        nextChoices = ranked.slice(0, 3);
        nextChoices.forEach((s, i) => {
          console.log(`  ${teal(String(i + 1))} ${cream(s.command.trim())}  ${sage(s.message)}`);
          console.log(`     ${slate(s.why)}`);
        });
        console.log('');
        console.log(`  ${slate('a slash command runs in place; anything else, I show you the line to run')}`);
        console.log('');
        rl.prompt();
        return;
      }

      // ── /thread ────────────────────────────────────────
      // The cross-tool thread: one continuous record of your work, whichever
      // tool ran each step. The "nothing lost" proof, made visible.
      if (cmd === 'thread' || cmd === 'continuity') {
        const decisions = recentDecisions(50, { project: projectName });
        const thread = continuity.threadFor(decisions, { project: projectName });
        console.log('');
        if (thread.length === 0) {
          console.log(`  ${teal('●')} ${sage('No thread yet for')} ${cream(projectName)}${sage('.')} ${slate('Do something — every action joins the thread, whichever tool runs it.')}`);
          console.log('');
          rl.prompt();
          return;
        }
        const tools = continuity.toolsInThread(decisions, { project: projectName });
        console.log(`  ${b(cream('Your thread'))} ${slate('— ' + projectName + ' · phewsh remembers across every tool')}`);
        ui.divider('line');
        for (const d of thread.slice(0, 12)) {
          const ago = continuity.agoText(d.ts).padEnd(9);
          const via = continuity.labelFor(d.route).padEnd(13);
          const oc = d.outcome
            ? (d.outcome === 'kept' ? green('kept') : d.outcome === 'superseded' ? peach(d.outcome) : ember(d.outcome))
            : slate('open');
          let s = (d.summary || '').replace(/\s+/g, ' ');
          if (s.length > 46) s = s.slice(0, 45).trimEnd() + '…';
          console.log(`    ${slate(ago)} ${sage(via)} ${cream(s || '—')}  ${oc}`);
        }
        ui.divider('line');
        const span = tools >= 2 ? `${tools} tools, one thread` : `${tools} tool`;
        console.log(`  ${sage(thread.length + ' action' + (thread.length !== 1 ? 's' : '') + ' · ' + span + ' · nothing re-explained')}`);
        console.log('');
        rl.prompt();
        return;
      }

      // ── /wrap + /reconcile ─────────────────────────────
      // Wrap observes. Reconcile proposes. Only an explicit yes writes intent.
      if (cmd === 'wrap') {
        console.log('');
        const truth = await auditTruth();
        const observed = observeCurrent(truth);
        lastTransitionReport = observed;
        console.log(formatObservedReport(observed, { title: 'Wrap — observed current state' }));
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'reconcile') {
        console.log('');
        const report = lastTransitionReport || observeCurrent(await auditTruth());
        const proposal = reconciliationProposal(report);
        if (!proposal.available) {
          console.log(`  ${ember('!')} ${sage('No reconciliation proposal: ' + proposal.reason)}`);
          console.log('');
          rl.prompt();
          return;
        }
        console.log('Reconciliation proposal (no files changed):');
        console.log(proposal.diff);
        console.log('');
        console.log(`  ${sage('Apply this exact diff?')} ${slate('y/N')}`);
        awaitingReconcile = proposal;
        rl.prompt();
        return;
      }

      // ── /learn ─────────────────────────────────────────
      // What the record has learned — kept-rates by tool and by mode, so the
      // 100th decision is better-informed than the 1st. Honest: stays quiet
      // until there's real labeled signal.
      if (cmd === 'learn' || cmd === 'stats') {
        let stats = null;
        try { stats = outcomeStats({ project: projectName }); } catch { /* best-effort */ }
        const labeled = stats ? learning.totalLabeled(stats) : 0;
        console.log('');
        if (labeled < 5) {
          console.log(`  ${teal('●')} ${sage(`Not enough labeled decisions yet (${labeled}).`)} ${slate('Label outcomes with /outcomes — the record gets smarter as you do.')}`);
          console.log('');
          rl.prompt();
          return;
        }
        console.log(`  ${b(cream('What your record has learned'))} ${slate(`— ${labeled} labeled decisions, ${projectName}`)}`);
        ui.divider('line');
        console.log(`  ${sage('by tool')} ${slate('(kept-rate, best first)')}`);
        for (const r of learning.routeRates(stats, { minSample: 2 })) {
          const pct = Math.round(r.keptRate * 100);
          const bar = '█'.repeat(Math.round(r.keptRate * 10)).padEnd(10, '░');
          console.log(`    ${continuity.labelFor(r.route).padEnd(14)} ${teal(bar)} ${cream(pct + '%')} ${slate(`(${r.kept}/${r.total} kept)`)}`);
        }
        const modes = learning.modeRates(stats, { minSample: 2 });
        if (modes.length) {
          console.log('');
          console.log(`  ${sage('by kind of work')}`);
          for (const m of modes) {
            const pct = Math.round(m.keptRate * 100);
            console.log(`    ${String(m.mode).padEnd(14)} ${cream(pct + '%')} ${slate(`(${m.kept}/${m.total} kept)`)}`);
          }
        }
        const best = learning.bestRoute(stats, { minSample: 3 });
        ui.divider('line');
        if (best) console.log(`  ${teal('↪')} ${sage(`${continuity.labelFor(best.route)} keeps best for you (${Math.round(best.keptRate * 100)}%).`)} ${slate('/use ' + best.route + ' to lean on it.')}`);
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'help' || cmd === 'h' || cmd === 'commands') {
        const wantsAll = cmd === 'commands' || /^(all|more|full|everything)$/i.test(cmdArg.trim());

        // Bare /help → the short essentials a newcomer actually needs.
        if (!wantsAll) {
          console.log('');
          console.log(`  ${sage('the loop: define .intent/ → sync → work → evolve → repeat')}`);
          console.log('');
          console.log(`  ${cream('the essentials')}`);
          console.log(`    ${teal('just type')}      ${sage('chat — your .intent/ context travels with every route')}`);
          console.log(`    ${teal('/next')}          ${sage('not sure? phewsh names the next step worth taking')}`);
          console.log(`    ${teal('/use')} ${slate('<tool>')}   ${sage('route through Claude Code, Codex, Gemini… (their login, no key)')}`);
          console.log(`    ${teal('@name')} ${slate('<msg>')}   ${sage('one message to one tool — @codex review this')}`);
          console.log(`    ${teal('/work')} ${slate('[tool]')}  ${sage('hand off to the full interactive tool, outcome on return')}`);
          console.log(`    ${teal('/clarify')}       ${sage('turn messy thoughts into .intent/ artifacts')}`);
          console.log(`    ${teal('/scan')}          ${sage('find your projects — and repos that need shared memory')}`);
          console.log(`    ${teal('/outcomes')}      ${sage('label what you kept — the record that gets smarter')}`);
          console.log('');
          console.log(`  ${slate('/help all')} ${sage('everything')}  ${slate('·')}  ${slate('/tour')} ${sage('walkthrough')}  ${slate('·')}  ${slate('/quit')} ${sage('exit')}`);
          console.log('');
          rl.prompt();
          return;
        }

        console.log('');
        console.log(`  ${sage('the loop: define .intent/ → sync → work → evolve → repeat')}`);
        console.log('');
        console.log(`  ${cream('not sure what to do?')}`);
        console.log(`    ${teal('/next')}        ${sage("phewsh reads your state and hands back the next step worth taking")}`);
        console.log(`    ${teal('/thread')}      ${sage('where you left off — your work across every tool, one record')}`);
        console.log(`    ${teal('/learn')}       ${sage('what your record taught — which tool keeps best, by kind of work')}`);
        console.log('');
        console.log(`  ${cream('author .intent/')}`);
        console.log(`    ${teal('/scan')}        ${sage('Find your projects — and likely candidates with no .intent/ yet')}`);
        console.log(`    ${teal('/init')}        ${sage('Create .intent/ for this project')}`);
        console.log(`    ${teal('/intent')}      ${sage('Pause and reflect — view or update .intent/ before moving on')}`);
        console.log(`    ${teal('/remember')}    ${sage('Jot a decision to .intent/decisions.md — every tool inherits it')}`);
        console.log(`    ${teal('/truth')}       ${sage('Read-only audit of versions, Git, intent, projections, and conflicts')}`);
        console.log(`    ${teal('/brief')}       ${sage('Generate the current provider-ready verified briefing')}`);
        console.log(`    ${teal('/wrap')}        ${sage('Observe changes, contradictions, unknowns, and reconciliation needs')}`);
        console.log(`    ${teal('/reconcile')}   ${sage('Propose an exact intent diff; writes only after approval')}`);
        console.log(`    ${teal('/clarify')}     ${sage('Turn ideas into .intent/ artifacts')}`);
        console.log(`    ${teal('/gate')}        ${sage('Set constraints (budget, time, skill)')}`);
        console.log(`    ${teal('/context')}     ${sage('Show loaded .intent/ files')}`);
        console.log(`    ${teal('/reload')}      ${sage('Reload .intent/ from disk')}`);
        console.log('');
        console.log(`  ${cream('sync everywhere')}`);
        console.log(`    ${teal('/seq')}          ${sage('Sequence all memory → optimal context')}`);
        console.log(`    ${teal('/seq claude')}   ${sage('Sequence → write to CLAUDE.md')}`);
        console.log(`    ${teal('/watch')}       ${sage('Sync .intent/ → native harness files + cloud (background)')}`);
        console.log(`    ${teal('/export')}      ${sage('Export .intent/ for any AI tool')}`);
        console.log(`    ${teal('/push')}        ${sage('Push to phewsh.com/intent')}`);
        console.log(`    ${teal('/pull')}        ${sage('Pull from cloud (reloads context)')}`);
        console.log(`    ${teal('/serve')}       ${sage('Execution bridge for phewsh.com/intent')}`);
        console.log(`    ${teal('/sync')}        ${sage('Check sync status')}`);
        console.log(`    ${teal('/pack')}        ${sage('Opt-in workflow packs (Karpathy, GSD…) — attributed, reversible')}`);
        console.log('');
        console.log(`  ${cream('route — where your typing goes')}`);
        console.log(`    ${teal('/use')} ${slate('<route>')}  ${sage('Switch: claude-code, codex, gemini, cursor, opencode, api')}`);
        console.log(`    ${teal('@name')} ${slate('<msg>')}  ${sage('One message to one harness — @codex review this — context stays shared')}`);
        console.log(`    ${teal('/council')} ${slate('<q>')} ${sage('Ask ALL installed harnesses in parallel; keep the best answer')}`);
        console.log(`    ${teal('/harnesses')}   ${sage('Agent CLIs detected on this machine')}`);
        console.log(`    ${teal('/provider')}    ${sage('Current route + what\'s available')}`);
        console.log(`    ${teal('/fallback')}    ${sage('What happens at a usage wall: ask or auto-switch')}`);
        console.log(`    ${teal('/outcomes')}    ${sage('What worked — tell phewsh, and it learns which tool to trust')}`);
        console.log('');
        console.log(`  ${cream('session')}`);
        console.log(`    ${teal('/work')} ${slate('[harness]')} ${sage('Preflight, brief, native handoff, automatic postflight')}`);
        console.log(`    ${teal('/handoff')}     ${sage('See the verified brief the next AI tool inherits — rendered + saved')}`);
        console.log(`    ${teal('/switch')} ${slate('<harness>')} ${sage('Launch another native tool with a freshly verified briefing')}`);
        console.log(`    ${teal('/run')} ${slate('<prompt>')} ${sage('One-shot prompt (no history)')}`);
        console.log(`    ${teal('esc')}          ${sage('Cancel a running turn · clear the input line')}`);
        console.log(`    ${teal('/clear')}       ${sage('Clear conversation')}`);
        console.log(`    ${teal('/status')}      ${sage('Session stats')}`);
        console.log(`    ${teal('/quit')}        ${sage('Exit')}`);
        console.log('');
        console.log(`  ${cream('configure')}`);
        console.log(`    ${teal('/key')}         ${sage('Set API key (optional — harnesses need none)')}`);
        console.log(`    ${teal('/login')}       ${sage('Identity + cloud sync')}`);
        console.log(`    ${teal('/model')} ${slate('<name>')} ${sage('Switch model — passed through, the provider validates')}`);
        console.log(`    ${teal('/update')}      ${sage('Update phewsh')}`);
        console.log(`    ${teal('/tour')}        ${sage('Quick walkthrough')}`);
        console.log('');
        console.log(`  ${cream('run in your terminal')} ${slate('— machine setup, run outside a session (not as /cmd)')}`);
        console.log(`    ${teal('phewsh ambient on')}     ${sage("Every AI tool inherits your .intent/ — even without launching phewsh")}`);
        console.log(`    ${teal('phewsh shim on')}        ${sage('A phewsh status banner before each tool launches — visible proof')}`);
        console.log(`    ${teal('phewsh update auto on')} ${sage('Auto-update in the background on launch (default: notify-only)')}`);
        console.log(`    ${teal('phewsh setup')}          ${sage('Guided setup — pick your default route')}`);
        console.log(`    ${slate('also standalone:')} ${teal('phewsh status · next · work · remember')}  ${slate('· full list:')} ${teal('phewsh help')}`);
        console.log('');
        rl.prompt();
        return;
      }

      // ── /tour ──────────────────────────────────────────
      if (cmd === 'tour') {
        const pages = ui.TOUR_PAGES;
        let pageIdx = cmdArg ? parseInt(cmdArg) - 1 : 0;
        if (isNaN(pageIdx) || pageIdx < 0) pageIdx = 0;
        if (pageIdx >= pages.length) pageIdx = pages.length - 1;

        const page = pages[pageIdx];
        console.log('');
        ui.divider('line');
        console.log(`  ${b(cream(page.title))}  ${slate(`(${pageIdx + 1}/${pages.length})`)}`);
        ui.divider('line');
        page.body.forEach(line => console.log(line));
        console.log('');
        if (pageIdx < pages.length - 1) {
          console.log(`  ${sage('next:')} ${cream('/tour ' + (pageIdx + 2))}  ${slate('·')}  ${sage('/tour 1-' + pages.length + ' to jump')}`);
        } else {
          console.log(`  ${teal('●')} ${sage('End of tour. You\'re ready.')}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'clear') {
        messages.length = 0;
        console.log(`  ${sage('conversation cleared')}`);
        rl.prompt();
        return;
      }

      // /width — fix mid-word breaks when the terminal misreports its size.
      // `/width` shows what phewsh thinks; `/width 80` pins it (saved, sticks
      // across sessions); `/width auto` clears the pin back to detection.
      if (cmd === 'width') {
        const arg = (cmdArg || '').trim().toLowerCase();
        if (!arg) {
          console.log('');
          console.log(`  ${b(cream('Display width'))} ${slate('— used to wrap text at word boundaries')}`);
          console.log(`  ${sage('phewsh is wrapping at')} ${cream(String(ui.rawWidth()))} ${sage('columns')} ${slate(config?.displayWidth ? '(pinned)' : '(auto-detected)')}`);
          console.log(`  ${slate('If words still break mid-line, your terminal reports a wider size than it shows.')}`);
          console.log(`  ${sage('Pin your real width:')} ${cream('/width 80')}  ${slate('·')}  ${sage('back to auto:')} ${cream('/width auto')}`);
          console.log('');
          rl.prompt();
          return;
        }
        if (arg === 'auto' || arg === 'off' || arg === 'reset') {
          ui.setWidth(null);
          config = config || {};
          delete config.displayWidth;
          try { configFile.saveConfig(CONFIG_PATH, config); } catch { /* best effort */ }
          console.log(`  ${teal('●')} ${sage('Width back to auto-detect')} ${slate('(' + ui.rawWidth() + ' columns)')}`);
          console.log('');
          rl.prompt();
          return;
        }
        const set = ui.setWidth(arg);
        if (!set) {
          console.log(`  ${ember('!')} ${sage('Give a number ≥ 20, e.g.')} ${cream('/width 80')} ${slate('· or')} ${cream('/width auto')}`);
          console.log('');
          rl.prompt();
          return;
        }
        config = config || {};
        config.displayWidth = set;
        try { configFile.saveConfig(CONFIG_PATH, config); } catch { /* best effort */ }
        console.log(`  ${teal('●')} ${sage('Wrapping at')} ${cream(String(set))} ${sage('columns now')} ${slate('— saved, sticks across sessions')}`);
        console.log(`  ${slate('This sentence is a quick check: if it wraps cleanly at a word and never cuts a word in half, you are set.')}`);
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'context') {
        if (intentFiles.length > 0) {
          console.log('');
          console.log(`  ${b(cream('Loaded from'))} ${teal('.intent/')}`);
          ui.divider('line');
          intentFiles.forEach(f => console.log(`    ${teal('●')} ${cream(f.file)} ${slate('(' + f.content.length + ' chars)')}`));
          ui.divider('line');
          console.log(formatSourceContract({ compact: true }).split('\n').map(line => `  ${line}`).join('\n'));
        } else {
          console.log(`\n  ${sage('No .intent/ context found in')} ${slate(process.cwd())}`);
          console.log(`  ${sage('Run')} ${cream('/init')} ${sage('to create one')}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'truth') {
        console.log('');
        console.log(formatTruth(await auditTruth()));
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'brief') {
        console.log('');
        const { content } = await generateBrief();
        const { renderMarkdown } = require('../lib/md');
        console.log(renderMarkdown(content));
        console.log('');
        console.log(`  ${slate('this is your handoff — it travels to the next AI tool ·')} ${cream('/handoff')} ${slate('to save + copy it')}`);
        console.log('');
        rl.prompt();
        return;
      }

      // /handoff — explicitly produce, render, save, and copy the cross-harness
      // handoff so you can SEE what would carry into the next tool.
      if (cmd === 'handoff') {
        console.log(`  ${sage('Building your handoff…')}`);
        await showHandoff({ projectName, route: route?.id, reason: 'what the next AI tool will pick up' });
        rl.prompt();
        return;
      }

      if (cmd === 'status') {
        const turns = messages.length / 2;
        config = loadConfig();
        ui.statusPanel('Session', [
          ['Turns', String(turns)],
          ['Tokens', `${totalPromptTokens} in → ${totalCompletionTokens} out`],
          ['Project', projectName, 'cyan'],
          ['Context', intentFiles.length > 0 ? intentFiles.map(f => f.file).join(', ') : 'none', intentFiles.length > 0 ? 'green' : 'yellow'],
          ['Route', routeLabel(route, config), 'green'],
          ['Mode', sessionMode || 'none'],
          ['Decisions', `${decisionsThisSession} this session`],
          ['User', config?.email || slate('not logged in')],
          ['API key', config?.apiKey ? config.apiKey.slice(0, 8) + '...' : 'not set — optional', config?.apiKey ? 'green' : 'yellow'],
        ]);
        rl.prompt();
        return;
      }

      if (cmd === 'reload') {
        intentFiles = loadIntentContext();
        systemPrompt = buildSystemPrompt(intentFiles);
        const synced = selfheal.syncContextFiles({ createMissing: false }).synced || [];
        console.log(`  ${teal('●')} ${sage('Reloaded ' + intentFiles.length + ' artifact' + (intentFiles.length !== 1 ? 's' : ''))}${synced.length ? slate(' · synced ' + synced.join(', ')) : ''}`);
        rl.prompt();
        return;
      }

      if (cmd === 'system') {
        console.log(`\n${slate(systemPrompt)}\n`);
        rl.prompt();
        return;
      }

      if (cmd === 'init') {
        if (fs.existsSync(path.join(intentDir(), 'vision.md'))) {
          console.log(`\n  ${sage('.intent/ already exists in')} ${slate(process.cwd())}`);
          console.log(`  ${sage('Use /reload to refresh context')}\n`);
        } else {
          try {
            const { execSync } = require('child_process');
            execSync('node ' + path.join(__dirname, 'intent.js') + ' --init', { stdio: 'inherit' });
            intentFiles = loadIntentContext();
            systemPrompt = buildSystemPrompt(intentFiles);
            if (intentFiles.length > 0) {
              console.log(`  ${teal('●')} ${sage('Context loaded:')} ${cream(intentFiles.map(f => f.file).join(', '))}`);
            }
          } catch (err) {
            console.error(`  ${sage('Init failed:')} ${err.message}`);
          }
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'scan') {
        runScanMenu();
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'clarify') {
        try {
          const { spawnSync } = require('child_process');
          const args = ['clarify'];
          if (cmdArg) args.push('--text', cmdArg);
          const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js'), ...args], { stdio: 'inherit' });
          if (res.status !== 0) {
            console.error(`  ${ember('!')} ${sage('Clarify exited without writing context.')}`);
          }
          intentFiles = loadIntentContext();
          systemPrompt = buildSystemPrompt(intentFiles);
          if (intentFiles.length > 0) {
            console.log(`  ${teal('●')} ${sage('Context loaded:')} ${cream(intentFiles.map(f => f.file).join(', '))}`);
          }
        } catch (err) {
          console.error(`  ${sage('Clarify failed:')} ${err.message}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'gate') {
        try {
          // execFileSync with an argv array — no shell, so REPL input can never
          // be interpreted as shell metacharacters (hardening: was execSync).
          const { execFileSync } = require('child_process');
          const gateArgs = (cmdArg || 'status').split(/\s+/).filter(Boolean);
          execFileSync(process.execPath, [path.join(__dirname, 'gate.js'), ...gateArgs], { stdio: 'inherit' });
          intentFiles = loadIntentContext();
          systemPrompt = buildSystemPrompt(intentFiles);
        } catch (err) {
          console.error(`  ${sage('Gate failed:')} ${err.message}`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'seq' || cmd === 'sequence') {
        try {
          const { sequence } = require('../lib/sequencer');
          const { resolveProjectRoot, discover } = require('../lib/sequencer/discover');
          const target = cmdArg?.split(/\s+/)[0];
          const explain = cmdArg?.includes('explain') || cmdArg?.includes('-e');

          if (target === 'claude' || target === 'claude-md') {
            // CANONICAL WRITE. /seq claude writes the SAME deterministic block as
            // self-heal and watch — one source policy (.intent canonical), one
            // renderer — so a manual sequence can never produce a divergent or
            // stale CLAUDE.md. (Previously this called the broad sequencer, which
            // ingested narrative.md + memory logs and clobbered the canonical block.)
            const res = selfheal.syncContextFiles({ targets: ['CLAUDE.md'], createMissing: true });
            if (res.synced && res.synced.length) {
              console.log(`\n  ${teal('●')} ${sage('CLAUDE.md updated — canonical .intent/ projection')} ${slate('(same block self-heal & watch write)')}\n`);
            } else {
              console.log(`\n  ${slate('CLAUDE.md already current' + (res.reason ? ' (' + res.reason + ')' : ''))}\n`);
            }
          } else if (explain || target === 'sources' || target === 'root') {
            // Diagnostic: show what the sequencer sees — resolved root, selected
            // sources (with scope), and the canonical projection's restricted set.
            const root = resolveProjectRoot(process.cwd());
            const found = discover(process.cwd());
            console.log('');
            console.log(`  ${b(cream('Sequence diagnostics'))}`);
            ui.divider('line');
            console.log(`  ${sage('resolved root')}  ${cream(root)}${root !== process.cwd() ? slate(' (walked up from ' + process.cwd() + ')') : ''}`);
            console.log(`  ${sage('canonical write set')}  ${slate('vision.md · project.json · status.md · next.md · next.json')}`);
            console.log(`  ${sage('broad read (this preview)')}`);
            for (const s of found) {
              const tag = s.scope === 'global' ? slate('global ') : sage('project');
              const canon = ['vision.md','project.json','status.md','next.md','next.json'].includes(s.name) ? teal(' ✓ canonical') : slate(' · preview-only');
              console.log(`    ${tag} ${cream(s.name.padEnd(20))}${canon}`);
            }
            ui.divider('line');
            console.log(`  ${slate('write the canonical projection with')} ${cream('/seq claude')}`);
            console.log('');
          } else {
            // Default: broad, READ-ONLY synthesis to stdout — never writes a file.
            sequence({ target: 'stdout', explain });
          }
        } catch (err) {
          console.error(`  ${ember('!')} ${sage('Sequence failed:')} ${err.message}`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'export') {
        try {
          const { generateContext } = require('./context');
          const content = generateContext(!!cmdArg?.includes('full'));
          if (content) {
            const outPath = path.join(process.cwd(), '.phewsh.context');
            fs.writeFileSync(outPath, content);
            console.log(`\n  ${teal('●')} ${sage('Written to')} ${cream(outPath)}\n`);
          } else {
            console.log(`\n  ${sage('No artifacts to export')}\n`);
          }
        } catch (err) {
          console.error(`  ${sage('Export failed:')} ${err.message}`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'push') {
        if (!config?.supabaseUserId) {
          console.log(`\n  ${ember('!')} ${sage('Not logged in. Run /login first.')}\n`);
          rl.prompt();
          return;
        }
        try {
          const token = await ensureValidToken(config);
          if (!token) { console.log(`\n  ${ember('!')} ${sage('Session expired. Run /login.')}\n`); rl.prompt(); return; }
          await push(config, token);
        } catch (err) {
          console.error(`  ${ember('!')} ${sage('Push failed:')} ${err.message}\n`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'pull') {
        if (!config?.supabaseUserId) {
          console.log(`\n  ${ember('!')} ${sage('Not logged in. Run /login first.')}\n`);
          rl.prompt();
          return;
        }
        try {
          const token = await ensureValidToken(config);
          if (!token) { console.log(`\n  ${ember('!')} ${sage('Session expired. Run /login.')}\n`); rl.prompt(); return; }
          await pull(config, token);
          intentFiles = loadIntentContext();
          systemPrompt = buildSystemPrompt(intentFiles);
          if (intentFiles.length > 0) {
            console.log(`  ${teal('●')} ${sage('Context reloaded:')} ${cream(intentFiles.map(f => f.file).join(', '))}`);
          }
        } catch (err) {
          console.error(`  ${ember('!')} ${sage('Pull failed:')} ${err.message}\n`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'sync') {
        if (!config?.supabaseUserId) {
          console.log(`\n  ${ember('!')} ${sage('Not logged in. Run /login first.')}\n`);
          rl.prompt();
          return;
        }
        const syncSpin = ui.spinner('checking sync');
        const syncResult = await checkSyncStatus(config);
        if (!syncResult) {
          syncSpin.stop(`${sage('Could not check sync status')}`);
        } else if (syncResult.status === 'cloud-newer') {
          syncSpin.stop(`${ember('↓')} ${sage('Cloud is newer (' + syncResult.ago + ') — run /pull')}`);
        } else if (syncResult.status === 'local-newer') {
          syncSpin.stop(`${ember('↑')} ${sage('Local changes not pushed (' + syncResult.ago + ') — run /push')}`);
        } else if (syncResult.status === 'synced') {
          syncSpin.stop(`${teal('↕')} ${sage('In sync')}`);
        } else if (syncResult.status === 'local-only') {
          syncSpin.stop(`${slate('↕ Not linked to cloud — run /push to sync')}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'login') {
        try {
          const { execSync } = require('child_process');
          execSync('node ' + path.join(__dirname, 'login.js'), { stdio: 'inherit' });
          config = loadConfig();
        } catch (err) {
          console.error(`  ${sage('Login failed:')} ${err.message}`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'setup') {
        try {
          const { execSync } = require('child_process');
          execSync(`node ${path.join(__dirname, '..', 'bin', 'phewsh.js')} setup`, { stdio: 'inherit' });
          config = loadConfig();
          route = resolveRoute(config, harnesses);
          console.log(`  ${teal('●')} ${sage('Route now:')} ${cream(routeLabel(route, config))}`);
        } catch (err) {
          console.error(`  ${sage('Setup failed:')} ${err.message}`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'key') {
        if (cmdArg) {
          const apiKey = cmdArg.trim();
          config = loadConfig() || {};
          if (apiKey.startsWith('sk-ant-') || apiKey.startsWith('sk-')) {
            config.apiKey = apiKey;
            config.provider = 'anthropic';
            saveConfig(config);
            console.log(`  ${teal('●')} ${sage('Anthropic key saved. You\'re ready — just type.')}\n`);
          } else if (apiKey.startsWith('sk-or-')) {
            config.apiKey = apiKey;
            config.provider = 'openrouter';
            saveConfig(config);
            console.log(`  ${teal('●')} ${sage('OpenRouter key saved. You\'re ready — just type.')}\n`);
          } else {
            config.apiKey = apiKey;
            saveConfig(config);
            console.log(`  ${teal('●')} ${sage('API key saved. You\'re ready — just type.')}\n`);
          }
          if (!route || route.type !== 'harness') route = resolveRoute(config, harnesses);
          rl.prompt();
          return;
        }
        console.log('');
        ui.divider('line');
        console.log(`  ${b(cream('Where to get an API key'))}`);
        ui.divider('line');
        console.log('');
        console.log(`  ${teal('Anthropic')} ${slate('(recommended)')}`);
        console.log(`    ${sage('1.')} Go to ${cream('console.anthropic.com/settings/keys')}`);
        console.log(`    ${sage('2.')} Create key → copy it ${slate('(starts with sk-ant-)')}`);
        console.log('');
        console.log(`  ${teal('OpenRouter')} ${slate('(multi-model)')}`);
        console.log(`    ${sage('1.')} Go to ${cream('openrouter.ai/keys')}`);
        console.log(`    ${sage('2.')} Create key → copy it ${slate('(starts with sk-or-)')}`);
        console.log('');
        console.log(`  ${slate('Note: API keys ≠ subscriptions. Both providers offer free credits.')}`);
        console.log('');
        const keyRl = readline.createInterface({ input: process.stdin, output: process.stdout });
        keyRl.question(`  ${sage('Paste your API key')}\n  ${teal('>')} `, (apiKey) => {
          keyRl.close();
          apiKey = apiKey.trim();
          if (!apiKey) {
            console.log(`  ${slate('Cancelled')}\n`);
          } else {
            config = loadConfig() || {};
            config.apiKey = apiKey;
            if (apiKey.startsWith('sk-or-')) config.provider = 'openrouter';
            else config.provider = 'anthropic';
            saveConfig(config);
            console.log(`\n  ${teal('●')} ${sage('API key saved. You\'re ready — just type naturally.')}\n`);
            if (!route || route.type !== 'harness') route = resolveRoute(config, harnesses);
          }
          rl.prompt();
        });
        return;
      }

      if (cmd === 'models') {
        console.log('');
        ui.divider('line');
        if (route?.type === 'harness') {
          const h = HARNESSES[route.id];
          console.log(`  ${b(cream('Models'))} ${sage('— via ' + h.label)}`);
          ui.divider('line');
          if (h.modelHints) {
            // Aliases the harness resolves to its own current versions —
            // stable names, so this list can't go stale.
            console.log(`    ${cream('default'.padEnd(12))} ${sage(h.label + "'s own default")}${!harnessModel ? ` ${teal('●')}` : ''}`);
            h.modelHints.forEach(m => {
              const active = harnessModel === m ? ` ${teal('●')}` : '';
              console.log(`    ${cream(m.padEnd(12))} ${sage('latest ' + m.charAt(0).toUpperCase() + m.slice(1))}${active}`);
            });
            if (harnessModel && !h.modelHints.includes(harnessModel)) {
              console.log(`    ${cream(harnessModel.padEnd(12))} ${sage('(pass-through)')} ${teal('●')}`);
            }
            console.log(`\n  ${sage('Switch:')} ${cream('/model <name>')} ${slate('— any full model id also works; ' + h.label + ' validates')}`);
          } else {
            console.log(`  ${sage('Current preference:')} ${cream(harnessModel || h.label + ' default')}`);
            console.log(`  ${sage(h.label + ' owns its model list —')} ${cream('/model <anything it accepts>')} ${slate('passes through; it validates')}`);
          }
          console.log('');
          rl.prompt();
          return;
        }
        // API route: ask the provider for its real list.
        const providerName = config?.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic';
        const live = await fetchLiveModels();
        if (live && live.length > 0) {
          console.log(`  ${b(cream('Available models'))} ${sage('— live from ' + providerName)}`);
          ui.divider('line');
          const shown = live.slice(0, 24);
          shown.forEach(id => {
            const active = modelId(currentModel) === id ? ` ${teal('●')}` : '';
            console.log(`    ${cream(id)}${active}`);
          });
          if (live.length > shown.length) console.log(`    ${slate('… +' + (live.length - shown.length) + ' more — /model <id> takes any of them')}`);
        } else {
          console.log(`  ${b(cream('Available models'))} ${slate('(offline — shortcuts only; any id still passes through)')}`);
          ui.divider('line');
          for (const [key, model] of Object.entries(MODELS)) {
            const active = key === currentModel ? ` ${teal('●')}` : '';
            console.log(`    ${cream(key.padEnd(16))} ${sage(model.name)}${active}`);
          }
        }
        if (!MODELS[currentModel] && !live?.includes(modelId(currentModel))) {
          console.log(`    ${cream(String(currentModel).padEnd(16))} ${sage('(pass-through)')} ${teal('●')}`);
        }
        console.log(`\n  ${sage('Switch with:')} ${cream('/model <name>')} ${slate('— shortcuts: ' + Object.keys(MODELS).map(k => k.replace('claude-', '')).join(' · '))}\n`);
        rl.prompt();
        return;
      }

      if (cmd === 'model') {
        // Harness route: the harness owns its model list — we pass the
        // preference through and let IT validate. No stale gate here.
        if (route?.type === 'harness') {
          const h = HARNESSES[route.id];
          if (!cmdArg) {
            console.log(`  ${sage('Route:')} ${cream(h.label)} ${sage('— model:')} ${cream(harnessModel || h.label + ' default')}`);
            console.log(`  ${sage('Usage:')} ${cream('/model <anything ' + h.label + ' accepts>')}${h.models ? '' : sage(' — not supported for this harness; set it in ' + h.label + ' itself')}`);
            console.log(`  ${slate('/model default to clear')}`);
            rl.prompt();
            return;
          }
          if (!h.models) {
            console.log(`  ${sage(h.label + ' doesn\'t take a model flag from phewsh — set the model in ' + h.label + ' itself.')}`);
            rl.prompt();
            return;
          }
          if (cmdArg.toLowerCase() === 'default') {
            harnessModel = null;
            console.log(`  ${teal('●')} ${sage('Cleared — ' + h.label + ' uses its own default.')}`);
          } else {
            harnessModel = cmdArg.trim().replace(/\s+/g, '-');
            console.log(`  ${teal('●')} ${sage('Model preference:')} ${cream(harnessModel)} ${slate('— ' + h.label + ' validates it on your next message')}`);
          }
          rl.prompt();
          return;
        }

        // API route: aliases are shortcuts; anything else passes through
        // verbatim and the provider validates it.
        if (!cmdArg) {
          console.log(`  ${sage('Current:')} ${cream(modelName(currentModel))}`);
          console.log(`  ${sage('Usage:')} ${cream('/model <' + Object.keys(MODELS).map(k => k.replace('claude-', '')).join('|') + '|any model id>')}`);
          rl.prompt();
          return;
        }
        const query = cmdArg.toLowerCase().replace('claude-', '').replace('claude', '').trim();
        const match = Object.keys(MODELS).find(k =>
          k.includes(query) || MODELS[k].name.toLowerCase().includes(query)
        );
        if (match) {
          currentModel = match;
          console.log(`  ${teal('●')} ${sage('Switched to')} ${cream(MODELS[match].name)}`);
        } else {
          currentModel = cmdArg.trim();
          console.log(`  ${teal('●')} ${sage('Switched to')} ${cream(currentModel)} ${slate('— passed through as-is; the provider validates it')}`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'intent') {
        // Pause and reflect before moving forward — the samurai check.
        // View what the project says it is; update it when reality moved.
        const artifacts = ['vision', 'plan', 'next', 'status'];
        const intentDir = path.join(process.cwd(), '.intent');

        // Full markdown render — **bold**, *italic*, `code`, [links] become
        // terminal formatting, not literal symbols. `base` keeps the line's
        // color after each inline reset.
        const inlineMd = (t, base) => t
          .replace(/\*\*([^*]+)\*\*/g, (_, x) => `\x1b[1m\x1b[38;5;230m${x}\x1b[0m${base}`)
          .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, (_, p, x) => `${p}\x1b[3m${x}\x1b[23m`)
          .replace(/`([^`]+)`/g, (_, x) => `\x1b[38;5;79m${x}\x1b[0m${base}`)
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, x, u) => `\x1b[4m\x1b[38;5;79m${x}\x1b[0m${base} \x1b[2m(${u})\x1b[22m`);
        const C = { sage: '\x1b[38;5;151m', slate: '\x1b[38;5;247m' };
        const renderMd = (raw) => {
          let body = raw;
          if (body.startsWith('---')) {
            const end = body.indexOf('\n---', 3);
            if (end !== -1) body = body.slice(end + 4);
          }
          return body.trim().split('\n').map(l => {
            if (/^#{1,2}\s/.test(l)) return `\n  ${b(teal(inlineMd(l.replace(/^#+\s*/, ''), '')))}`;
            if (/^#{3,}\s/.test(l)) return `  ${cream(inlineMd(l.replace(/^#+\s*/, ''), ''))}`;
            if (/^\s*[-*]\s/.test(l)) return `    ${teal('·')} ${C.sage}${inlineMd(l.replace(/^\s*[-*]\s*/, ''), C.sage)}\x1b[0m`;
            if (/^\s*\d+\.\s/.test(l)) return `    ${C.sage}${inlineMd(l.trim(), C.sage)}\x1b[0m`;
            if (/^---+\s*$/.test(l)) return `  ${slate('─'.repeat(40))}`;
            return `  ${C.slate}${inlineMd(l, C.slate)}\x1b[0m`;
          }).join('\n');
        };

        if (!fs.existsSync(intentDir)) {
          console.log(`  ${sage('No .intent/ here yet.')} ${cream('/init')} ${sage('creates it — that is the whole point.')}`);
          rl.prompt();
          return;
        }

        const sub = (cmdArg || '').trim().toLowerCase();

        if (sub.startsWith('view')) {
          const which = sub.split(/\s+/)[1];
          const targets = which && artifacts.includes(which) ? [which] : artifacts;
          for (const a of targets) {
            const p = path.join(intentDir, `${a}.md`);
            if (!fs.existsSync(p)) continue;
            console.log('');
            ui.divider('line');
            console.log(`  ${b(cream(a.toUpperCase()))} ${slate('.intent/' + a + '.md')}`);
            ui.divider('line');
            console.log(renderMd(fs.readFileSync(p, 'utf-8')));
          }
          console.log('');
          console.log(`  ${slate('moved on since this was written?')} ${cream('/intent update')}`);
          console.log('');
          rl.prompt();
          return;
        }

        if (sub === 'update') {
          // Reflect first: what does the record say happened since last update?
          console.log('');
          console.log(`  ${b(cream('Before updating — what actually happened:'))}`);
          try {
            const { recentDecisions } = require('../lib/outcomes');
            const recent = recentDecisions(5, { project: projectName });
            if (recent.length > 0) {
              recent.forEach(d => {
                const mark = d.outcome === 'kept' ? green('✓') : d.outcome ? yellow('~') : slate('·');
                console.log(`    ${mark} ${sage((d.summary || '').slice(0, 70))} ${slate('[' + (d.outcome || 'unlabeled') + ']')}`);
              });
            } else {
              console.log(`    ${slate('no decisions recorded yet')}`);
            }
          } catch { console.log(`    ${slate('record unavailable')}`); }
          console.log('');
          console.log(`  ${teal('●')} ${sage('Handing you to the guided update')} ${slate('— exit to come back to phewsh')}`);
          console.log('');
          pasteMode(false);
          rl.pause();
          const { spawnSync } = require('child_process');
          spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js'), 'clarify'], { stdio: 'inherit' });
          rl.resume();
          pasteMode(true);
          console.log('');
          console.log(`  ${teal('●')} ${sage('Back in phewsh.')} ${slate('/intent view to see the result — agents pick it up automatically')}`);
          console.log('');
          rl.prompt();
          return;
        }

        // No arg: the pause. Where the project stands, in one screen.
        const present = artifacts.filter(a => fs.existsSync(path.join(intentDir, `${a}.md`)));
        const stale = present.map(a => {
          const raw = fs.readFileSync(path.join(intentDir, `${a}.md`), 'utf-8');
          const m = raw.match(/^updated:\s*(\S+)/m);
          return { a, updated: m ? m[1] : null };
        });
        console.log('');
        console.log(`  ${b(cream('INTENT'))} ${slate('— .intent/ in ' + projectName)}`);
        stale.forEach(({ a, updated }) => {
          const age = updated ? slate('updated ' + updated) : slate('no date');
          console.log(`    ${teal('·')} ${cream(a.padEnd(8))} ${age}`);
        });
        console.log('');
        console.log(`    ${cream('/intent view')} ${slate('[vision|plan|next|status]')}  ${sage('read it, rendered')}`);
        console.log(`    ${cream('/intent update')}                       ${sage('reflect on the record, then guided rewrite')}`);
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'council' || cmd === 'all') {
        // One prompt, every installed harness, in parallel. Different
        // models disagreeing is the signal — and which answer you KEEP
        // is the outcome data.
        const members = harnesses.filter(h => h.installed && h.headless);
        if (!cmdArg) {
          console.log(`  ${sage('Usage:')} ${cream('/council <question>')} ${sage('— asks all ' + members.length + ' installed harnesses in parallel')}`);
          console.log(`  ${slate(members.map(m => m.label).join(' · '))}`);
          rl.prompt();
          return;
        }
        if (members.length < 2) {
          console.log(`  ${sage('Council needs at least 2 installed harnesses — you have ' + members.length + '.')}`);
          rl.prompt();
          return;
        }
        const councilHint = sessionMode
          ? Object.values(INTENT_MODES).find(m => m.id === sessionMode)?.hint
          : null;
        const councilSystem = councilHint ? `${systemPrompt}\n\n${councilHint}` : systemPrompt;
        const decisionId = recordDecision({
          project: projectName, route: 'council:' + members.map(m => m.id).join('+'),
          mode: sessionMode, summary: cmdArg,
        });
        decisionsThisSession++;
        console.log('');
        console.log(`  ${b(cream('Council'))} ${sage('— asking')} ${cream(String(members.length))} ${sage('harnesses in parallel. Where they disagree is the insight.')}`);
        console.log(`  ${slate(members.map(m => m.label).join(' · '))}`);

        const prompt = buildHarnessPrompt(messages, cmdArg);
        turnInFlight = true;
        const settled = await Promise.allSettled(members.map(m =>
          runViaHarness(m.id, councilSystem, prompt, { quiet: true })
        ));
        turnInFlight = false;
        if (userCancelled) {
          userCancelled = false;
          console.log(`\n  ${slate('council cancelled — esc')}\n`);
          rl.prompt();
          return;
        }

        const answers = [];
        settled.forEach((r, i) => {
          const m = members[i];
          console.log('');
          ui.divider('line');
          if (r.status === 'fulfilled') {
            const text = (r.value || '').trim();
            console.log(`  ${b(cream(m.label))} ${slate('(' + m.role + ')')}`);
            console.log('');
            console.log(text.split('\n').map(l => '  ' + l).join('\n'));
            answers.push(`### ${m.label}\n${text}`);
          } else {
            console.log(`  ${b(cream(m.label))} ${sage('failed')} ${slate('— ' + r.reason.message.split('\n')[0])}`);
          }
        });
        console.log('');
        ui.divider('line');

        if (answers.length > 0) {
          messages.push({ role: 'user', content: cmdArg });
          messages.push({ role: 'assistant', content: `[council of ${answers.length}]\n\n${answers.join('\n\n')}` });
          awaitingOutcome = decisionId;
          console.log(slate(`  council of ${answers.length} · how'd it go? 1 kept · 2 undid · 3 redid · 4 flopped · or keep typing`));
        } else {
          try { labelOutcome(decisionId, 'failed', null, { auto: true }); } catch { /* keep going */ }
          console.log(`  ${sage('Every council member failed — check')} ${cream('/provider')}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'provider' || cmd === 'route') {
        const rows = [
          ['Route', routeLabel(route, config), 'green'],
        ];
        for (const h of harnesses) {
          if (!h.installed && !['aider', 'goose', 'amp', 'droid'].includes(h.id)) {
            rows.push([h.label, 'not installed']);
            continue;
          }
          if (!h.installed) continue; // hide the long tail of uninstalled extras
          const via = h.headless ? '' : ' · /work only';
          rows.push([h.label, `ready — ${h.bestFor || h.role}${via}`, 'green']);
        }
        rows.push(['API key', config?.apiKey ? config.apiKey.slice(0, 8) + '... (' + (config.provider || 'anthropic') + ')' : 'not set — optional', config?.apiKey ? 'green' : 'yellow']);
        rows.push(['Fallback', (config?.fallback === 'auto' ? 'auto-switch on failure' : 'ask before switching') + ' — /fallback to change', 'peach']);
        if (route?.type === 'api') rows.push(['Model', modelName(currentModel), 'cyan']);
        if (route?.type === 'harness' && harnessModel) rows.push(['Model', `${harnessModel} — passed to ${HARNESSES[route.id].label}`, 'cyan']);
        ui.statusPanel('Provider', rows);
        console.log(`  ${sage('One terminal. Every AI worker. Shared project memory.')}`);
        console.log(`  ${slate('switch:')} ${cream('/use <' + useOptions().join('|') + '>')} ${slate('· interactive tools: /work <hermes|pi>')}`);
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'fallback') {
        const arg = cmdArg?.trim().toLowerCase();
        if (arg === 'ask' || arg === 'auto') {
          config = loadConfig() || {};
          config.fallback = arg;
          saveConfig(config);
          console.log(`  ${teal('●')} ${sage('Fallback:')} ${cream(arg === 'auto' ? 'auto-switch to the next route on failure' : 'ask before switching')}`);
          console.log(`  ${slate('either way your project context and record stay intact')}`);
        } else {
          console.log(`  ${sage('Fallback is')} ${cream(config?.fallback === 'auto' ? 'auto-switch' : 'ask first')} ${slate('— when your route hits a usage wall, context travels to the next one.')}`);
          console.log(`  ${sage('Usage:')} ${cream('/fallback ask')} ${slate('·')} ${cream('/fallback auto')}`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'use') {
        if (!cmdArg) {
          console.log(`  ${sage('Current route:')} ${cream(routeLabel(route, config))}`);
          console.log(`  ${sage('Usage:')} ${cream('/use <' + useOptions().join('|') + '>')}`);
          const workOnlyInstalled = harnesses.filter(h => h.installed && !h.headless);
          if (workOnlyInstalled.length > 0) {
            console.log(`  ${slate('interactive tools: /work <' + workOnlyInstalled.map(h => h.id).join('|') + '>')}`);
          }
          rl.prompt();
          return;
        }
        // Forgiving aliases — people type the tool's everyday name, not its id.
        // `/use claude` should just work, not bounce off "Unknown route".
        const USE_ALIASES = {
          claude: 'claude-code', cc: 'claude-code', claudecode: 'claude-code',
          gpt: 'codex', chatgpt: 'codex', openai: 'codex',
          grokbuild: 'grok',
        };
        const raw = cmdArg.trim().toLowerCase();
        const target = USE_ALIASES[raw] || raw;
        if (target === 'api') {
          if (!config?.apiKey) {
            console.log(`  ${ember('!')} ${sage('No API key set — run /key first.')}`);
          } else {
            config = loadConfig() || {};
            config.defaultRoute = 'api';
            saveConfig(config);
            route = { type: 'api' };
            console.log(`  ${teal('●')} ${sage('Default route:')} ${cream(routeLabel(route, config))}`);
          }
        } else if (HARNESSES[target]) {
          if (!harnesses.find(h => h.id === target)?.installed) {
            console.log(`  ${ember('!')} ${sage(HARNESSES[target].label + ' is not installed on this machine.')}`);
          } else if (!HARNESSES[target].args) {
            console.log(`  ${sage(HARNESSES[target].label + ' is interactive-only — drop into it with')} ${cream('/work ' + target)} ${sage('(phewsh records the outcome when you return)')}`);
          } else {
            config = loadConfig() || {};
            config.defaultRoute = target;
            saveConfig(config);
            route = { type: 'harness', id: target };
            console.log(`  ${teal('●')} ${sage('Default route:')} ${cream(routeLabel(route, config))} ${slate('— saved across sessions')}`);
          }
        } else {
          console.log(`  ${sage('Unknown route. Options:')} ${cream(Object.keys(HARNESSES).join(', ') + ', api')}`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'harnesses' || cmd === 'agents') {
        console.log('');
        console.log(`  ${b(cream('Your AI tools'))} ${slate('— phewsh keeps them all, aligned. You never pick just one.')}`);
        ui.divider('line');
        // The record feeding back: kept-rate per route, where it's earned.
        let hStats = null;
        try { hStats = outcomeStats({ project: projectName }); } catch { /* best-effort */ }
        // Installed first, then the rest so the table also teaches what exists.
        const sorted = [...harnesses].sort((a, b) => (b.installed - a.installed));
        let lastGroup = null;
        for (const h of sorted) {
          const group = h.installed ? 'in' : 'out';
          if (group !== lastGroup) {
            console.log(`  ${slate(h.installed ? 'on this machine — context routes straight through their login:' : 'available — install any of these and phewsh picks it up:')}`);
            lastGroup = group;
          }
          const active = route?.type === 'harness' && route.id === h.id ? ` ${teal('● active')}` : '';
          const dot = h.installed ? green('●') : slate('○');
          const mode = h.headless ? '' : slate(' · /work only');
          const badge = hStats ? learning.keptBadge(hStats, h.id) : '';
          const rec = badge ? ` ${slate('· ' + badge)}` : '';
          console.log(`    ${dot} ${cream(h.id.padEnd(11))} ${sage((h.bestFor || h.role || h.label).padEnd(38))} ${slate(h.label)}${mode}${rec}${active}`);
        }
        ui.divider('line');
        const learned = hStats ? learning.learningLine(hStats) : null;
        if (learned) console.log(`  ${teal('↪')} ${sage(learned)} ${slate('— route accordingly')}`);
        console.log(`  ${sage('keep your tools, keep one record:')}`);
        console.log(`    ${teal('/use')} ${slate('<id>')}     ${sage('route your typing through that tool')}`);
        console.log(`    ${teal('@<id>')} ${slate('<msg>')}   ${sage('one message to one tool — context stays shared')}`);
        console.log(`    ${teal('/council')} ${slate('<q>')}  ${sage('ask every installed tool at once, keep the best answer')}`);
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'outcomes') {
        try {
          // execFileSync (argv array, no shell) so the labeling prompt owns
          // stdin AND REPL input can't be shell-interpreted (hardening).
          const { execFileSync } = require('child_process');
          const outcomesArgs = cmdArg ? cmdArg.split(/\s+/).filter(Boolean) : [];
          execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js'), 'outcomes', ...outcomesArgs], { stdio: 'inherit' });
        } catch { /* user quit mid-labeling — fine */ }
        rl.prompt();
        return;
      }

      if (cmd === 'update' || cmd === 'upgrade') {
        const updateSpin = ui.spinner('checking for updates', 'gentle');
        try {
          const pkg = require('../../package.json');
          const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: AbortSignal.timeout(5000) });
          const data = await res.json();
          if (!data.version || data.version === pkg.version) {
            updateSpin.stop(`${teal('●')} ${sage('Already on the latest version (' + pkg.version + ')')}`);
            console.log('');
            rl.prompt();
            return;
          }
          updateSpin.stop(`${peach(pkg.version)} ${sage('→')} ${peach(data.version)}`);
          console.log(`  ${sage('Installing...')}\n`);
          const { execSync } = require('child_process');
          execSync(`npm install -g ${pkg.name}@latest`, { stdio: 'inherit' });
          console.log(`\n  ${teal('●')} ${sage('Updated to')} ${cream(data.version)}`);
          console.log(`  ${slate('Restart phewsh to use the new version.')}\n`);
        } catch (err) {
          updateSpin.stop(`${ember('!')} ${sage('Update failed:')} ${err.message}`);
          console.log(`  ${sage('You can update manually:')} ${cream('npm install -g phewsh')}\n`);
        }
        rl.prompt();
        return;
      }

      if (cmd === 'watch') {
        if (!fs.existsSync(intentDir())) {
          console.log(`\n  ${ember('!')} ${sage('No .intent/ found. Run /init first.')}\n`);
          rl.prompt();
          return;
        }
        const { spawn } = require('child_process');
        const watchArgs = ['watch'];
        if (cmdArg) watchArgs.push(...cmdArg.split(/\s+/));
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js'), ...watchArgs], {
          stdio: 'inherit',
          detached: false,
        });
        child.on('error', (err) => {
          console.log(`  ${ember('!')} ${sage('Watch failed:')} ${err.message}`);
        });
        // Store ref so we can clean up on exit
        if (!global._phewshChildren) global._phewshChildren = [];
        global._phewshChildren.push(child);
        console.log(`\n  ${teal('●')} ${sage('Watch started — .intent/ syncing in background')}`);
        console.log(`  ${slate('CLAUDE.md and cloud will auto-update on changes')}\n`);
        rl.prompt();
        return;
      }

      if (cmd === 'serve') {
        const { spawn } = require('child_process');
        const serveArgs = ['serve'];
        if (cmdArg) serveArgs.push(...cmdArg.split(/\s+/));
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js'), ...serveArgs], {
          stdio: 'inherit',
          detached: false,
        });
        child.on('error', (err) => {
          console.log(`  ${ember('!')} ${sage('Serve failed:')} ${err.message}`);
        });
        if (!global._phewshChildren) global._phewshChildren = [];
        global._phewshChildren.push(child);
        console.log(`\n  ${teal('●')} ${sage('Serve started — execution bridge running')}\n`);
        rl.prompt();
        return;
      }

      if (cmd === 'work' || cmd === 'switch') {
        // Native handoff lifecycle: verify -> brief -> release the terminal ->
        // observe -> reconcile. The harness owns its UI while it runs.
        const target = cmdArg?.trim().toLowerCase() || (route?.type === 'harness' ? route.id : 'claude-code');
        const h = HARNESSES[target];
        if (!h) {
          console.log(`  ${sage('Unknown harness. Options:')} ${cream(Object.keys(HARNESSES).join(', '))}`);
          rl.prompt();
          return;
        }
        if (!harnesses.find(x => x.id === target)?.installed) {
          const how = INSTALL[target];
          console.log('');
          console.log(`  ${ember('!')} ${sage(h.label + ' isn\'t installed on this machine yet.')}`);
          if (how) {
            const isCmd = !how.startsWith('see ');
            console.log(`  ${sage('Install:')}  ${isCmd ? cream(how) : slate(how)}`);
          }
          if (h.auth) console.log(`  ${sage('Sign in:')}  ${slate(h.auth + ' (the tool prompts you on first run)')}`);
          console.log(`  ${sage('Then run:')} ${cream('phewsh ' + target)} ${slate('— phewsh briefs it and hands off')}`);
          console.log('');
          rl.prompt();
          return;
        }

        const preflightTruth = await auditTruth();
        const before = captureSnapshot(preflightTruth);
        const generatedBrief = await generateBrief({ report: preflightTruth });
        const launchBrief = `${generatedBrief.content}\n\nYou are receiving a PHEWSH handoff brief — acknowledge in one short line that you've loaded it, then proceed. Use it as project context, preserve native tool behavior, and verify claims against the repository before acting. When you finish, exit this tool — PHEWSH resumes, runs an automatic postflight comparing what changed against this brief, and offers reconciliation.\n\nAmbient guidance: the human may not know any phewsh commands — make the layer felt, not invoked. Do their request first; when you make a real decision, ship something, or change direction, offer in plain language to keep the shared record current ("want me to reconcile this into phewsh so your other tools inherit it?"). Keep it subtle, never nag. When phewsh context shaped your reply, sign off quietly with 😮‍💨🤫 so they feel the continuity layer working.`;
        const savedBrief = persistBrief(generatedBrief.content, { project: projectName, route: target });
        const launch = interactiveLaunchArgs(target, launchBrief, { model: harnessModel });
        // Foolproof fallback: the brief on the clipboard survives the native
        // tool taking over the terminal and any trust/permission gate. If the
        // tool ignores or never received it, the human just pastes it in.
        const briefOnClipboard = copyToClipboard(launchBrief);
        const decisionId = recordDecision({
          project: projectName,
          route: target,
          mode: sessionMode,
          summary: `interactive ${h.label} session in ${projectName}`,
        });
        decisionsThisSession++;
        console.log('');
        console.log(`  ${b(cream('Work preflight'))} ${slate('— verified before native handoff')}`);
        ui.divider('line');
        console.log(`  ${sage('Route:')} ${cream(h.label)}${harnessModel ? slate(' · model ' + harnessModel) : slate(' · native default model')}`);
        console.log(`  ${sage('Git:')} ${cream(preflightTruth.git.shortHead || 'unknown')} ${slate('· ' + before.dirty.length + ' uncommitted path(s) before work')}`);
        console.log(`  ${sage('Truth:')} ${preflightTruth.conflicts.length ? peach(preflightTruth.conflicts.length + ' conflict(s) carried explicitly') : green('no explicit conflicts')}`);
        console.log(`  ${sage('Brief:')} ${launch.briefingPassed ? green('auto-attached to ' + h.label) : peach('not auto-injectable for this tool')}${briefOnClipboard ? slate(' · copied to your clipboard') : ''}`);
        console.log(`  ${sage('Record:')} ${savedBrief.written ? slate('exact briefing saved locally' + (savedBrief.file ? ' → ' + savedBrief.file : '')) : peach('briefing persistence unavailable; launch continues')}`);
        if (briefOnClipboard) {
          console.log(`  ${slate('Foolproof:')} ${sage('if ' + h.label + ' shows a trust prompt or doesn\'t mention the brief, just paste it in')} ${slate('(⌘V / Ctrl+V)')}`);
        } else if (savedBrief.file) {
          console.log(`  ${slate('Foolproof:')} ${sage('if ' + h.label + ' doesn\'t pick up the brief, paste from')} ${cream(savedBrief.file)}`);
        }
        console.log(`  ${slate('After exit PHEWSH will compare Git, files, intent claims, generated drift, and contradictions.')}`);
        ui.divider('line');
        console.log(`  ${teal('●')} ${sage('Handing the terminal to')} ${cream(h.label)} ${slate('— exit to return for postflight')}`);
        console.log('');
        recordSessionEvent(target, projectName, 'work_started', {
          taskId: decisionId,
          summary: `interactive ${h.label} session`,
          gitHead: before.head,
          dirtyPaths: before.dirty,
          briefingHash: savedBrief.hash,
          briefingFile: savedBrief.file,
          briefingPassed: launch.briefingPassed,
        });
        pasteMode(false);
        rl.pause();
        const { spawnSync } = require('child_process');
        const res = spawnSync(h.bin, launch.args, { stdio: 'inherit' });
        rl.resume();
        pasteMode(true);
        const postflight = await createPostflight(before);
        lastTransitionReport = postflight;
        recordSessionEvent(target, projectName, 'task_complete', {
          taskId: decisionId,
          success: res.status === 0,
          summary: `interactive ${h.label} session`,
          gitHeadBefore: before.head,
          gitHeadAfter: postflight.afterHead,
          changedFiles: postflight.files,
          conflicts: postflight.conflicts,
          briefingHash: savedBrief.hash,
        });
        awaitingOutcome = decisionId;
        // Ambient outcome capture: infer a provisional verdict from what the
        // session actually did, so the human confirms with one keystroke
        // instead of recalling. Honest — it's a confirmed default, not a
        // silent label; the human can always correct it with 1-4.
        provisionalOutcome = (postflight.headChanged || postflight.files.length > 0) ? 'kept' : null;
        console.log('');
        console.log(formatObservedReport(postflight, { title: `${h.label} session ended — postflight` }));
        console.log('');
        if (provisionalOutcome) {
          const why = postflight.headChanged ? 'committed work is in your repo' : 'changes are in your working tree';
          console.log(`  ${teal('●')} ${sage('Back in phewsh.')} ${sage('Looks ')}${green('kept')} ${slate('(' + why + ') — enter ↵ to confirm')}`);
          console.log(`  ${slate('or correct it: 1 kept · 2 undid · 3 redid · 4 flopped · /reconcile · /switch <tool>')}`);
        } else {
          console.log(`  ${teal('●')} ${sage('Back in phewsh.')} ${slate('No changes detected. 1 kept · 2 undid · 3 redid · 4 flopped · /reconcile · /switch <tool>')}`);
        }
        console.log(`  ${slate('continuing elsewhere?')} ${cream('/handoff')} ${slate('shows the updated brief the next tool inherits')}`);
        // Auto-reconcile OFFER (human-gated, never auto-writes). Only when the
        // work left project UNDERSTANDING stale — the docs now disagree with the
        // code or a projection drifted. Ordinary implementation diffs and a merely
        // dirty tree do NOT trigger this; that would be noise.
        try {
          const truthDrift = (postflight.conflicts || []).filter(c =>
            /current-state intent disagrees|current-state claims may be stale|should be regenerated|before authoritative intent updated/i.test(c));
          if (truthDrift.length) {
            console.log('');
            console.log(`  ${ember('⚠')} ${sage('Your project understanding may now be stale:')}`);
            console.log(`    ${slate(truthDrift[0])}`);
            console.log(`  ${sage('Bring the record up to date so the next tool inherits the truth →')} ${cream('/reconcile')} ${slate('(proposes an exact diff; writes only after you approve)')}`);
          }
        } catch { /* the offer is a nicety, never a blocker */ }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'run') {
        if (!cmdArg) {
          console.log(`  ${sage('Usage:')} ${cream('/run <prompt>')}`);
          rl.prompt();
          return;
        }
        if (route?.type === 'harness') {
          try {
            await runViaHarness(route.id, systemPrompt, cmdArg);
            console.log(slate(`  via ${HARNESSES[route.id].label} · one-shot, no history`));
          } catch (err) {
            console.error(`\n  ${ember('!')} ${err.message}\n`);
          }
          console.log('');
          rl.prompt();
          return;
        }
        if (!config?.apiKey) {
          console.log(`  ${ember('!')} ${sage('No API key and no agent CLI installed. /key or install Claude Code.')}`);
          rl.prompt();
          return;
        }
        console.log('');
        try {
          const result = await streamChat(
            config.apiKey,
            [{ role: 'user', content: cmdArg }],
            systemPrompt,
            modelId(currentModel)
          );
          if (result.promptTokens || result.completionTokens) {
            console.log(slate(`  ${result.promptTokens || '?'}→${result.completionTokens || '?'} tokens`));
          }
          trackSap({
            userId: config.supabaseUserId,
            source: 'cli',
            model: modelId(currentModel),
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            accessToken: config.supabaseAccessToken,
          });
        } catch (err) {
          console.error(`\n  ${err.message}\n`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'remember') {
        // Record's zero-AI verb: jot a decision/lesson to .intent/decisions.md
        // so it sticks and every tool inherits it. No model needed.
        const rec = require('../lib/record');
        const text = cmdArg.replace(/^["']|["']$/g, '').trim();
        console.log('');
        if (!text) {
          const ns = rec.notes();
          if (ns.length === 0) {
            console.log(`  ${slate('Nothing remembered yet. Jot a decision:')} ${cream('/remember we decided to keep packs opt-in')}`);
          } else {
            console.log(`  ${b(cream('RECORD'))} ${slate('— what you decided · .intent/decisions.md')}`);
            ns.slice(-12).forEach(l => console.log(`  ${slate(l)}`));
          }
        } else {
          const r = rec.remember(text);
          if (r) console.log(`  ${green('✓')} ${sage('Remembered.')} ${slate('Every tool reading .intent/ now sees it. · .intent/decisions.md')}`);
          else console.log(`  ${slate('Could not write .intent/decisions.md here.')}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      if (cmd === 'pack' || cmd === 'packs') {
        // Opt-in workflow packs (Karpathy, GSD…) — attributed, reversible,
        // project-scoped. Delegate to the real `phewsh pack` command so the
        // preview + [y/N] confirm get the live stdin (same handoff as /intent).
        pasteMode(false);
        rl.pause();
        const { spawnSync } = require('child_process');
        const passArgs = cmdArg ? cmdArg.split(/\s+/).filter(Boolean) : [];
        spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js'), 'pack', ...passArgs], { stdio: 'inherit' });
        rl.resume();
        pasteMode(true);
        rl.prompt();
        return;
      }

      // Unknown slash command — suggest the nearest real one instead of a dead end.
      const guess = closest(cmd, [...KNOWN_COMMANDS]);
      if (guess) {
        console.log(`  ${sage('No command')} ${cream('/' + cmd)}${sage('. Did you mean')} ${teal('/' + guess)}${sage('?')} ${slate('· enter = run it · /help all for everything')}`);
        pendingDidYouMean = '/' + guess + (cmdArg ? ' ' + cmdArg : '');
      } else {
        console.log(`  ${sage('No command')} ${cream('/' + cmd)}${sage('.')} ${slate('Type')} ${teal('/next')} ${slate('for what to do, or')} ${teal('/help')} ${slate('for everything.')}`);
      }
      rl.prompt();
      return;
    }

    // Regular input → route it (harness = your subscription, api = your key)
    if (!route) {
      console.log('');
      console.log(`  ${sage('That request is valid — phewsh just needs an AI worker behind the door.')}`);
      console.log(`  ${cream('phewsh setup')} ${sage('detects installed tools and picks a route')}`);
      console.log(`  ${cream('/key')} ${sage('adds an API key, or install Claude Code / Codex / Gemini and rerun phewsh')}`);
      console.log(`  ${slate('Once a route exists, plain typing works; no slash command needed.')}`);
      console.log('');
      rl.prompt();
      return;
    }

    const modeHint = sessionMode
      ? Object.values(INTENT_MODES).find(m => m.id === sessionMode)?.hint
      : null;
    const fullSystem = modeHint ? `${systemPrompt}\n\n${modeHint}` : systemPrompt;

    // @mention: route ONE message to a specific harness without switching.
    // The answer lands in the shared history, so the next turn — on any
    // route — knows what was said. "@codex review this" mid-claude-session.
    const mention = input.match(/^@([\w-]+)\s+([\s\S]+)/);
    if (mention) {
      const q = mention[1].toLowerCase();
      const target = harnesses.find(h => h.installed && h.headless &&
        (h.id === q || h.id.startsWith(q) || h.label.toLowerCase().replace(/\s+/g, '-').startsWith(q)));
      if (!target) {
        console.log(`  ${sage('No installed harness matches')} ${cream('@' + q)} ${sage('—')} ${cream('/provider')} ${sage('shows who\'s here.')}`);
        rl.prompt();
        return;
      }
      const okMention = await runHarnessTurn(mention[2], target.id, fullSystem);
      if (!okMention) await offerFallbacks(mention[2], fullSystem, target.id);
      console.log('');
      rl.prompt();
      return;
    }

    showRouteCoach(input);

    const ok = route.type === 'harness'
      ? await runHarnessTurn(input, route.id, fullSystem)
      : await runApiTurn(input, fullSystem);

    if (!ok) {
      await offerFallbacks(input, fullSystem, route.type === 'harness' ? route.id : 'api');
    }

    console.log('');
    rl.prompt();
  }

  const lineDispatcher = createLineDispatcher(handleInput, {
    onBatch: ({ input, lines }) => { collapsePastedEcho(lines, input); cmdHistory.append(input); },
    onNoop: () => {
      // Bare Enter skips the "why?" prompt — the label still stands.
      if (awaitingWhy) { awaitingWhy = null; console.log(''); rl.prompt(); return; }
      // Bare Enter accepts a pending "did you mean" suggestion.
      if (pendingDidYouMean) {
        const cmd = pendingDidYouMean;
        pendingDidYouMean = null;
        handleInput(cmd).catch(() => {});
        return;
      }
      rl.prompt();
    },
    onError: (err) => {
      console.error(`\n  ${ember('!')} ${sage('Input failed:')} ${err.message}`);
      rl.prompt();
    },
  });
  rl.on('line', lineDispatcher.push);

  rl.on('close', async () => {
    await lineDispatcher.drain();
    console.log(`\n  ${sage('session ended')}\n`);
    process.exit(0);
  });

  // Doorway shortcut: `phewsh <harness>` sets PHEWSH_AUTOWORK so we drop the
  // user straight into /work for that tool after the front door renders.
  const autoWork = process.env.PHEWSH_AUTOWORK;
  if (autoWork && HARNESSES[autoWork]) {
    delete process.env.PHEWSH_AUTOWORK;
    handleInput('/work ' + autoWork).catch(() => {});
  }
}

main().catch(err => {
  console.error('\n  Error:', err.message);
  if (process.env.PHEWSH_DEBUG) console.error('\n' + err.stack);
  else console.error('  (run PHEWSH_DEBUG=1 phewsh for the full trace)');
  process.exit(1);
});
