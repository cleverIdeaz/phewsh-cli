// Fallback slash command for harnesses that do not yet consume Phewsh's open
// Agent Skill. Codex and Claude use cli/skills/intent/SKILL.md through their
// native user-level skill directories; only Gemini remains on this adapter.
//
// Every tool should expose the same intent behavior without making the user
// learn a second project model. Gemini still needs a native custom-command
// adapter; migrate it to the open skill when its client support is verified.
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

If there is no \`.intent/\` directory here, say so and tell me I can create one with \`phewsh init\` so compatible AI tools can read the same project truth.`;

// parentDir must already exist (the tool is installed) before we write.
const SLASH_TARGETS = [
  { id: 'gemini', parent: '.gemini', sub: 'commands', file: 'intent.toml', fmt: 'gemini' },
];

function bodyFor() {
  const esc = INTENT_PROMPT.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return `# ${MARKER} · remove with: phewsh ambient off\ndescription = "Show this project's intent via phewsh"\nprompt = """\n${esc}\n"""\n`;
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
        if (cur === bodyFor()) continue; // already current
      }
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, bodyFor());
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
  return SLASH_TARGETS
    .filter(t => fs.existsSync(path.join(os.homedir(), t.parent)))
    .map(t => ({ ...t, path: targetPath(t) }));
}

module.exports = { installSlashCommands, removeSlashCommands, detectSlashTargets, INTENT_PROMPT };
