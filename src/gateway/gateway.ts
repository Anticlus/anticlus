import { randomUUID } from 'node:crypto';
import {
  DEFAULT_ACTION_POLICIES,
  guardDecisionSchema,
  guardRequestSchema,
  sentinelScoreResultSchema,
  turnSchema,
  verificationResultSchema,
  type ActionPolicy,
  type Counterparty,
  type GuardDecision,
  type GuardRequest,
  type SentinelScoreResult,
  type Scorer,
  type Turn,
  type VerificationKind,
  type VerificationResult
} from '../contract.js';
import { decide } from './decide.js';
import { hashParams } from './hash.js';
import type { GrantRecord, SentinelStore } from './store.js';
import { computeTrust, indexCounterparties, matchedCounterparty, verificationFailed } from './trust.js';

export const GRANT_TTL_MS = 120_000;
export const SCORER_TIMEOUT_MS = 2000;

export type GrantRefusal =
  'unknown' | 'wrong_conversation' | 'wrong_action' | 'wrong_params' | 'used' | 'expired';

export type ConsumeResult =
  | { ok: true; grant: GrantRecord; counterpartyId: string | null; verifiedBy: VerificationKind | null }
  | { ok: false; reason: GrantRefusal };

export interface GatewayOptions {
  scorer: Scorer;
  store: SentinelStore;
  counterparties: readonly Counterparty[];
  policies?: readonly ActionPolicy[];
  now?: () => Date;
  /** Recorded in every audit row: the policy that was applied (spec section 9). */
  policyVersion?: string;
  scorerTimeoutMs?: number;
  grantTtlMs?: number;
  /** Whether a fact-check for the conversation is still running (BR-10). */
  isFactCheckPending?: (conversationId: string) => boolean;
  /**
   * When true, a PASSED verification counts only if it is bound to the action and
   * the exact parameters being guarded and has not expired. A failed one always
   * counts. Off by default for in-process use; the HTTP server turns it on.
   */
  requireBoundVerification?: boolean;
}

export interface Gateway {
  addTurn(conversationId: string, turn: Turn): Promise<void>;
  recordVerification(result: VerificationResult): Promise<void>;
  guard(request: GuardRequest): Promise<GuardDecision>;
  consumeGrant(
    grantId: string,
    conversationId: string,
    action: string,
    params: Record<string, string>
  ): Promise<ConsumeResult>;
}

/** What a scorer outage looks like to the gate: maximum risk, nothing matched, nothing trusted. */
function failedScore(conversationId: string): SentinelScoreResult {
  return {
    conversationId,
    risk: 100,
    signals: [],
    claims: [],
    counterparty: { claimedName: null, matchedId: null, contradicted: false },
    patternsMatched: [],
    llmUsed: false,
    scoredTurns: 0
  };
}

