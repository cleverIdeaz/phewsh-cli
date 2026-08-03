const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGrantStore,
  GrantError,
} = require('../lib/capability-grants');

function pairedHost(store, origin) {
  const pending = store.beginPairing({ origin, client: 'test-client' });
  return store.completePairing({
    pairingId: pending.pairingId,
    code: pending.code,
    origin,
  }).hostGrant;
}

function target(id) {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    remote: `https://example.test/${id}.git`,
  };
}

function requestApproval(store, { hostToken, origin, projectId, scopes }) {
  return store.issueProjectGrant({
    hostToken,
    origin,
    projectId,
    scopes,
    resolve: target,
  });
}

test('an identical pending project-and-scope request reuses one human approval', () => {
  const store = createGrantStore();
  const origin = 'https://ion.example.test';
  const hostToken = pairedHost(store, origin);

  const first = requestApproval(store, {
    hostToken,
    origin,
    projectId: 'project-a',
    scopes: ['truth:read', 'work:run', 'record:write'],
  });
  const repeated = requestApproval(store, {
    hostToken,
    origin,
    projectId: 'project-a',
    scopes: ['record:write', 'truth:read', 'work:run'],
  });

  assert.equal(first.needsApproval, true);
  assert.equal(repeated.needsApproval, true);
  assert.equal(repeated.approvalId, first.approvalId);
  assert.equal(repeated.code, first.code);
  assert.equal(repeated.expiresAt, first.expiresAt);
});

test('one paired principal cannot queue more than three distinct elevated approvals', () => {
  const store = createGrantStore();
  const origin = 'https://noisy.example.test';
  const hostToken = pairedHost(store, origin);

  for (const projectId of ['project-a', 'project-b', 'project-c']) {
    const pending = requestApproval(store, {
      hostToken,
      origin,
      projectId,
      scopes: ['work:run'],
    });
    assert.equal(pending.needsApproval, true);
  }

  assert.throws(
    () => requestApproval(store, {
      hostToken,
      origin,
      projectId: 'project-d',
      scopes: ['work:run'],
    }),
    (error) => error instanceof GrantError
      && error.status === 429
      && /too many elevated approvals/i.test(error.message)
      && /from this app/i.test(error.message),
  );
});

test('escalating scopes for one project supersedes the ask already waiting', () => {
  const store = createGrantStore();
  const origin = 'https://ion.example.test';
  const hostToken = pairedHost(store, origin);

  // The normal progression: read, then run, then also write the Record. Each
  // ask makes the last obsolete, so the human sees ONE current prompt naming
  // one project — never a pile to tell apart — and the app never spends its own
  // ceiling walking up its own scopes.
  let previous = null;
  for (const scopes of [['work:run'], ['record:write'], ['work:control'], ['truth:read', 'work:run']]) {
    const pending = requestApproval(store, { hostToken, origin, projectId: 'project-a', scopes });
    assert.equal(pending.needsApproval, true);
    if (previous) assert.notEqual(pending.approvalId, previous, 'a new scope set is a new ask');
    previous = pending.approvalId;
  }

  // Still room for other projects: the progression consumed one slot, not four.
  for (const projectId of ['project-b', 'project-c']) {
    assert.equal(
      requestApproval(store, { hostToken, origin, projectId, scopes: ['work:run'] }).needsApproval,
      true,
    );
  }
  assert.throws(
    () => requestApproval(store, {
      hostToken, origin, projectId: 'project-d', scopes: ['work:run'],
    }),
    (error) => error instanceof GrantError && error.status === 429,
  );
});

test('the node refuses a new elevated approval once the terminal is globally saturated', () => {
  const store = createGrantStore();
  const origins = [
    'https://one.example.test',
    'https://two.example.test',
    'https://three.example.test',
  ];
  const tokens = new Map(origins.map((origin) => [origin, pairedHost(store, origin)]));

  // Two apiece stays under the per-principal cap of three but reaches the
  // global ceiling, so the refusal below can only be the global one.
  for (const origin of origins) {
    for (const projectId of ['project-a', 'project-b']) {
      const pending = requestApproval(store, {
        hostToken: tokens.get(origin), origin, projectId, scopes: ['work:run'],
      });
      assert.equal(pending.needsApproval, true);
    }
  }

  assert.throws(
    () => requestApproval(store, {
      hostToken: tokens.get(origins[0]),
      origin: origins[0],
      projectId: 'project-c',
      scopes: ['work:run'],
    }),
    (error) => error instanceof GrantError
      && error.status === 429
      && /too many elevated approvals/i.test(error.message)
      && /on this node/i.test(error.message),
  );
});

