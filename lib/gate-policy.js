'use strict';

// Deterministic pre-action policy — the enforcement core of the Decision Gate.
//
// Pure and provider-neutral: given an action envelope it returns a decision.
// No I/O, no provider coupling — the hook adapter (commands/hook.js pre-tool)
// feeds it the action and renders the provider-specific response. This is the
// "deterministic enforcement" layer from cli/docs/pre-action-architecture.md;
// it does NOT replace the Decision Gate, it is how the gate acts before a tool
// runs. Decisions: 'allow' | 'ask' (require human) | 'deny' (block).
//
// Design rules: fail OPEN (an empty/garbled envelope returns allow — a policy
// must never trap the user), and never inspect file CONTENTS (we judge the
// action's target/shape, not your code or secrets).

const path = require('path');

// Tools that write/modify the filesystem — common names across providers.
const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'create_file', 'apply_patch', 'str_replace_editor', 'edit_file',
]);

// Shell/command tools.
const SHELL_TOOLS = new Set(['Bash', 'shell', 'run_command', 'run_terminal_cmd']);

// Paths an agent should never silently write — credentials, keys, VCS internals.
const DEFAULT_PROTECTED = [
  '.env', '.env.*', '*.pem', '*.key', 'id_rsa', 'id_ed25519',
  '.git/', '.npmrc', '.aws/', '.ssh/', '.phewsh/config.json',
];

// High-blast-radius shell patterns that warrant a human OK.
const DESTRUCTIVE = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, label: 'recursive force delete' },
  { re: /\bgit\s+push\b[^\n]*--force/, label: 'git force-push' },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'git hard reset' },
  { re: /\bDROP\s+(TABLE|DATABASE)\b/i, label: 'SQL DROP' },
  { re: /\bsudo\b/, label: 'sudo' },
  { re: /\bchmod\s+-R\b/, label: 'recursive chmod' },
  { re: /\bmkfs\b|\bdd\s+if=/, label: 'disk write' },
  { re: /\bcurl\b[^\n]*\|\s*(sh|bash)\b|\bwget\b[^\n]*\|\s*(sh|bash)\b/, label: 'pipe-to-shell' },
];

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

// Does `target` match any protected entry? Directory entries (trailing '/')
// match anywhere in the path; file globs match the basename or full path.
function isProtected(target, protectedList) {
  if (!target || typeof target !== 'string') return false;
  const norm = target.replace(/^\.\//, '');
  const base = path.basename(norm);
  return protectedList.some(p => {
    if (p.endsWith('/')) return norm.split('/').includes(p.slice(0, -1)) || norm.startsWith(p);
    const re = globToRegExp(p);
    return re.test(base) || re.test(norm);
  });
}

function writeTarget(toolInput = {}) {
  return toolInput.file_path || toolInput.path || toolInput.notebook_path
    || toolInput.filename || toolInput.target_file || null;
}

// envelope: { toolName, toolInput, constraints, protectedFiles }
function evaluateAction(envelope = {}) {
  try {
    const { toolName, toolInput = {}, constraints = {}, protectedFiles = [] } = envelope;
    if (!toolName) return { decision: 'allow', reason: '' };
    const protectedList = [...DEFAULT_PROTECTED, ...(Array.isArray(protectedFiles) ? protectedFiles : [])];

    // 1. Writes to a protected path → deny (only a deliberate human act should).
    if (WRITE_TOOLS.has(toolName)) {
      const target = writeTarget(toolInput);
      if (isProtected(target, protectedList)) {
        return { decision: 'deny', reason: `phewsh gate: ${toolName} targets a protected path (${target}). Credentials/keys/VCS internals are off-limits to automated edits.` };
      }
    }

    // 2. High-blast-radius shell → ask (require human confirmation).
    if (SHELL_TOOLS.has(toolName)) {
      const cmd = String(toolInput.command || toolInput.cmd || '');
      const hit = DESTRUCTIVE.find(d => d.re.test(cmd));
      if (hit) {
        return { decision: 'ask', reason: `phewsh gate: high-blast-radius command (${hit.label}) — confirm before it runs.` };
      }
    }

    // 3. Strict autonomy asks before any write. "delegated"/"guided" do not —
    //    that would turn every edit into ceremony.
    const autonomy = String(constraints.autonomy || '').toLowerCase();
    if ((autonomy === 'manual' || autonomy === 'review') && WRITE_TOOLS.has(toolName)) {
      return { decision: 'ask', reason: `phewsh gate: your autonomy is "${autonomy}" — confirm this ${toolName} before it runs.` };
    }

    return { decision: 'allow', reason: '' };
  } catch {
    return { decision: 'allow', reason: '' }; // fail OPEN: never trap the user
  }
}

// A redacted one-line audit record — decision + target shape only, never the
// tool payload (which may contain code or secrets).
function auditLine(envelope = {}, result = {}) {
  const target = WRITE_TOOLS.has(envelope.toolName)
    ? writeTarget(envelope.toolInput || {})
    : (SHELL_TOOLS.has(envelope.toolName) ? '<command>' : '');
  return `${result.decision || 'allow'} ${envelope.toolName || '?'}${target ? ' ' + target : ''}`;
}

module.exports = {
  evaluateAction, isProtected, auditLine, writeTarget,
  WRITE_TOOLS, SHELL_TOOLS, DEFAULT_PROTECTED, DESTRUCTIVE,
};