function emptyScore(conversationId: string): SentinelScoreResult {
  return { ...failedScore(conversationId), risk: 0 };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('scorer timed out')), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The authorization gateway's core. It owns trust and privilege: the scorer
 * only reports signals, claims and risk. Anything unknown, late or broken
 * fails closed, and an `allow` is a single-use grant tied to the exact
 * parameters it was asked for.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const { scorer, store } = options;
  const policies = options.policies ?? DEFAULT_ACTION_POLICIES;
  const now = options.now ?? (() => new Date());
  const policyVersion = options.policyVersion ?? 'default-1';
  const timeoutMs = options.scorerTimeoutMs ?? SCORER_TIMEOUT_MS;
  const grantTtlMs = options.grantTtlMs ?? GRANT_TTL_MS;
  const counterparties = indexCounterparties(options.counterparties);
  const policyOf = new Map(policies.map((p) => [p.action, p]));

  async function audit(
    req: GuardRequest,
    decision: GuardDecision['decision'],
    fields: { rule: string; trust: GuardDecision['audit']['trust']; risk: number; tier: number }
  ): Promise<GuardDecision['audit']> {
    const row = {
      id: randomUUID(),
      conversationId: req.conversationId,
      action: req.action,
      decision,
      ...fields,
      policyVersion,
      paramsHash: hashParams(req.params),
      at: now().toISOString()
    };
    await store.appendAudit(row);
    return {
      id: row.id,
      rule: row.rule,
      trust: row.trust,
      risk: row.risk,
      tier: row.tier,
      policyVersion
    };
  }

  async function score(conversationId: string): Promise<{ result: SentinelScoreResult; failed: boolean }> {
    const conversation = await store.ensureConversation(conversationId);
    if (conversation.turns.length === 0) return { result: emptyScore(conversationId), failed: false };
    try {
      const raw = await withTimeout(
        scorer({
          conversationId,
          turns: conversation.turns.map((t) => ({ ...t })),
          counterpartyId: conversation.counterpartyId
        }),
        timeoutMs
      );
      return { result: sentinelScoreResultSchema.parse(raw), failed: false };
    } catch {
      return { result: failedScore(conversationId), failed: true };
    }
  }

  return {
    async addTurn(conversationId, turn) {
      await store.appendTurn(conversationId, turnSchema.parse(turn));
    },

    async recordVerification(result) {
      const parsed = verificationResultSchema.parse(result);
      if (!counterparties.has(parsed.counterpartyId)) return;
      await store.addVerification(parsed.conversationId, parsed);
    },

    async guard(raw) {
      const req = guardRequestSchema.parse(raw);
      const policy = policyOf.get(req.action);
      if (!policy) {
        const rule = 'unknown_action';
        const audited = await audit(req, 'deny', { rule, trust: 'anonymous', risk: 0, tier: 3 });
        return guardDecisionSchema.parse({
          decision: 'deny',
          reasons: ["I can't do that."],
          spokenReply: "I'm not able to do that.",
          grantId: null,
          verification: null,
          audit: audited
        });
      }

      const { result, failed } = await score(req.conversationId);
      const conversation = await store.ensureConversation(req.conversationId);
      const paramsHash = hashParams(req.params);
      const verifications = conversation.verifications.filter((v) => {
        if (!v.passed) return true;
        if (v.expiresAt !== undefined && new Date(v.expiresAt).getTime() <= now().getTime()) return false;
        if (v.action === undefined && v.paramsHash === undefined) return !options.requireBoundVerification;
        return v.action === req.action && v.paramsHash === paramsHash;
      });
      const counterparty = matchedCounterparty(result, counterparties);
      const trust = computeTrust(result, verifications, counterparties);
      if (counterparty && !result.counterparty.contradicted) {
        await store.setCounterparty(req.conversationId, counterparty.id);
      }

      const outcome = decide({
        policy,
        trust,
        score: result,
        params: req.params,
        factCheckPending: options.isFactCheckPending?.(req.conversationId) ?? false,
        counterparty,
        verificationFailed: verificationFailed(counterparty, verifications)
      });
      const rule = failed ? 'scorer_failed' : outcome.rule;

      let grantId: string | null = null;
      if (outcome.decision === 'allow') {
        const verified = counterparty
          ? verifications.find((v) => v.passed && v.counterpartyId === counterparty.id)
          : undefined;
        const grant: GrantRecord = {
          id: randomUUID(),
          conversationId: req.conversationId,
          action: req.action,
          paramsHash: hashParams(req.params),
          expiresAt: new Date(now().getTime() + grantTtlMs).toISOString(),
          usedAt: null,
          counterpartyId: counterparty?.id ?? null,
          verifiedBy: verified?.kind ?? null
        };
        await store.saveGrant(grant);
        grantId = grant.id;
      }

      const audited = await audit(req, outcome.decision, {
        rule,
        trust,
        risk: result.risk,
        tier: policy.tier
      });
      return guardDecisionSchema.parse({
        decision: outcome.decision,
        reasons: outcome.reasons,
        spokenReply: outcome.spokenReply,
        grantId,
        verification: outcome.verification,
        audit: audited
      });
    },

    async consumeGrant(grantId, conversationId, action, params) {
      const grant = await store.getGrant(grantId);
      if (!grant) return { ok: false, reason: 'unknown' };
      if (grant.conversationId !== conversationId) return { ok: false, reason: 'wrong_conversation' };
      if (grant.action !== action) return { ok: false, reason: 'wrong_action' };
      if (grant.paramsHash !== hashParams(params)) return { ok: false, reason: 'wrong_params' };
      if (grant.usedAt !== null) return { ok: false, reason: 'used' };
      if (new Date(grant.expiresAt).getTime() <= now().getTime()) return { ok: false, reason: 'expired' };
      if (!(await store.markGrantUsed(grantId, now().toISOString()))) return { ok: false, reason: 'used' };
      return { ok: true, grant, counterpartyId: grant.counterpartyId, verifiedBy: grant.verifiedBy };
    }
  };
}
