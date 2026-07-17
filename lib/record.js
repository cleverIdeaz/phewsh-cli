// "Record" — the human-authored side of one of the four words
// (Project · Next · Work · Record). `phewsh remember "<x>"` appends a dated
// line to `.intent/decisions.md` so a decision or lesson sticks and travels
// with the repo — compatible AI tools can read it as project truth. Zero-AI: a person
// alone can jot WHY they did something, and the next session (human or model)
// inherits it. The auto-captured ledger (~/.phewsh/outcomes) is separate: that
// is routed actions labeled kept/reverted; this is what you chose to remember.

const fs = require('fs');
const path = require('path');

const LINE_RE = /^- \d{4}-\d{2}-\d{2} — /;

function recordFile(cwd = process.cwd()) {
  return path.join(cwd, '.intent', 'decisions.md');
}

function remember(text, cwd = process.cwd()) {
  const t = (text || '').trim();
  if (!t) return null;
  const fp = recordFile(cwd);
  const date = new Date().toISOString().slice(0, 10);
  const line = `- ${date} — ${t.replace(/\s+/g, ' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, '# Decisions\n\n> What we decided and why — append-only. Captured with `phewsh remember "…"`.\n\n' + line);
    } else {
      const existing = fs.readFileSync(fp, 'utf-8');
      fs.writeFileSync(fp, existing.replace(/\n*$/, '\n') + line);
    }
    return { date, text: t };
  } catch {
    return null;
  }
}

/** The remembered lines, oldest first. */
function notes(cwd = process.cwd()) {
  try {
    return fs.readFileSync(recordFile(cwd), 'utf-8').split('\n').filter(l => LINE_RE.test(l));
  } catch {
    return [];
  }
}

module.exports = { remember, notes, recordFile };
