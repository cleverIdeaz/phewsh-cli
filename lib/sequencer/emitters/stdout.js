// Human-readable terminal output of the sequencing result.
// Shows what was found, how it was ranked, and the final output.

const ui = require('../../ui');

function emit(chunks, options = {}) {
  const { explain = false, sources = [] } = options;
  const { b, w, g, sage, slate, teal, cream, green, yellow, ember, peach } = ui;

  console.log('');

  if (explain) {
    return emitExplain(chunks, sources, ui);
  }

  // Compact summary
  const sourceCount = new Set(chunks.map(c => c.source.split(':')[0])).size;
  const kindCounts = {};
  for (const chunk of chunks) {
    kindCounts[chunk.kind] = (kindCounts[chunk.kind] || 0) + 1;
  }

  console.log(`  ${b(cream('Sequenced'))} ${teal(String(chunks.length))} ${sage('chunks from')} ${teal(String(sourceCount))} ${sage('sources')}`);
  ui.divider('line');

  // Show kind breakdown
  const kindOrder = ['constraint', 'identity', 'feedback', 'state', 'action', 'context', 'reference'];
  for (const kind of kindOrder) {
    if (!kindCounts[kind]) continue;
    const icon = KIND_ICONS[kind] || '?';
    console.log(`    ${icon} ${cream(kind.padEnd(12))} ${slate(String(kindCounts[kind]))}`);
  }

  ui.divider('line');

  // Show top 5 chunks by weight
  console.log(`  ${sage('top signal:')}`);
  const top = chunks.slice(0, 5);
  for (const chunk of top) {
    const weight = chunk.weight.toFixed(2);
    const preview = chunk.content.split('\n')[0].slice(0, 60);
    console.log(`    ${slate(weight)} ${teal(chunk.kind.padEnd(10))} ${sage(preview)}`);
  }

  // Token estimate
  const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
  const estTokens = Math.ceil(totalChars / 4);
  console.log('');
  console.log(`  ${slate(`~${estTokens} tokens`)}`);
  console.log('');
}

function emitExplain(chunks, sources, { b, w, g, sage, slate, teal, cream, green, yellow, ember }) {
  // Full ranking breakdown
  console.log(`  ${b(cream('Sequencer Explain'))}`);
  console.log('');

  // Sources discovered
  console.log(`  ${b(cream('Sources'))}`);
  for (const source of sources) {
    const tag = source.scope === 'global' ? slate('global ') : sage('project');
    console.log(`    ${tag} ${teal(source.type.padEnd(14))} ${sage(source.name)}`);
  }
  console.log('');

  // All chunks with full weight breakdown
  console.log(`  ${b(cream('Chunks'))} ${slate(`(${chunks.length} total, ranked by weight)`)}`);
  console.log('');

  for (const chunk of chunks) {
    const weight = chunk.weight.toFixed(3);
    const preview = chunk.content.split('\n')[0].slice(0, 50);
    const truncated = chunk._truncated ? ` ${ember('[truncated]')}` : '';
    console.log(`  ${cream(weight)} ${teal(chunk.kind.padEnd(12))} ${sage(chunk.source)}`);
    console.log(`         ${slate(preview)}${truncated}`);
  }
  console.log('');
}

const KIND_ICONS = {
  constraint: '\u2588',  // solid block — constraints are load-bearing
  identity: '\u25C6',    // diamond — core
  feedback: '\u25B6',    // triangle — directional
  state: '\u25CF',       // circle — current
  action: '\u25A0',      // square — tasks
  context: '\u25CB',     // open circle — background
  reference: '\u25B7',   // open triangle — pointer
};

module.exports = { emit };
