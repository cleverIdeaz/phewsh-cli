// Route coach — tiny deterministic hints for the front door.
//
// PHEWSH should not become a new agent. It should notice when the user's
// message is better served by a native harness, a second opinion, or a council
// and point to that door without blocking the current turn.

const CODE_RE = /\b(implement|edit|change|patch|fix|debug|bug|refactor|test|tests|failing|failure|build|ship|commit|diff|file|code|function|module|schema|migration|auth|deploy|npm|lint)\b/i;
const STRONG_CODE_RE = /\b(implement|edit|change|patch|fix|debug|refactor|failing|failure|commit|schema|migration|auth|deploy|lint)\b/i;
const REVIEW_RE = /\b(review|audit|critique|risk|risks|regression|security|edge case|edge cases|sanity check)\b/i;
const COMPARE_RE = /\b(compare|options|which|tradeoff|trade-off|pros and cons|brainstorm|strategy|what should i do|where should i start|best approach|decide)\b/i;
const INTENT_RE = /\b(i want to build|idea|project|startup|app|tool|product|trying to build|what i'm building|what i am building)\b/i;

function routeId(route) {
  if (!route) return null;
  if (typeof route === 'string') return route;
  return route.id || route.type || null;
}

function installed(harnesses, id) {
  return (harnesses || []).find((h) => h.id === id && h.installed);
}

function headless(harnesses) {
  return (harnesses || []).filter((h) => h.installed && h.headless);
}

function firstInstalled(harnesses, ids) {
  return ids.map((id) => installed(harnesses, id)).find(Boolean) || null;
}

function canInjectBrief(h) {
  return !!h && typeof h.interactiveArgs === 'function';
}

function routeCoach(input, {
  route = null,
  harnesses = [],
  hasIntentDir = false,
  turnsThisSession = 0,
} = {}) {
  const text = String(input || '').trim();
  if (!text || text.startsWith('/') || text.startsWith('@')) return null;

  const current = routeId(route);
  const codeish = CODE_RE.test(text);
  const strongCode = STRONG_CODE_RE.test(text);
  const reviewish = REVIEW_RE.test(text);
  const compareish = COMPARE_RE.test(text);

  if (!hasIntentDir && turnsThisSession === 0 && INTENT_RE.test(text) && text.length >= 40) {
    return {
      id: 'clarify-first',
      command: '/clarify',
      message: 'This sounds like raw project intent; clarify turns it into memory every tool can share.',
    };
  }

  if (codeish && (strongCode || text.length >= 80)) {
    const target = firstInstalled(harnesses, ['claude-code', 'opencode', 'codex', 'gemini']);
    if (canInjectBrief(target)) {
      return {
        id: `native-work:${target.id}`,
        command: `/work ${target.id}`,
        message: `${target.label} native mode is the better door for repo changes; phewsh will verify before and after.`,
      };
    }
  }

  if (reviewish && !strongCode) {
    const codex = installed(harnesses, 'codex');
    if (codex && current !== 'codex') {
      return {
        id: 'review-with-codex',
        command: '@codex <same ask>',
        message: 'For review, use a second model without switching the whole session.',
      };
    }
  }

  if (compareish && headless(harnesses).length >= 2) {
    return {
      id: 'ask-council',
      command: '/council <same ask>',
      message: 'This is a judgment call; ask every installed tool and keep the best answer.',
    };
  }

  return null;
}

module.exports = { routeCoach };