test('an abandoned approval frees its slot once it expires', () => {
  let clock = 1_000_000;
  const store = createGrantStore({ now: () => clock });
  const origin = 'https://patient.example.test';
  const hostToken = pairedHost(store, origin);

  for (const projectId of ['project-a', 'project-b', 'project-c']) {
    requestApproval(store, { hostToken, origin, projectId, scopes: ['work:run'] });
  }
  assert.throws(
    () => requestApproval(store, {
      hostToken, origin, projectId: 'project-d', scopes: ['work:run'],
    }),
    (error) => error instanceof GrantError && error.status === 429,
  );

  // Nobody typed a code. Two minutes later the queue is the human's again.
  clock += (2 * 60 * 1000) + 1;

  const afterExpiry = requestApproval(store, {
    hostToken, origin, projectId: 'project-d', scopes: ['work:run'],
  });
  assert.equal(afterExpiry.needsApproval, true);
});

// ─── Found by an independent critic, 2026-07-29 ──────────────────────────────
//
// Every ceiling above was unreachable. A wrong code DELETED the pending entry
// before comparing, so `request → wrong code → request` looped without limit:
// the critic drove 745 pairing prompts in three seconds from an allowlisted
// origin, and 390 elevated "asking to ACT in a project" prompts — faster than the
// 61-in-0.59s flood the ceilings were added to stop.
//
// Burning a wrong guess is still right; six characters is useless against
// thousands of attempts. So the entry is SPENT rather than removed: it can never
// be guessed again, and it keeps occupying its slot until it expires, which is
// what makes the ceiling real. Only a genuine human approval frees a slot early.

test('a wrong pairing code does not hand the slot back', () => {
  const store = createGrantStore();
  const origin = 'https://flood.example.test';

  const pending = [];
  for (let i = 0; i < 3; i++) {
    pending.push(store.beginPairing({ origin, client: 'test-client' }));
  }
  assert.throws(
    () => store.beginPairing({ origin, client: 'test-client' }),
    (error) => error instanceof GrantError && error.status === 429,
  );

  // Guess wrong at all three. Each guess must burn its pairing WITHOUT making
  // room for another prompt.
  for (const p of pending) {
    assert.throws(
      () => store.completePairing({ pairingId: p.pairingId, code: 'WRONG1', origin }),
      (error) => error instanceof GrantError && error.status === 403,
    );
  }
  assert.throws(
    () => store.beginPairing({ origin, client: 'test-client' }),
    (error) => error instanceof GrantError && error.status === 429,
    'a wrong code freed a slot, so the ceiling can be walked around forever',
  );

  // And the burnt pairing can never be completed, even with the right code.
  assert.throws(
    () => store.completePairing({ pairingId: pending[0].pairingId, code: pending[0].code, origin }),
    (error) => error instanceof GrantError && error.status === 403,
  );
});

test('a wrong elevated approval code does not hand the slot back either', () => {
  const store = createGrantStore();
  const origin = 'https://noisy.example.test';
  const hostToken = pairedHost(store, origin);

  const pending = [];
  for (const projectId of ['project-a', 'project-b', 'project-c']) {
    pending.push(requestApproval(store, { hostToken, origin, projectId, scopes: ['work:run'] }));
  }
  assert.throws(
    () => requestApproval(store, { hostToken, origin, projectId: 'project-d', scopes: ['work:run'] }),
    (error) => error instanceof GrantError && error.status === 429,
  );

  for (const p of pending) {
    assert.throws(
      () => store.completeScopeApproval({ approvalId: p.approvalId, code: 'WRONG1', origin, resolve: target }),
      (error) => error instanceof GrantError && error.status === 403,
    );
  }
  assert.throws(
    () => requestApproval(store, { hostToken, origin, projectId: 'project-d', scopes: ['work:run'] }),
    (error) => error instanceof GrantError && error.status === 429,
    'a wrong code freed a slot, so the operator can still be buried in prompts',
  );
});

test('a real human approval does free its slot', () => {
  // The ceiling must not punish the person for succeeding.
  const store = createGrantStore();
  const origin = 'https://honest.example.test';
  const hostToken = pairedHost(store, origin);

  const first = requestApproval(store, { hostToken, origin, projectId: 'project-a', scopes: ['work:run'] });
  store.completeScopeApproval({ approvalId: first.approvalId, code: first.code, origin, resolve: target });

  for (const projectId of ['project-b', 'project-c', 'project-d']) {
    assert.equal(
      requestApproval(store, { hostToken, origin, projectId, scopes: ['work:run'] }).needsApproval,
      true,
    );
  }
});
