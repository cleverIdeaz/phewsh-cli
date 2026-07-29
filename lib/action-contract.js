// The authority contract — what running this action actually grants.
//
// This used to be composed in the browser and copied onto the receipt verbatim.
// That inverted the owner-layer rule and, worse, made the receipt a place a
// caller could write its own claims: a direct call could state "Verification:
// fully verified" or "Cost: free" and the engine would file it as if the engine
// had said it. A receipt is evidence, so every sentence in it has to come from
// the side that actually knows.
//
// So the engine composes the contract, holds it, and hands back an id. Ion
// renders what it is given and dispatches by id. It cannot edit a word — the
// same shape that already fixed closure proposals.
//
// Owner layer: CLI.

/**
 * What running actually grants — stated once, rendered verbatim.
 *
 * This is the exact sentence an independent critic forced on 2026-07-29, moved
 * here unchanged when contract composition came into the engine. It used to
 * read "in this project only. No cloud, no other repository." That is false:
 * Phewsh sets the tool's working directory, which is not a sandbox. The tool
 * inherits your environment, your filesystem access, and the network, and most
 * AI tools send your prompt and file contents to their own provider.
 *
 * Promising containment Phewsh cannot enforce is worse than promising nothing,
 * because a person grants MORE on the strength of it. Do not soften it.
 */
const LOCAL_RUN_AUTHORITY =
  'Starts in this project, on this machine, with your permissions. Phewsh does not confine it: '
  + 'the tool can reach other files and the network, and most AI tools send your prompt and file '
  + 'contents to their provider.';

/**
 * Compose the contract for one proposed run.
 *
 * Every field is either something the engine observed (which project, which
 * runtime, which account authorizes it) or a constant the engine stands behind.
 * Nothing here is caller-supplied except the task text itself, which is quoted
 * back as the action rather than interpreted.
 */
function buildActionContract({ task, runtime, project }) {
  const action = String(task || '').trim();
  if (!action) {
    const error = new Error('A run needs a task to describe.');
    error.status = 400;
    throw error;
  }
  if (!runtime || runtime.connected !== true || runtime.headless !== true) {
    // Same rule the dispatcher enforces. Stated once, here, so a surface cannot
    // offer a route the engine would refuse.
    const error = new Error(
      `${(runtime && (runtime.label || runtime.id)) || 'That route'} cannot take a run on this machine.`,
    );
    error.status = 409;
    throw error;
  }

  const account = runtime.auth
    ? ` Billed to whatever ${runtime.auth} charges, if anything.`
    : '';

  return {
    action,
    actor: runtime.label || runtime.id,
    actorAccount: runtime.auth || null,
    where: `${project.name} — the copy on this device${project.remote ? ` (${project.remote})` : ''}`,
    reads: 'Files in this project, including its .intent/ — and whatever else it chooses to open.',
    writes: 'May create or change files here. Phewsh does not stop it writing elsewhere on this machine.',
    // The engine reports which account authorizes a tool. It does not know a
    // price and must never imply one.
    cost: `Unknown — the engine reports which account authorizes a tool, never a price.${account}`,
    authority: LOCAL_RUN_AUTHORITY,
    verificationCeiling:
      'Not verified. A receipt records what happened and points at evidence; it does not check the work.',
    undo: 'File changes are yours to revert with git. Nothing reaches Record or Next unless you accept it.',
    // Bound so a contract cannot be reviewed for one project and spent on
    // another, the same way a closure proposal is bound.
    boundProjectId: project.id,
    runtimeId: runtime.id,
  };
}

module.exports = { buildActionContract, LOCAL_RUN_AUTHORITY };
