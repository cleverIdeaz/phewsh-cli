// Which cloud project does this repository sync with?
//
// Pure decision, no I/O — the caller runs the queries and acts on the verdict.
//
// Precedence is the entire point:
//   1. an id the human passed on the command line
//   2. the id `phewsh link` (or a previous push) wrote into .intent/pps.json
//   3. a cloud project carrying the same display name
//
// An explicit link is a human statement of identity. A matching name is a
// guess. Letting the guess win means a second cloud project that happens to
// share a display name can capture the repo: `pull` would overwrite .intent/
// with another project's content and rewrite the link to match, and `push`
// would send this project's truth into that one. So the guess is consulted
// only when there is no link, and trusted only when it is unambiguous.

/**
 * @param {object} input
 * @param {string|null} [input.requestedId] id given on the command line
 * @param {string|null} [input.linkedId]    adapters.phewsh.cloud_id
 * @param {object|null} [input.byId]        the project that id resolved to
 * @param {object[]}    [input.byName]      projects matching the display name
 * @returns {{action:'use',project:object,source:'requested'|'linked'|'name'}
 *          |{action:'absent',id:string,source:'requested'|'linked'}
 *          |{action:'ambiguous',matches:object[]}
 *          |{action:'none'}}
 *
 * `absent` means "we know exactly which project was meant and it is not there".
 * Callers differ on what to do — push recreates it at the same id so the link
 * survives, pull has nothing to read and says so — but neither may guess.
 */
function resolveProjectBinding({ requestedId, linkedId, byId, byName } = {}) {
  const wanted = requestedId || linkedId || null;
  if (wanted) {
    const source = requestedId ? 'requested' : 'linked';
    return byId
      ? { action: 'use', project: byId, source }
      : { action: 'absent', id: wanted, source };
  }

  const matches = byName || [];
  if (matches.length === 1) return { action: 'use', project: matches[0], source: 'name' };
  if (matches.length > 1) return { action: 'ambiguous', matches };
  return { action: 'none' };
}

module.exports = { resolveProjectBinding };
