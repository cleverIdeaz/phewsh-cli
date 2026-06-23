// Sequencer — Universal Memory Transform Layer
//
// The core pipeline: discover → parse → rank → compress → emit
// One function. N inputs. 1 optimal output per target format.

const { discover, resolveProjectRoot } = require('./discover');
const { rank } = require('./ranker');
const { compress } = require('./compressor');

// Parsers by source type
const parsers = {
  intent: require('./parsers/intent'),
  'claude-md': require('./parsers/claude-md'),
  'claude-memory': require('./parsers/claude-memory'),
  'claude-memory-file': require('./parsers/claude-memory'),
  cursor: require('./parsers/generic'),
  agent: require('./parsers/generic'),
  soul: require('./parsers/generic'),
  copilot: require('./parsers/generic'),
  readme: require('./parsers/generic'),
};

// Emitters by target format
const emitters = {
  'claude-md': require('./emitters/claude-md'),
  stdout: require('./emitters/stdout'),
};

/**
 * Run the full sequencing pipeline.
 *
 * @param {object} options
 * @param {string} options.target - Output format: 'claude-md' | 'stdout' | 'json'
 * @param {string} options.budget - Token budget: 'minimal' | 'standard' | 'full' | 'unlimited'
 * @param {string[]} options.sources - Limit to specific source types (null = all)
 * @param {string[]} options.sourceNames - Limit to specific discovered filenames (null = all)
 * @param {string[]} options.excludeChunkSources - Omit exact parsed chunk sources
 * @param {boolean} options.explain - Show full ranking breakdown
 * @param {boolean} options.write - Write to file (for claude-md target)
 * @param {string} options.cwd - Working directory
 * @returns {{ chunks: object[], output: string, sources: object[] }}
 */
function sequence(options = {}) {
  const {
    target = 'claude-md',
    budget = 'standard',
    sources: sourceFilter = null,
    sourceNames = null,
    excludeChunkSources = null,
    explain = false,
    write = false,
    includeGlobal = false,
    cwd = process.cwd(),
  } = options;

  // Resolve to the canonical project root once, so discovery, naming, and any
  // file write all agree on the same project (a nested dir never self-resolves).
  const root = resolveProjectRoot(cwd);

  // 1. Discover all source files (project + global)
  let sources = discover(root);

  // Privacy guard: global per-user memory enriches the summary (stdout), but
  // never bleeds into a project-file target (CLAUDE.md) unless asked for —
  // so personal global notes don't land in a committed project file.
  if (target !== 'stdout' && !includeGlobal) {
    sources = sources.filter(s => s.scope !== 'global');
  }

  // A file's generated block must not restate the file's own manual content —
  // that's circular (parallel truth). When emitting the claude-md block, drop
  // the project CLAUDE.md source itself. The block carries .intent/-derived
  // state and points at the source of truth; it does not echo the host file.
  if (target === 'claude-md') {
    sources = sources.filter(s => s.type !== 'claude-md');
  }

  // Filter sources if requested
  if (sourceFilter && sourceFilter.length > 0) {
    sources = sources.filter(s =>
      sourceFilter.some(f => s.type === f || s.type.startsWith(f))
    );
  }
  if (sourceNames && sourceNames.length > 0) {
    sources = sources.filter(source => sourceNames.includes(source.name));
  }

  // 2. Parse all sources into chunks
  let chunks = [];
  for (const source of sources) {
    const parser = parsers[source.type];
    if (!parser) continue;

    const parsed = parser.parse(source);
    chunks.push(...parsed);
  }
  if (excludeChunkSources && excludeChunkSources.length > 0) {
    chunks = chunks.filter(chunk => !excludeChunkSources.includes(chunk.source));
  }

  // 3. Rank all chunks
  chunks = rank(chunks);

  // 4. Compress to budget
  chunks = compress(chunks, budget);

  // 5. Emit
  const emitter = emitters[target];
  if (!emitter) {
    throw new Error(`Unknown target format: ${target}. Available: ${Object.keys(emitters).join(', ')}`);
  }

  if (target === 'stdout') {
    emitter.emit(chunks, { explain, sources });
    return { chunks, output: null, sources };
  }

  const output = emitter.emit(chunks, {
    projectName: getProjectName(chunks, root),
  });

  // Write to file if requested
  if (write && emitter.writeToFile) {
    const result = emitter.writeToFile(output, root);
    return { chunks, output, sources, writeResult: result };
  }

  return { chunks, output, sources };
}

/**
 * Get project name from chunks or fall back to directory name.
 */
function getProjectName(chunks, cwd) {
  // Check identity chunks from intent source for a project name
  for (const chunk of chunks) {
    if (chunk.sourceType === 'intent' && chunk.kind === 'identity') {
      const nameMatch = chunk.content.match(/\*\*Name\*\*:\s*(.+)/);
      if (nameMatch) return nameMatch[1].trim();
    }
  }
  const path = require('path');
  return path.basename(cwd);
}

module.exports = { sequence };
