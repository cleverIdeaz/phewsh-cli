// Capability grants — the engine's own answer to "who is allowed to do what".
//
// WHY THIS EXISTS
//
// The previous repair had `/local-session` issue a project-bound token and
// required it on the acting endpoints. That only looked like authorization.
// The token was handed out for free: any allowed origin could read a project
// id from `/health`, POST a nonce, and get one. The nonce proves the node is
// live. It proves no human gesture, no identity, no authority. Requiring that
// token everywhere would have relocated the bypass, not closed it.
//
// So there are two grants, and neither can be taken — only granted.
//
//   HOST GRANT     Exists only after a human approved a pairing at this node,
//                  by reading a code off their own terminal. Bound to the node
//                  instance, the requesting principal, and an expiry. Lets a
//                  caller discover which projects are registered and, with the
//                  diagnostics scope, look at the device. Never reads project
//                  truth, never runs anything, never writes the Record.
//
//   PROJECT GRANT  Derived from an approved host grant after a human-visible
//                  project selection. Bound to stable project identity, the
//                  live root/remote revalidated at issue time, the node
//                  instance, the principal, an expiry, and explicit scopes.
//
// Both live in this process only. A node restart invalidates everything, which
// is the honest outcome: the proof was about a live node, and that node is
// gone. Nothing is written to disk, so there is no token file to steal and
// nothing for a browser to persist in a URL, cookie, or storage.
//
// Owner layer: CLI. Ion renders what the engine decides; it never decides.

const crypto = require('crypto');

// Scopes a project grant may carry. Anything outside this set is refused at
// issue time rather than silently ignored — a caller asking for authority that
// does not exist is a bug worth surfacing, not rounding down.
const PROJECT_SCOPES = Object.freeze(['truth:read', 'work:run', 'work:control', 'record:write']);

// Host scopes. `host:discover` is what an ordinary paired client gets.
// `host:diagnostics` and `host:admin` are deliberately separate: reading the
// device view or every project's receipts is not implied by having paired.
const HOST_SCOPES = Object.freeze(['host:discover', 'host:diagnostics', 'host:admin']);

// Exactly what a completed pairing is worth. Fixed, not caller-chosen: the
// human approving a code can only meaningfully consent to a constant.
const PAIRING_SCOPES = Object.freeze(['host:discover', 'host:diagnostics']);

/**
 * Scopes that DO something, as opposed to reading the project's own files.
 *
 * An independent critic found the escalation these close: pairing asked the
 * human to approve "a local app wants to pair", and Ion's own copy beside the
 * button promised only that it could READ a registered project's `.intent/`.
 * One call later the page requested work:run and record:write for any project
 * on the machine, and got them — no second gesture anywhere. The consent the
 * person actually gave did not cover running an AI harness in their repository
 * or appending to their Record.
 *
 * So these require their own approval, naming the project and the scopes, at
 * the node. `truth:read` does not: it is precisely what the person was shown.
 */
const ELEVATED_SCOPES = Object.freeze(['work:run', 'work:control', 'record:write']);

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 2 * 60 * 1000;

class GrantError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'GrantError';
    this.status = status;
  }
}

/**
 * One node instance's authority. Constructed once per `phewsh serve`; every
 * grant it issues carries its id, so a grant cannot outlive the node that
 * vouched for it even if the next node reuses the port.
 */
function createGrantStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const nodeInstanceId = crypto.randomBytes(16).toString('hex');
  const pendingPairings = new Map(); // pairingId → { code, principal, createdAt }
  // A critic drove 61 approval prompts onto the operator's terminal in 0.59s.
  // Brute force was never the risk — burying the legitimate prompt is.
  const MAX_PENDING_PAIRINGS = 3;
  // Same reasoning for elevated approvals, which are the prompts that actually
  // grant work:run and record:write. A duplicate request coalesces onto the
  // approval already waiting, so these ceilings only ever count prompts a human
  // would have to tell apart — and an abandoned one frees its slot on expiry.
  const MAX_PENDING_APPROVALS_PER_PRINCIPAL = 3;
  const MAX_PENDING_APPROVALS_TOTAL = 6;
  const pendingScopeApprovals = new Map(); // approvalId → { code, principal, target, scopes, createdAt }
  const hostGrants = new Map();      // token → { principal, scopes, expiresAt }
  const projectGrants = new Map();   // token → { projectId, principal, scopes, root, remote, expiresAt, hostToken }

  const token = () => crypto.randomBytes(32).toString('hex');

  /**
   * The principal is who is asking, and it is the ORIGIN alone.
   *
   * A client name (`x-phewsh-client`, or `client` in the body) is self-asserted
   * — any caller can claim to be Ion — so it carries no security weight and is
   * deliberately NOT part of identity. It is recorded and shown to the human
   * during pairing as a label, nothing more. Folding it into the principal
   * would only make grants break when a client forgot to repeat it, while
   * adding no protection against a caller that simply lies.
   *
   * A request with no Origin gets the `no-origin` principal, which no grant is
   * ever issued to over HTTP.
   */
  function principalOf(origin) {
    return origin || 'no-origin';
  }

  function sweep() {
    const t = now();
    for (const [id, p] of pendingPairings) if (t - p.createdAt > PAIRING_TTL_MS) pendingPairings.delete(id);
    for (const [id, p] of pendingScopeApprovals) if (t - p.createdAt > PAIRING_TTL_MS) pendingScopeApprovals.delete(id);
    for (const [k, g] of hostGrants) if (t > g.expiresAt) hostGrants.delete(k);
    for (const [k, g] of projectGrants) if (t > g.expiresAt) projectGrants.delete(k);
  }

  /**
   * Step one of pairing. Returns the id plus the code the NODE must display to
   * the human. The code is never returned over HTTP — the caller has to get it
   * from the person sitting at the terminal, which is the entire point.
   */
  function beginPairing({ origin, client }) {
    sweep();
    // The comments used to promise this and nothing implemented it: a caller
    // with no Origin at all could pair. `no-origin` is also a SHARED principal,
    // so a grant bound to it is bound to nothing.
    if (!origin) {
      throw new GrantError('A caller with no origin cannot be granted authority over this machine.', 403);
    }
    if (pendingPairings.size >= MAX_PENDING_PAIRINGS) {
      throw new GrantError(
        'Too many pairing requests are already waiting. Approve or ignore one, or wait two minutes.', 429,
      );
    }
    const pairingId = crypto.randomBytes(8).toString('hex');
    // Unambiguous alphabet: no O/0, no I/1. A human is going to read this out.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (const byte of crypto.randomBytes(6)) code += alphabet[byte % alphabet.length];
    pendingPairings.set(pairingId, { code, principal: principalOf(origin), createdAt: now() });
    return { pairingId, code, expiresAt: now() + PAIRING_TTL_MS };
  }

  /**
   * Step two. The human's code, presented by the same principal that asked.
   * A wrong code burns the pairing rather than allowing another guess: six
   * characters is plenty against one attempt and useless against thousands.
   */
  function completePairing({ pairingId, code, origin }) {
    sweep();
    const pending = pendingPairings.get(String(pairingId || ''));
    if (!pending) throw new GrantError('No pairing is waiting for approval. Start one and read the code on the node.', 403);

    // Validate the caller BEFORE burning it. Deleting first let anyone holding
    // the pairingId destroy the legitimate pairing.
    if (pending.principal !== principalOf(origin)) {
      throw new GrantError('This approval came from a different caller than the one that asked.', 403);
    }
    // Already used or already guessed wrong. It stays in the map, occupying its
    // slot, so a wrong guess cannot buy another prompt.
    if (pending.spent) {
      throw new GrantError('That pairing is no longer open. Start a new one.', 403);
    }
    const given = String(code || '').trim().toUpperCase();
    // Constant-time compare so a wrong code leaks nothing about how wrong.
    const a = Buffer.from(given.padEnd(32, '\0'));
    const bb = Buffer.from(pending.code.padEnd(32, '\0'));
    if (given.length !== pending.code.length || !crypto.timingSafeEqual(a, bb)) {
      // SPEND it, do not delete it. Burning a wrong guess is right — six
      // characters is useless against thousands of attempts — but deleting also
      // handed the ceiling's slot back, so `request → wrong code → request` looped
      // without limit and buried the operator's real prompt. A critic drove 745
      // prompts in three seconds through exactly this.
      pending.spent = true;
      pending.code = '';
      throw new GrantError('That approval code does not match.', 403);
    }
    // A genuine human approval frees the slot immediately; only failure holds it.
    pendingPairings.delete(String(pairingId));

    // The caller does NOT choose its own scopes.
    //
    // An earlier version of this took `scopes` from the request body and issued
    // whatever was asked for, validating only that the names were known. A
    // hostile client could therefore request `host:admin` while the human saw
    // nothing but a six-character code — approving a prompt that never told
    // them what they were approving. Pairing now means exactly one thing:
    // "this caller may discover this machine's projects and see the device
    // view." Nothing about that sentence is negotiable by the caller.
    //
    // `host:admin` — every project's receipts at once — is deliberately NOT
    // reachable through pairing at all. It belongs to the native CLI channel,
    // where the person IS the operator rather than a page asking to be trusted.
    const t = token();
    const granted = [...PAIRING_SCOPES];
    hostGrants.set(t, {
      principal: pending.principal, scopes: granted,
      issuedAt: now(), expiresAt: now() + ttlMs,
    });
    return { hostGrant: t, scopes: granted, expiresAt: now() + ttlMs, nodeInstanceId };
  }

  /** Verify a host grant for one scope. Returns the grant or throws. */
  function requireHost(hostToken, scope, { origin, client } = {}) {
    sweep();
    const grant = hostGrants.get(String(hostToken || ''));
    if (!grant) throw new GrantError('This needs a paired host grant. Approve the pairing on the node first.', 401);
    if (now() > grant.expiresAt) { hostGrants.delete(String(hostToken)); throw new GrantError('That host grant expired.', 401); }
    if (grant.principal !== principalOf(origin)) {
      throw new GrantError('That host grant was issued to a different caller.', 403);
    }
    if (scope && !grant.scopes.includes(scope)) {
      throw new GrantError(`That host grant does not carry ${scope}.`, 403);
    }
    return grant;
  }

  /**
   * Derive a project grant. `resolve` is the engine's own live-identity check:
   * it must return the project's stable id, root, and remote, or throw. The
   * caller never supplies those — it supplies only the id it selected.
   */
  function issueProjectGrant({ hostToken, projectId: wantedId, scopes, origin, client, resolve }) {
    const host = requireHost(hostToken, 'host:discover', { origin, client });

    const asked = Array.isArray(scopes) ? scopes : [];
    if (!asked.length) throw new GrantError('A project grant needs at least one explicit scope.', 400);
    const bad = asked.filter((s) => !PROJECT_SCOPES.includes(s));
    if (bad.length) throw new GrantError(`Unknown project scope: ${bad.join(', ')}`, 400);

    // Live identity, resolved by the engine at issue time. A registration whose
    // repo moved, was re-cloned, or re-pointed is not that project any more.
    const target = resolve(wantedId);

    // Anything that ACTS needs its own human gesture, naming this project and
    // these powers. Pairing consented to discovery and to reading; it did not
    // consent to running a harness in someone's repository or appending to
    // their Record, and a page must not be able to take that by asking.
    const elevated = asked.filter((s) => ELEVATED_SCOPES.includes(s));
    if (elevated.length) {
      return {
        needsApproval: true,
        ...beginScopeApproval({ principal: host.principal, target, scopes: asked, hostToken }),
      };
    }
    return { needsApproval: false, ...mintProjectGrant({ principal: host.principal, target, scopes: asked }) };
  }

  function mintProjectGrant({ principal, target, scopes }) {
    const t = token();
    projectGrants.set(t, {
      projectId: target.id, root: target.path, remote: target.remote || null,
      principal, scopes: [...scopes],
      issuedAt: now(), expiresAt: now() + ttlMs,
    });
    return {
      projectGrant: t, projectId: target.id, name: target.name,
      scopes: [...scopes], expiresAt: now() + ttlMs, nodeInstanceId,
    };
  }

  /**
   * Step one of an elevated grant. As with pairing, the code is displayed by
   * the node and never returned over HTTP, so the person approving can read
   * exactly which project and which powers they are being asked for.
   */
  function beginScopeApproval({ principal, target, scopes, hostToken }) {
    sweep();
    const scopeKey = [...new Set(scopes)].sort().join('\0');
    for (const [approvalId, pending] of pendingScopeApprovals) {
      if (!pending.spent
        && pending.principal === principal
        && pending.target.id === target.id
        && pending.target.path === target.path
        && (pending.target.remote || null) === (target.remote || null)
        && pending.scopeKey === scopeKey) {
        return {
          approvalId,
          code: pending.code,
          project: { id: pending.target.id, name: pending.target.name },
          scopes: [...pending.scopes],
          expiresAt: pending.createdAt + PAIRING_TTL_MS,
        };
      }
    }
    // A different ask for the SAME project SUPERSEDES the one already waiting,
    // rather than stacking beside it. Escalating scopes is normal — a client
    // asks to read, then to run, then to write the Record — and each new ask
    // makes the previous one obsolete. Stacking them counted one app's own
    // progression against its ceiling and, worse, left a stale prompt on the
    // terminal beside the current one for the human to tell apart.
    for (const [approvalId, pending] of pendingScopeApprovals) {
      if (pending.principal === principal
        && pending.target.id === target.id
        && pending.target.path === target.path
        && (pending.target.remote || null) === (target.remote || null)) {
        pendingScopeApprovals.delete(approvalId);
      }
    }
    // So the ceilings count PROMPTS A HUMAN MUST TELL APART: one per app per
    // project. An identical retry coalesced above; a superseding ask replaced
    // its predecessor; only a genuinely new project reaches the cap.
    let forThisPrincipal = 0;
    for (const pending of pendingScopeApprovals.values()) {
      if (pending.principal === principal) forThisPrincipal += 1;
    }
    if (forThisPrincipal >= MAX_PENDING_APPROVALS_PER_PRINCIPAL) {
      throw new GrantError(
        'Too many elevated approvals from this app are already waiting. Approve or ignore one, or wait two minutes.', 429,
      );
    }
    if (pendingScopeApprovals.size >= MAX_PENDING_APPROVALS_TOTAL) {
      throw new GrantError(
        'Too many elevated approvals are already waiting on this node. Approve or ignore one, or wait two minutes.', 429,
      );
    }
    const approvalId = crypto.randomBytes(8).toString('hex');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (const byte of crypto.randomBytes(6)) code += alphabet[byte % alphabet.length];
    pendingScopeApprovals.set(approvalId, {
      code, principal, target, scopes: [...scopes], scopeKey, createdAt: now(),
      // The host grant this was asked for. Re-verified at approval time: an
      // approval must not outlive the pairing that justified it.
      hostToken,
    });
    return {
      approvalId, code,
      project: { id: target.id, name: target.name },
      scopes: [...scopes],
      expiresAt: now() + PAIRING_TTL_MS,
    };
  }

  /** Step two: the code the person read off their own terminal. */
  function completeScopeApproval({ approvalId, code, origin, resolve }) {
    sweep();
    // No Origin, no authority — the same rule pairing enforces. Stated here
    // too rather than relied on transitively.
    if (!origin) {
      throw new GrantError('A caller with no origin cannot be granted authority over this machine.', 403);
    }
    const pending = pendingScopeApprovals.get(String(approvalId || ''));
    if (!pending) throw new GrantError('No approval is waiting. Ask again and read the code on the node.', 403);

    // The pairing must STILL be good. Without this, an approval that sat while
    // the host grant expired — or while the node's grants were swept — still
    // minted an acting grant, so the elevated one could outlive the consent it
    // was derived from.
    requireHost(pending.hostToken, 'host:discover', { origin });

    if (pending.principal !== principalOf(origin)) {
      throw new GrantError('This approval came from a different caller than the one that asked.', 403);
    }
    if (pending.spent) {
      throw new GrantError('That approval is no longer open. Ask again.', 403);
    }
    const given = String(code || '').trim().toUpperCase();
    const a = Buffer.from(given.padEnd(32, '\0'));
    const bb = Buffer.from(pending.code.padEnd(32, '\0'));
    if (given.length !== pending.code.length || !crypto.timingSafeEqual(a, bb)) {
      // Spent, not removed — same reason as pairing above. The critic drove 390
      // "asking to ACT in a project" prompts through the deletion.
      pending.spent = true;
      pending.code = '';
      throw new GrantError('That approval code does not match.', 403);
    }
    pendingScopeApprovals.delete(String(approvalId));

    // Re-resolved at approval time: the repo may have moved while the person
    // was reading their terminal.
    const target = typeof resolve === 'function' ? resolve(pending.target.id) : pending.target;
    return mintProjectGrant({ principal: pending.principal, target, scopes: pending.scopes });
  }

  /**
   * The gate every acting endpoint calls. Never falls back to "close enough":
   * a grant for another project, another principal, or without the scope is no
   * grant at all.
   */
  function requireProject(projectToken, { projectId: wantedId, scope, origin, client, revalidate } = {}) {
    sweep();
    const grant = projectGrants.get(String(projectToken || ''));
    if (!grant) throw new GrantError('This needs a project grant with the right scope.', 401);
    if (now() > grant.expiresAt) { projectGrants.delete(String(projectToken)); throw new GrantError('That project grant expired.', 401); }
    if (grant.principal !== principalOf(origin)) {
      throw new GrantError('That project grant was issued to a different caller.', 403);
    }
    if (wantedId && grant.projectId !== wantedId) {
      throw new GrantError('That grant belongs to a different project.', 403);
    }
    if (scope && !grant.scopes.includes(scope)) {
      throw new GrantError(`That grant does not carry ${scope}.`, 403);
    }
    // Identity is revalidated on USE, not just at issue: a repo can move while
    // a grant is still alive, and acting on the wrong directory is exactly the
    // failure this whole layer exists to prevent.
    if (typeof revalidate === 'function') {
      const live = revalidate(grant.projectId);
      // The remote is part of what this grant claims to bind. Checking only the
      // path left `.intent/` readable through a live grant after the repo was
      // re-pointed at a different origin — which is a different project.
      const remoteChanged = grant.remote != null
        && live != null && live.remote != null
        && live.remote !== grant.remote;
      if (!live || live.path !== grant.root || remoteChanged) {
        projectGrants.delete(String(projectToken));
        throw new GrantError('That project moved or is no longer registered. Select it again.', 409);
      }
    }
    return { ...grant, token: String(projectToken) };
  }

  return {
    nodeInstanceId,
    beginPairing,
    completePairing,
    requireHost,
    issueProjectGrant,
    completeScopeApproval,
    requireProject,
    principalOf,
    // Introspection for the node's own status line. Deliberately counts only —
    // never the tokens themselves.
    stats: () => ({ hostGrants: hostGrants.size, projectGrants: projectGrants.size, pending: pendingPairings.size }),
  };
}

module.exports = { createGrantStore, GrantError, PROJECT_SCOPES, HOST_SCOPES };
