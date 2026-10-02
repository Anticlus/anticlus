import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scorer } from '../src/contract.js';
import { MemoryLiveStore, SIGNATURE_HEADER, sign, verifySignature, type LiveStore } from '../src/mfa.js';
import { createScoringScorer } from '../src/scorer/adapter.js';
import { SEED_COUNTERPARTIES } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { SqliteStore } from '../src/store-sqlite.js';

const KEYS = { agent: 'agent-key', tool: 'tool-key', admin: 'admin-key' };
const SECRET = 'mfa-shared-secret';
const NEW_IBAN = 'BE43068999999501';
const OTHER_IBAN = 'NL91ABNA0417164300';

/** A scorer that matched Acme, found nothing alarming, and whose IBAN claim came back confirmed. */
const calmScorer: Scorer = async (input) => ({
  conversationId: input.conversationId,
  risk: 0,
  signals: [],
  claims: [
    { id: 'c1', kind: 'bank_account', value: 'iban', touches: 'iban', status: 'confirmed', sources: [], turn: 0 }
  ],
  counterparty: { claimedName: 'Acme Industrial', matchedId: 'acme', contradicted: false },
  patternsMatched: [],
  llmUsed: false,
  scoredTurns: input.turns.length
});

interface Posted {
  url: string;
  body: string;
  signature: string;
}

