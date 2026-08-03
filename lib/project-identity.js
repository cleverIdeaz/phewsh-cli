// Which project is this? Asked once, answered once.
//
// Pure decision, no I/O and no throwing — the caller runs the queries and picks
// the wording, the status code, and any further gates. Same shape as
// `project-binding.js:resolveProjectBinding`, for the same reason: a decision
// that cannot touch the filesystem cannot be more permissive on one surface
// than another because of what it happened to find there.
//
// WHY THIS EXISTS
//
// The rule below was written twice — `local-claim.js:resolveRunTarget` for the
// serve path and `mcp/lib/resolve-project.js:resolveExactProject` for the MCP
// surface — and both were correct. That is not the point. Two implementations
// of one boundary drift, and when they drift it is the PERMISSIVE one that gets
// used, because the permissive one is the one that answers.
//
// So the callers keep their own vocabulary and their own extra gates (serve
// re-verifies live origin through assertLiveIdentity; the MCP surface has no
// path to do that) and delegate the identity question itself to here.
//
// Owner layer: CLI.

/**
 * @param {object[]} projects  registry entries, each carrying a stable `id`
 * @param {*}        requestedId  what the caller claims to want
 * @returns {{outcome:'missing'}
 *          |{outcome:'unknown', wanted:string, known:string[]}
 *          |{outcome:'ambiguous', wanted:string, count:number}
 *          |{outcome:'exact', wanted:string, match:object}}
 *
 * `missing` means nothing was named — which is a refusal, never a default.
 * `ambiguous` deliberately carries no `match`: a duplicated id is a registry
 * problem a human must resolve, and `.find()` would quietly resolve it wrong.
 */
function matchProjectId(projects, requestedId) {
  const wanted = typeof requestedId === 'string' ? requestedId.trim() : '';
  if (!wanted) return { outcome: 'missing' };

  const list = Array.isArray(projects) ? projects : [];
  const matches = list.filter((project) => project?.id === wanted);

  if (!matches.length) {
    return { outcome: 'unknown', wanted, known: list.map((p) => p?.id).filter(Boolean) };
  }
  if (matches.length > 1) {
    return { outcome: 'ambiguous', wanted, count: matches.length };
  }
  return { outcome: 'exact', wanted, match: matches[0] };
}

module.exports = { matchProjectId };
