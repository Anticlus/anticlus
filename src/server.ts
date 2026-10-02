import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  DEFAULT_ACTION_POLICIES,
  VERIFICATION_KINDS,
  guardRequestSchema,
  turnSchema,
  type ActionPolicy,
  type Counterparty,
  type Scorer
} from './contract.js';
import { createGateway } from './gateway/gateway.js';
import { hashParams } from './gateway/hash.js';
import {
  CHALLENGE_TTL_MS,
  SIGNATURE_HEADER,
  VERIFICATION_TTL_MS,
  sign,
  verifySignature,
  type Challenge,
  type LiveStore
} from './mfa.js';

/**
 * The live gateway: what a voice agent's host, the client's MFA backend and
 * the protected tool talk to during a real call.
 *
 * Three callers, three credentials, and no credential opens another's route:
 *  - the AGENT HOST (agent key) adds turns and asks to guard an action;
 *  - the client's MFA BACKEND (HMAC secret) answers a challenge;
 *  - the PROTECTED TOOL (tool key) consumes a grant before it acts.
 * The audit trail is read with a fourth, the admin key.
 *
 * The agent's answer never carries a score, a rule or the verification
 * target: only what it may say and, on `allow`, the grant id.
 */

export interface ServerOptions {
  store: LiveStore;
  scorer: Scorer;
  counterparties: readonly Counterparty[];
  policies?: readonly ActionPolicy[];
  keys: { agent: string; tool: string; admin: string };
  mfa: {
    /** Shared with the client's MFA backend. Signs the challenge out and the result in. */
    secret: string;
    /** Where a challenge is posted. Without it the challenge is only returned to the agent host. */
    webhookUrl?: string;
    challengeTtlMs?: number;
    verificationTtlMs?: number;
  };
  now?: () => Date;
  fetchImpl?: typeof fetch;
  onWebhookError?: (error: unknown, challenge: Challenge) => void;
}

const verificationBodySchema = z.object({
  challengeId: z.string().min(1).max(64),
  passed: z.boolean(),
  /** The method the client's system actually used. Defaults to the one the challenge suggested. */
  method: z.enum(VERIFICATION_KINDS).optional(),
  note: z.string().max(300).optional()
});

const consumeBodySchema = z.object({
  conversationId: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  params: z.record(z.string(), z.string().max(500)).default({})
});

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(options: ServerOptions): Hono {
  const { store, keys } = options;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const challengeTtlMs = options.mfa.challengeTtlMs ?? CHALLENGE_TTL_MS;
  const verificationTtlMs = options.mfa.verificationTtlMs ?? VERIFICATION_TTL_MS;
  const counterparties = new Map(options.counterparties.map((c) => [c.id, c]));

  const gateway = createGateway({
    scorer: options.scorer,
    store,
    counterparties: options.counterparties,
    policies: options.policies ?? DEFAULT_ACTION_POLICIES,
    now,
    requireBoundVerification: true
  });

  const app = new Hono();

  const bearer = (expected: string) => async (c: Context, next: () => Promise<void>) => {
    const header = c.req.header('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given || !sameKey(given, expected)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };

  async function deliver(challenge: Challenge): Promise<void> {
    if (!options.mfa.webhookUrl) return;
    const body = JSON.stringify({
      type: 'verification.requested',
      challengeId: challenge.id,
      conversationId: challenge.conversationId,
      counterpartyId: challenge.counterpartyId,
      action: challenge.action,
      paramsHash: challenge.paramsHash,
      kind: challenge.kind,
      target: challenge.target,
      expiresAt: challenge.expiresAt
    });
    const res = await fetchImpl(options.mfa.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: sign(options.mfa.secret, body, now().getTime())
      },
      body,
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`MFA webhook answered ${res.status}`);
  }

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/v1/conversations/:id/turns', bearer(keys.agent), async (c) => {
    const turn = turnSchema.safeParse(await c.req.json().catch(() => null));
    if (!turn.success) return c.json({ error: 'invalid_turn' }, 400);
    await gateway.addTurn(c.req.param('id')!, turn.data);
    return c.body(null, 204);
  });

  app.delete('/v1/conversations/:id', bearer(keys.agent), async (c) => {
    await store.deleteConversation(c.req.param('id')!);
    return c.body(null, 204);
  });

  app.post('/v1/guard', bearer(keys.agent), async (c) => {
    const req = guardRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!req.success) return c.json({ error: 'invalid_request' }, 400);
    const decision = await gateway.guard(req.data);

    let challenge: Challenge | null = null;
    if (decision.decision === 'verify_first' && decision.verification) {
      const paramsHash = hashParams(req.data.params);
      const at = now();
      challenge = await store.findOpenChallenge(
        req.data.conversationId,
        req.data.action,
        paramsHash,
        at.toISOString()
      );
      if (!challenge) {
        challenge = {
          id: randomUUID(),
          conversationId: req.data.conversationId,
          counterpartyId: decision.verification.counterpartyId,
          action: req.data.action,
          paramsHash,
          kind: decision.verification.kind,
          target: decision.verification.target,
          createdAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + challengeTtlMs).toISOString(),
          completedAt: null,
          passed: null
        };
        await store.saveChallenge(challenge);
        const opened = challenge;
        void deliver(opened).catch((error) => options.onWebhookError?.(error, opened));
      }
    }

    return c.json({
      decision: decision.decision,
      reasons: decision.reasons,
      spokenReply: decision.spokenReply,
      grantId: decision.grantId,
      challenge: challenge ? { id: challenge.id, expiresAt: challenge.expiresAt } : null
    });
  });

  app.post('/v1/verifications', async (c) => {
    const raw = await c.req.text();
    const at = now();
    const signature = verifySignature(options.mfa.secret, raw, c.req.header(SIGNATURE_HEADER), at.getTime());
    if (!signature.ok) return c.json({ error: 'bad_signature', reason: signature.reason }, 401);

    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* falls through to the schema refusal */
    }
    const body = verificationBodySchema.safeParse(json);
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);

    const challenge = await store.getChallenge(body.data.challengeId);
    if (!challenge || !counterparties.has(challenge.counterpartyId)) {
      return c.json({ error: 'unknown_challenge' }, 404);
    }
    if (challenge.completedAt !== null) return c.json({ error: 'already_answered' }, 409);
    if (new Date(challenge.expiresAt).getTime() <= at.getTime()) return c.json({ error: 'expired' }, 410);
    if (!(await store.completeChallenge(challenge.id, body.data.passed, at.toISOString()))) {
      return c.json({ error: 'already_answered' }, 409);
    }

    await gateway.recordVerification({
      conversationId: challenge.conversationId,
      counterpartyId: challenge.counterpartyId,
      kind: body.data.method ?? challenge.kind,
      passed: body.data.passed,
      note: body.data.note,
      action: challenge.action,
      paramsHash: challenge.paramsHash,
      expiresAt: new Date(at.getTime() + verificationTtlMs).toISOString()
    });
    return c.json({ recorded: true });
  });

  app.post('/v1/grants/:id/consume', bearer(keys.tool), async (c) => {
    const body = consumeBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    const result = await gateway.consumeGrant(
      c.req.param('id')!,
      body.data.conversationId,
      body.data.action,
      body.data.params
    );
    if (!result.ok) return c.json({ ok: false, reason: result.reason }, 409);
    return c.json({ ok: true, counterpartyId: result.counterpartyId, verifiedBy: result.verifiedBy });
  });

  app.get('/v1/audit', bearer(keys.admin), async (c) => {
    return c.json({ rows: await store.listAudit(c.req.query('conversationId')) });
  });

  return app;
}
