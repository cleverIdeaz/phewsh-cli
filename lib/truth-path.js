// Containment for project truth.
//
// A grant names a REGISTERED REPOSITORY. Everything it authorizes has to resolve
// inside that repository, or the grant is wider than what the person approving it
// was shown.
//
// Nothing resolved symlinks, so `.intent` — or any file under it — could point
// anywhere on the machine. A `truth:read` grant for one project became a reader
// for whatever the link pointed at, and a closure write became a writer outside
// the repo entirely. Creating that symlink needs no privilege: every harness the
// engine runs inside a registered repo can do it.
//
// The property is CONTAINMENT, not "no symlinks". A repo that links its own files
// around is still only exposing itself, and refusing that would break ordinary
// working trees for no security gain.
//
// Owner layer: CLI. This is the engine's rule about its own filesystem, and no
// surface may relax it.

const fs = require('fs');
const path = require('path');

class ContainmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContainmentError';
    // A refusal, not a missing file: 403 rather than 404, so a caller cannot map
    // the filesystem by comparing the two.
    this.status = 403;
  }
}

/** Is `target` the root itself, or genuinely beneath it? */
function isInside(root, target) {
  if (target === root) return true;
  // path.relative rather than startsWith: `/tmp/repo-evil` starts with
  // `/tmp/repo` but is a different directory.
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve `segments` under `root` and return the real path, or throw.
 *
 * The target may not exist yet — truth has to be creatable — so resolution walks
 * up to the nearest existing ancestor, resolves THAT through symlinks, and
 * re-appends the remainder. Both the resolved ancestor and the final path must be
 * inside the root, so a link part-way down a path cannot escape either.
 */
function containedPath(root, ...segments) {
  const given = String(root || '').trim();
  if (!given) throw new ContainmentError('No project root to contain this path within.');

  let realRoot;
  try {
    realRoot = fs.realpathSync(given);
  } catch {
    throw new ContainmentError('The registered project root is not readable on this machine.');
  }

  // An absolute segment would otherwise discard the root entirely.
  for (const segment of segments) {
    if (path.isAbsolute(String(segment || ''))) {
      throw new ContainmentError('A truth path must be relative to its project.');
    }
  }

  const target = path.resolve(realRoot, ...segments.map((s) => String(s || '')));

  // Walk up to the nearest ancestor that exists, so a not-yet-created file is
  // still checked against real, symlink-resolved parents.
  let existing = target;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    missing.unshift(path.basename(existing));
    existing = parent;
  }

  let realExisting;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    throw new ContainmentError('That truth path cannot be resolved inside this project.');
  }
  if (!isInside(realRoot, realExisting)) {
    throw new ContainmentError('That truth path resolves outside the registered project.');
  }

  const resolved = missing.length ? path.join(realExisting, ...missing) : realExisting;
  if (!isInside(realRoot, resolved)) {
    throw new ContainmentError('That truth path resolves outside the registered project.');
  }
  return resolved;
}

module.exports = { containedPath, ContainmentError };
