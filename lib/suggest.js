// Self-aware guidance — phewsh watching the user's state and surfacing the
// single most useful next step, so nobody has to memorize commands like
// `phewsh seq --dry-run`. Pure and deterministic: feed it a state snapshot,
// get back ranked suggestions. The session layer renders + offers them.
//
// Each suggestion: { id, priority, message, command, why }
//   message — one plain line, what's true right now (the caller colorizes)
//   command — the exact thing to run (a slash command or shell command)
//   why     — one short clause: why it helps (shown on /next, not inline)
//
// Design rules:
//   - Never nag: a suggestion only fires when its trigger is genuinely met.
//   - One at a time inline; up to a few on demand via /next.
//   - Ordered by leverage — capture-intent and learn-from-outcomes first,
//     because those are the moat; convenience nudges last.

/**
 * @param {object} s state snapshot
 * @param {boolean} s.hasIntentDir      — .intent/ exists in cwd
 * @param {number}  s.intentFileCount   — .intent/ files loaded
 * @param {number}  s.pendingOutcomes   — unlabeled decisions (this project)
 * @param {string[]} s.installedHarnesses — harness ids present on the machine
 * @param {string[]} [s.usedRoutes]     — harness ids used this session
 * @param {string|null} s.route         — current route id
 * @param {number}  s.turnsThisSession  — exchanges so far
 * @param {boolean} s.seqStale          — .intent/ newer than CLAUDE.md (drift)
 * @param {boolean} s.ambientOn         — ambient hooks installed
 * @returns {Array} ranked suggestions (highest leverage first)
 */
function suggestAll(s = {}) {
  const {
    hasIntentDir = false,
    intentFileCount = 0,
    pendingOutcomes = 0,
    installedHarnesses = [],
    usedRoutes = [],
    route = null,
    turnsThisSession = 0,
    seqStale = false,
    ambientOn = false,
    shimOn = false,
    commitsSinceIntent = 0,
    packsInstalled = false,  // any opt-in workflow pack present in cwd
    bestKeeper = null,   // { route, label, keptRate, total } from the record, or null
  } = s;

  const out = [];

  // 1. Working without captured intent — the biggest miss. Compatible tools here
  //    could be reading the same goal; right now none are.
  if (intentFileCount === 0 && turnsThisSession >= 1) {
    const noun = turnsThisSession === 1 ? 'message' : 'messages';
    out.push({
      id: 'capture-intent',
      priority: 100,
      message: `${turnsThisSession} ${noun} in, no captured intent — supported tools have no shared project record.`,
      command: '/clarify',
      why: 'Turns what you just said into a spec supported adapters (including Claude Code and Codex) can read.',
    });
  }

  // 2. Some real calls judged, others not — a verdict or two is what teaches
  //    phewsh which tool to trust. Payoff-framed, no scary backlog number (the
  //    big count read as a chore, not a payoff).
  if (pendingOutcomes >= 3) {
    out.push({
      id: 'label-outcomes',
      priority: 90,
      message: `Tell phewsh what worked — a quick verdict teaches it which tool to trust for you.`,
      command: '/outcomes',
      why: 'Labeling kept/reverted is the dataset; it weights future routing and recall.',
    });
  }

  // 3. .intent/ drifted from one or more harness projections.
  if (hasIntentDir && seqStale) {
    out.push({
      id: 'resync-harness-context',
      priority: 80,
      message: `Your .intent/ and harness context disagree — one or more tools may read stale context.`,
      command: '/reload',
      why: 'Reloads canonical intent and refreshes every existing managed harness block.',
    });
  }

  // 3b. Code shipped but .intent/ never caught up — the deeper drift that ate
  //     phewsh's own dogfood (versions shipped while next.md stayed stale).
  //     CLAUDE.md self-heals, but the *intent* itself is behind the work.
  if (hasIntentDir && commitsSinceIntent >= 3) {
    out.push({
      id: 'intent-behind-code',
      priority: 85,
      message: `${commitsSinceIntent} commits since your .intent/ was updated — the record is behind the work.`,
      command: '/wrap',
      why: 'Folds what you shipped into next.md/status.md so continuity reflects reality, not last week.',
    });
  }

  // 4. Multiple harnesses installed, only leaning on one — council is free leverage.
  const others = installedHarnesses.filter(h => h !== route);
  if (installedHarnesses.length >= 2 && turnsThisSession >= 3 && others.length >= 1) {
    out.push({
      id: 'try-council',
      priority: 60,
      message: `You have ${installedHarnesses.length} agents installed but lean on one — the rest are idle.`,
      command: '/council ',
      why: 'Asks every installed harness in parallel; you keep the best answer, context shared.',
    });
  }

  // 4b. The record has a clear favorite that isn't your current route —
  //     auto-weighting: lean on what actually holds for you.
  if (bestKeeper && bestKeeper.route !== route && bestKeeper.total >= 4 && bestKeeper.keptRate >= 0.6) {
    out.push({
      id: 'prefer-best-route',
      priority: 55,
      message: `${bestKeeper.label || bestKeeper.route} keeps best in your record (${Math.round(bestKeeper.keptRate * 100)}%, ${bestKeeper.total} labeled).`,
      command: `/use ${bestKeeper.route}`,
      why: 'The record weights routing — lean on the tool whose work you actually keep.',
    });
  }

  // 5. Ambient off — offer the concrete, reversible adapter layer. Claude Code
  // gets session hooks; compatible installed tools get managed skills/context
  // blocks. Project truth remains in .intent/ and no transcript is copied.
  if (!ambientOn && installedHarnesses.length > 0) {
    out.push({
      id: 'enable-ambient',
      priority: 78,
      message: 'Ambient is off — preview/install independent, reversible native adapters for supported tools. .intent/ stays project truth.',
      command: 'phewsh ambient on',
      why: 'Installs only phewsh-managed skill, hook, and context adapters. `phewsh ambient off` removes unchanged managed pieces.',
    });
  }

  // 6. Shim off — the guaranteed proof-of-life. phewsh prints a status banner
  // when you launch any tool, then runs the real tool. Offer once it's not on.
  if (!shimOn && installedHarnesses.length > 0) {
    out.push({
      id: 'enable-shim',
      priority: 48,
      message: `See phewsh work every time you launch a tool — a status banner (intent loaded, record current) before Claude/Codex/etc.`,
      command: 'phewsh shim on',
      why: 'phewsh prints the proof itself, so it\'s guaranteed; the real tool always runs. Reversible: `phewsh shim off`.',
    });
  }

  // 7. Workflow packs — lowest-leverage convenience, surfaced only once the
  // moat work (intent, outcomes, ambient, shim) is handled. phewsh core stays
  // continuity; packs are opt-in, attributed schools of thought you can add.
  if (hasIntentDir && !packsInstalled && turnsThisSession >= 2) {
    out.push({
      id: 'try-packs',
      priority: 22,
      message: `One continuity layer, many schools of thought — add an opt-in workflow pack (Karpathy, GSD…).`,
      command: '/pack',
      why: 'Attributed, reversible, project-scoped. Browse with /pack; nothing is injected without your y/N.',
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

/** The single highest-leverage suggestion, or null. */
function suggest(s = {}) {
  const all = suggestAll(s);
  return all.length ? all[0] : null;
}

module.exports = { suggest, suggestAll };
