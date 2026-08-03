// Exact identity, or explicit failure. There is no default project.
//
// The MCP surface used to resolve a project like this:
//
//   const project = projects.find(p => p.id === args.project_id)
//     || projects.find(p => p.id === "local");
//
// `"local"` is not a placeholder. `loadProjects()` mints it from
// `join(cwd, ".intent")` — it is whatever repository the MCP server happened to
// be started in. So an unknown, stale, or merely mistyped `project_id` did not
// fail: it silently evaluated against the server's own working directory and
// then recorded the result under the id the caller ASKED for.
//
// That is worse than having no gate. `phewsh_evaluate_action` is the pre-action
// enforcement gate — an agent asks "may I do X in project B?" and received
// project A's verdict filed under B. Everything downstream trusts that answer.
//
// This mirrors `lib/local-claim.js:resolveRunTarget`, deliberately. Two
// different versions of "which project is this?" is how one of them ends up
// more permissive; the serve path already fails closed on unknown and on
// ambiguity, and this is the same rule on the MCP side.
//
// A caller that genuinely means the local project still passes `"local"`
// explicitly and still gets it. Exact matching is unchanged — only the
// substitution is gone.

// cli/lib/ is CommonJS and cli/mcp/ is ESM, so this is a default import — the
// same shape http-server.js already uses for ../lib/cors.js. The module split
// is real; the identity rule must survive it rather than be written twice.
import projectIdentity from "../../lib/project-identity.js";

const { matchProjectId } = projectIdentity;

/**
 * `status` exists so an HTTP surface can answer honestly without re-deriving
 * WHY the identity failed from the message text. Missing is a bad request,
 * unknown is not found, ambiguous is a conflict a human must resolve. The stdio
 * surface ignores it.
 */
export class McpProjectError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve a project by exact id, or throw.
 *
 * Ambiguity is representable: `loadProjects()` pushes the cwd-derived project
 * and then spreads the registry file, so two entries can carry one id. Picking
 * either would be a guess, so both are refused.
 *
 * @param {object[]} projects
 * @param {string}   requestedId
 * @returns {object}
 */
export function resolveExactProject(projects, requestedId) {
  // Shared decision, local wording. `matchProjectId` is the same function the
  // serve path resolves through, so neither surface can be the more permissive
  // one; the messages below are this surface's own, because an MCP caller and a
  // loopback HTTP caller need different things said to them.
  const verdict = matchProjectId(projects, requestedId);

  if (verdict.outcome === "missing") {
    throw new McpProjectError("A project_id is required. There is no default project.");
  }
  if (verdict.outcome === "unknown") {
    const known = verdict.known.join(", ");
    throw new McpProjectError(
      `No project with id "${verdict.wanted}".${known ? ` Known ids: ${known}.` : ""} `
      + "Nothing was evaluated — name the project explicitly.",
      404,
    );
  }
  if (verdict.outcome === "ambiguous") {
    throw new McpProjectError(
      `More than one project claims the id "${verdict.wanted}". `
      + "Remove the duplicate registry entry before continuing.",
      409,
    );
  }
  return verdict.match;
}

/**
 * The id a session should start against when the caller did not name one.
 *
 * Exactly one registered project is not a guess, so it is still selected. Two
 * or more is ambiguous and the human is asked — where this previously reached
 * for whichever project had the id `"local"`, which meant "wherever this server
 * was launched" and was never something the caller stated.
 *
 * @returns {string|null} the id to use, or null when the caller must choose
 */
export function defaultStartProjectId(projects) {
  const list = Array.isArray(projects) ? projects : [];
  return list.length === 1 ? (list[0]?.id ?? null) : null;
}
