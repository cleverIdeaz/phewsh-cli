// phewsh slash commands — teach ONE verb, not a tool.
//
// CG's insight: the first thing a user should learn isn't `phewsh`, it's
// `/intent`. If every AI tool has `/intent`, the user learns the BEHAVIOR they
// want (see this project's truth) without learning the implementation. So
// phewsh installs `/intent` into each harness's NATIVE custom-command slot —
// a structured, user-invoked channel (not injected prose). It only does
// something when the user types it, so there's nothing for a model to flag.
//
// Each harness has its own format/dir; we only install for tools present, and
// never clobber a command the user wrote (we mark ours + check the marker).

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = 'phewsh-managed';

// The portable prompt `/intent` runs. It's a user-invoked request to surface
// the project's own .intent/ docs — trusted because the user asked for it.
const INTENT_PROMPT = `Show me this project's current intent, read from its \`.intent/\` directory. Be concise:
- **Vision** — what we're building and why
- **Current objective / next** — what's in flight
- **Constraints** — budget, time, scope, non-negotiables
- **Recent decisions** — and any that are still open

If there is no \`.intent/\` directory here, say so and tell me I can create one with \`phewsh intent --init\` so every AI tool I use shares the same project truth.`;

// Tools that support file-based custom slash commands, and how each wants them.
// parentDir must already exist (the tool is installed) before we write.
//
// Claude Code is deliberately EXCLUDED: it already ships a phewsh `/intent`
// SKILL (the artifact generator) and gets the SessionStart hook brief, so a
// global `/intent` command here just collides with the canonical one (two
// `/intent` entries). We add `/intent` only where it's genuinely absent.
const SLASH_TARGETS = [
  { id: 'codex',  parent: '.codex',  sub: 'prompts',  file: 'intent.md', fmt: 'codex' },
  { id: 'gemini', parent: '.gemini', sub: 'commands', file: 'intent.toml', fmt: 'gemini' },
];

function bodyFor(fmt) {
  if (fmt === 'claude') {
    return `---\ndescription: Show this project's intent — vision, objective, constraints, decisions (phewsh)\n---\n<!-- ${MARKER} · remove with: phewsh ambient off -->\n\n${INTENT_PROMPT}\n`;
  }
  if (fmt === 'codex') {
    return `<!-- ${MARKER} · remove with: phewsh ambient off -->\n${INTENT_PROMPT}\n`;
  }
  if (fmt === 'gemini') {
    const esc = INTENT_PROMPT.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
    return `# ${MARKER} · remove with: phewsh ambient off\ndescription = "Show this project's intent via phewsh"\nprompt = """\n${esc}\n"""\n`;
  }
  return INTENT_PROMPT;
}

function targetPath(t) {
  return path.join(os.homedir(), t.parent, t.sub, t.file);
}

// Install /intent for every present tool. Won't overwrite a user's own command
// (only a file we previously marked, or a fresh write). Returns written ids.
function installSlashCommands() {
  const written = [];
  for (const t of SLASH_TARGETS) {
    try {
      if (!fs.existsSync(path.join(os.homedir(), t.parent))) continue; // tool not installed
      const fp = targetPath(t);
      if (fs.existsSync(fp)) {
        const cur = fs.readFileSync(fp, 'utf-8');
        if (!cur.includes(MARKER)) continue; // user's own /intent — leave it
        if (cur === bodyFor(t.fmt)) continue; // already current
      }
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, bodyFor(t.fmt));
      written.push(t.id);
    } catch { /* best-effort per tool */ }
  }
  return { written };
}

function removeSlashCommands() {
  const removed = [];
  for (const t of SLASH_TARGETS) {
    try {
      const fp = targetPath(t);
      if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf-8').includes(MARKER)) {
        fs.unlinkSync(fp);
        removed.push(t.id);
      }
    } catch { /* best-effort */ }
  }
  return { removed };
}

function detectSlashTargets() {
  return SLASH_TARGETS.filter(t => fs.existsSync(path.join(os.homedir(), t.parent)));
}

module.exports = { installSlashCommands, removeSlashCommands, detectSlashTargets, INTENT_PROMPT };
