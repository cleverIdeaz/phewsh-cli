// Emit a CLAUDE.md section from ranked, compressed chunks.
// This is the primary "continuity" output — what makes Claude Code
// instantly aware of everything across all sources.

const fs = require('fs');
const path = require('path');

const START_MARKER = '<!-- PHEWSH:START -->';
const END_MARKER = '<!-- PHEWSH:END -->';

const cleanBody = s => s.split('\n').map(l => l.replace(/^#{1,6} /, '')).join('\n');

// Embed a chunk body under a parent ## section: if the chunk's first line was
// a heading (which cleanBody just stripped), restore it as a ### subheading.
function embedChunk(chunk) {
  const cleaned = cleanBody(chunk.content);
  if (!cleaned) return cleaned;
  const firstOrig = chunk.content.split('\n')[0];
  if (/^#{1,6} /.test(firstOrig)) {
    return cleaned.replace(/^([^\n]*)/, '### $1');
  }
  return cleaned;
}

function emit(chunks, options = {}) {
  const projectName = options.projectName || path.basename(process.cwd());
  const sections = [];

  sections.push(`# PHEWSH Adaptive Context — ${projectName}`);
  sections.push(`> Auto-synced by \`phewsh seq\` | ${new Date().toISOString().split('T')[0]}`);
  sections.push(`> This section is regenerated from ${countSources(chunks)} sources. Do not edit manually.`);
  sections.push('');

  // Group chunks by kind for structured output
  const byKind = groupByKind(chunks);

  // 1. Identity — what this project is
  if (byKind.identity?.length > 0) {
    sections.push('## Project');
    for (const chunk of byKind.identity) {
      sections.push(embedChunk(chunk));
    }
    sections.push('');
  }

  // 2. Constraints — operational reality
  if (byKind.constraint?.length > 0) {
    sections.push('## Operational Reality');
    sections.push('These constraints MUST shape every suggestion and implementation decision:');
    sections.push('');
    for (const chunk of byKind.constraint) {
      // If this has structured constraint metadata, emit rich format
      if (chunk.metadata?.constraints) {
        sections.push(formatConstraints(chunk.metadata.constraints));
      } else {
        sections.push(embedChunk(chunk));
      }
    }
    sections.push('');
  }

  // 3. State — what's happening now. LEAN: the latest entry only, capped — the
  // full log lives in .intent/status.md. Architecture over prose: this block
  // points at the source of truth, it does not become the source of truth.
  if (byKind.state?.length > 0) {
    sections.push('## Current State');
    // Prefer the curated "## Now" section (North Star / Current Focus / Open
    // Decisions) over the changelog: emit up to the first horizontal rule that
    // separates it from the history, with a safety cap when there's no divider.
    const lines = embedChunk(byKind.state[0]).split('\n');
    let cut = lines.findIndex(l => /^---+\s*$/.test(l));
    if (cut < 0 || cut > 16) cut = 16;
    sections.push(lines.slice(0, cut).filter(l => l.trim()).join('\n'));
    sections.push('');
    sections.push('_Full state & history: `.intent/status.md` · run `phewsh status`._');
    sections.push('');
  }

  // 4. Feedback — learned behaviors
  if (byKind.feedback?.length > 0) {
    sections.push('## Behavioral Rules');
    sections.push('Learned from prior work:');
    sections.push('');
    for (const chunk of byKind.feedback) {
      // Memory files are already concise — include as-is
      const label = chunk.metadata?.name || chunk.source;
      sections.push(`**${label}**: ${chunk.content.split('\n')[0]}`);
      // If multi-line, include the rest indented
      const rest = chunk.content.split('\n').slice(1).filter(l => l.trim());
      if (rest.length > 0) {
        rest.forEach(l => sections.push(`  ${l}`));
      }
    }
    sections.push('');
  }

  // 5. Context — architecture, systems, plan
  if (byKind.context?.length > 0) {
    sections.push('## Context');
    for (const chunk of byKind.context) {
      // Skip generated PHEWSH sections (they're derivative)
      if (chunk.metadata?.generated) continue;
      sections.push(embedChunk(chunk));
    }
    sections.push('');
  }

  // 6. Actions — current tasks
  if (byKind.action?.length > 0) {
    sections.push('## Active Actions');
    for (const chunk of byKind.action) {
      sections.push(embedChunk(chunk));
    }
    sections.push('');
  }

  // 7. References — pointers to external systems
  if (byKind.reference?.length > 0) {
    sections.push('## References');
    for (const chunk of byKind.reference) {
      const label = chunk.metadata?.name || chunk.source;
      sections.push(`- **${label}**: ${chunk.content.split('\n')[0]}`);
    }
    sections.push('');
  }

  sections.push('---');
  sections.push('*Auto-synced from [PHEWSH](https://phewsh.com/intent)*');

  return sections.join('\n');
}

function formatConstraints(c) {
  const lines = [];

  if (c.budget > 0) {
    lines.push(`- Budget: $${c.budget}. ${
      c.budget < 100 ? 'Extremely tight — free/open-source only.'
      : c.budget < 500 ? 'Limited — justify any paid tool.'
      : c.budget < 2000 ? 'Moderate — strategic spending OK.'
      : 'Substantial — professional tools welcome.'
    }`);
  }
  if (c.timeHoursPerWeek > 0) {
    lines.push(`- Time: ${c.timeHoursPerWeek} hrs/week. ${
      c.timeHoursPerWeek <= 5 ? 'Micro-steps only.'
      : c.timeHoursPerWeek <= 15 ? 'Part-time. Clear stopping points.'
      : c.timeHoursPerWeek <= 30 ? 'Near full-time.'
      : 'Full-time+.'
    }`);
  }
  if (c.skillLevel) lines.push(`- Skill: ${c.skillLevel}`);
  if (c.urgency) lines.push(`- Urgency: ${c.urgency}`);
  if (c.autonomy) lines.push(`- Autonomy: ${c.autonomy}`);

  return lines.join('\n');
}

function groupByKind(chunks) {
  const groups = {};
  for (const chunk of chunks) {
    if (!groups[chunk.kind]) groups[chunk.kind] = [];
    groups[chunk.kind].push(chunk);
  }
  return groups;
}

function countSources(chunks) {
  return new Set(chunks.map(c => c.source.split(':')[0])).size;
}

// Write the emitted content into CLAUDE.md (between markers)
function writeToFile(content, cwd = process.cwd()) {
  const claudePath = path.join(cwd, 'CLAUDE.md');
  const wrapped = `${START_MARKER}\n${content}\n${END_MARKER}`;

  if (fs.existsSync(claudePath)) {
    let existing = fs.readFileSync(claudePath, 'utf-8');
    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);

    if (startIdx !== -1 && endIdx !== -1) {
      existing = existing.slice(0, startIdx) + wrapped + existing.slice(endIdx + END_MARKER.length);
    } else {
      existing = existing.trimEnd() + '\n\n' + wrapped + '\n';
    }
    fs.writeFileSync(claudePath, existing);
    return 'updated';
  } else {
    fs.writeFileSync(claudePath, wrapped + '\n');
    return 'created';
  }
}

module.exports = { emit, writeToFile };