function setup(over: { store?: LiveStore; scorer?: Scorer } = {}) {
  let clock = new Date('2026-10-02T22:00:00.000Z').getTime();
  const posted: Posted[] = [];
  const store = over.store ?? new MemoryLiveStore();
  const app = createApp({
    store,
    scorer: over.scorer ?? calmScorer,
    counterparties: SEED_COUNTERPARTIES,
    keys: KEYS,
    mfa: { secret: SECRET, webhookUrl: 'https://client.example/mfa' },
    now: () => new Date(clock),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      posted.push({ url: String(url), body: String(init?.body), signature: headers[SIGNATURE_HEADER]! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch
  });

  const call = (path: string, key: string | null, body?: unknown, method = 'POST') =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  const say = (text: string, id = 'call-1') =>
    call(`/v1/conversations/${id}/turns`, KEYS.agent, { role: 'caller', text });
  const guard = async (iban = NEW_IBAN, id = 'call-1') =>
    (await (
      await call('/v1/guard', KEYS.agent, { conversationId: id, action: 'update_supplier_iban', params: { iban } })
    ).json()) as {
      decision: string;
      grantId: string | null;
      challenge: { id: string; expiresAt: string } | null;
    } & Record<string, unknown>;
  const answer = (challengeId: string, passed: boolean, opts: { secret?: string; at?: number } = {}) => {
    const body = JSON.stringify({ challengeId, passed, method: 'app' });
    return app.request('/v1/verifications', {
      method: 'POST',
      headers: { [SIGNATURE_HEADER]: sign(opts.secret ?? SECRET, body, opts.at ?? clock) },
      body
    });
  };
  const consume = (grantId: string, iban = NEW_IBAN, key = KEYS.tool) =>
    call(`/v1/grants/${grantId}/consume`, key, {
      conversationId: 'call-1',
      action: 'update_supplier_iban',
      params: { iban }
    });

  return {
    app,
    store,
    posted,
    call,
    say,
    guard,
    answer,
    consume,
    advance: (ms: number) => {
      clock += ms;
    },
    clock: () => clock
  };
}

describe('the live gateway', () => {
  it('keeps each credential on its own routes', async () => {
    const t = setup();
    expect((await t.call('/v1/guard', null, {})).status).toBe(401);
    expect((await t.call('/v1/guard', KEYS.tool, {})).status).toBe(401);
    expect((await t.consume('any', NEW_IBAN, KEYS.agent)).status).toBe(401);
    expect((await t.call('/v1/audit', KEYS.agent, undefined, 'GET')).status).toBe(401);
    // No bearer key records a verification: only the signature does.
    const unsigned = await t.call('/v1/verifications', KEYS.admin, { challengeId: 'x', passed: true });
    expect(unsigned.status).toBe(401);
  });

  it('asks the client MFA system, then grants exactly the verified action once', async () => {
    const t = setup();
    await t.say('Hello, Sophie Maes from Acme Industrial. We are moving to a new bank.');

    const first = await t.guard();
    expect(first.decision).toBe('verify_first');
    expect(first.grantId).toBeNull();
    expect(first.challenge).not.toBeNull();
    // The agent's answer carries nothing it could leak to the caller.
    expect(Object.keys(first).sort()).toEqual(['challenge', 'decision', 'grantId', 'reasons', 'spokenReply']);
    expect(JSON.stringify(first)).not.toContain('+3225550101');

    // The client's backend received a signed challenge with the target on file.
    expect(t.posted).toHaveLength(1);
    const delivery = t.posted[0]!;
    expect(delivery.url).toBe('https://client.example/mfa');
    expect(verifySignature(SECRET, delivery.body, delivery.signature, t.clock()).ok).toBe(true);
    const payload = JSON.parse(delivery.body);
    expect(payload).toMatchObject({
      type: 'verification.requested',
      challengeId: first.challenge!.id,
      counterpartyId: 'acme',
      action: 'update_supplier_iban',
      target: '+3225550101'
    });

    // Asking again while it is pending opens no second challenge.
    const again = await t.guard();
    expect(again.challenge!.id).toBe(first.challenge!.id);
    expect(t.posted).toHaveLength(1);

    expect((await t.answer(first.challenge!.id, true)).status).toBe(200);

    const second = await t.guard();
    expect(second.decision).toBe('allow');
    expect(second.grantId).toEqual(expect.any(String));

    const used = await t.consume(second.grantId!);
    expect(await used.json()).toEqual({ ok: true, counterpartyId: 'acme', verifiedBy: 'app' });
    const replay = await t.consume(second.grantId!);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ ok: false, reason: 'used' });
  });

  it('does not let a pass for one IBAN open another', async () => {
    const t = setup();
    await t.say('Hello, Sophie Maes from Acme Industrial.');
    const first = await t.guard(NEW_IBAN);
    await t.answer(first.challenge!.id, true);

    const other = await t.guard(OTHER_IBAN);
    expect(other.decision).toBe('verify_first');
    expect(other.challenge!.id).not.toBe(first.challenge!.id);

    const granted = await t.guard(NEW_IBAN);
    expect((await t.consume(granted.grantId!, OTHER_IBAN)).status).toBe(409);
  });

  it('denies after a failed verification', async () => {
    const t = setup();
    await t.say('Hello, this is Karen from Acme Industrial finance.');
    const first = await t.guard();
    expect((await t.answer(first.challenge!.id, false)).status).toBe(200);
    const second = await t.guard();
    expect(second.decision).toBe('deny');
    expect(second.grantId).toBeNull();
  });

  it('refuses a forged, stale, repeated or late answer', async () => {
    const t = setup();
    await t.say('Hello, Sophie Maes from Acme Industrial.');
    const { challenge } = await t.guard();

    expect((await t.answer(challenge!.id, true, { secret: 'wrong' })).status).toBe(401);
    expect((await t.answer(challenge!.id, true, { at: t.clock() - 6 * 60_000 })).status).toBe(401);
    expect((await t.guard()).decision).toBe('verify_first');
    expect((await t.answer('no-such-challenge', true)).status).toBe(404);

    expect((await t.answer(challenge!.id, true)).status).toBe(200);
    expect((await t.answer(challenge!.id, true)).status).toBe(409);

    const late = setup();
    await late.say('Hello, Sophie Maes from Acme Industrial.');
    const pending = await late.guard();
    late.advance(11 * 60_000);
    expect((await late.answer(pending.challenge!.id, true)).status).toBe(410);
    expect((await late.guard()).decision).toBe('verify_first');
  });

  it('stops counting a pass once it has expired', async () => {
    const t = setup();
    await t.say('Hello, Sophie Maes from Acme Industrial.');
    const first = await t.guard();
    await t.answer(first.challenge!.id, true);
    t.advance(11 * 60_000);
    const later = await t.guard();
    expect(later.decision).toBe('verify_first');
    expect(later.challenge!.id).not.toBe(first.challenge!.id);
  });

  it('forgets the call when the conversation ends, and keeps the audit trail', async () => {
    const t = setup();
    await t.say('Hello, Sophie Maes from Acme Industrial.');
    const { challenge } = await t.guard();
    expect((await t.call('/v1/conversations/call-1', KEYS.agent, undefined, 'DELETE')).status).toBe(204);
    expect((await t.answer(challenge!.id, true)).status).toBe(404);

    const audit = (await (await t.call('/v1/audit?conversationId=call-1', KEYS.admin, undefined, 'GET')).json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ decision: 'verify_first', action: 'update_supplier_iban' });
    expect(JSON.stringify(audit.rows)).not.toContain(NEW_IBAN);
    expect(JSON.stringify(audit.rows)).not.toContain('Sophie');
  });

  it('does not let an ended conversation be reused to shed a failed verification', async () => {
    const t = setup();
    await t.say('Hello, this is Karen from Acme Industrial finance.');
    const first = await t.guard();
    await t.answer(first.challenge!.id, false);
    expect((await t.guard()).decision).toBe('deny');

    await t.call('/v1/conversations/call-1', KEYS.agent, undefined, 'DELETE');
    expect((await t.say('Hello again, Acme Industrial here.')).status).toBe(410);
    const retry = await t.call('/v1/guard', KEYS.agent, {
      conversationId: 'call-1',
      action: 'update_supplier_iban',
      params: { iban: NEW_IBAN }
    });
    expect(retry.status).toBe(410);
  });

  it('works with the built-in rule scorer on a change that needs no fact-check', async () => {
    const t = setup({ scorer: createScoringScorer({ counterparties: SEED_COUNTERPARTIES }) });
    await t.say('Hello, Sophie Maes from Acme Industrial. I would like to update our contact phone number.');
    const body = { conversationId: 'call-1', action: 'update_contact_person', params: { phone: '+3225550199' } };
    const first = (await (await t.call('/v1/guard', KEYS.agent, body)).json()) as {
      decision: string;
      challenge: { id: string } | null;
    };
    expect(first.decision).toBe('verify_first');
    await t.answer(first.challenge!.id, true);
    const second = (await (await t.call('/v1/guard', KEYS.agent, body)).json()) as { decision: string };
    expect(second.decision).toBe('allow');
  });
});

describe('the SQLite store', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('keeps a pending challenge and an open grant across a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anticlus-'));
    const file = join(dir, 'gateway.db');

    const before = new SqliteStore(file);
    const one = setup({ store: before });
    await one.say('Hello, Sophie Maes from Acme Industrial.');
    const first = await one.guard();
    before.close();

    const middle = new SqliteStore(file);
    const two = setup({ store: middle });
    expect((await two.answer(first.challenge!.id, true)).status).toBe(200);
    const granted = await two.guard();
    expect(granted.decision).toBe('allow');
    middle.close();

    const after = new SqliteStore(file);
    const three = setup({ store: after });
    expect((await three.consume(granted.grantId!)).status).toBe(200);
    expect((await three.consume(granted.grantId!)).status).toBe(409);
    expect(await after.listAudit('call-1')).toHaveLength(2);
    after.close();
  });
});
