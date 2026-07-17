// phewsh remember — Record's zero-AI verb (Project · Next · Work · Record).
// Jot a decision or lesson so it sticks and compatible tool adapters can read it.
//
//   phewsh remember "we're deferring the MCP connector to phase 3"
//   phewsh remember            show what you've remembered

const record = require('../lib/record');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const teal = (s) => `\x1b[38;5;79m${s}\x1b[0m`;
const sage = (s) => `\x1b[38;5;151m${s}\x1b[0m`;
const slate = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const cream = (s) => `\x1b[38;5;230m${s}\x1b[0m`;

function main() {
  const text = process.argv.slice(3).join(' ').replace(/^["']|["']$/g, '');

  if (!text) {
    const ns = record.notes();
    console.log('');
    if (ns.length === 0) {
      console.log(`  ${slate('Nothing remembered yet.')}`);
      console.log(`  ${slate('Jot a project decision to .intent/decisions.md:')}`);
      console.log(`  ${cream('phewsh remember "we decided to keep packs opt-in"')}`);
    } else {
      console.log(`  ${b(cream('RECORD'))} ${slate('— what you decided · .intent/decisions.md')}`);
      console.log('');
      ns.slice(-12).forEach(l => console.log(`  ${slate(l)}`));
    }
    console.log('');
    return;
  }

  const r = record.remember(text);
  console.log('');
  if (r) {
    console.log(`  ${teal('✓')} ${sage('Remembered.')} ${slate('Supported adapters can read it from .intent/.')}`);
    console.log(`  ${slate('.intent/decisions.md · ' + r.date)}`);
  } else {
    console.log(`  ${slate('Could not write .intent/decisions.md here.')}`);
  }
  console.log('');
}

module.exports = main;
