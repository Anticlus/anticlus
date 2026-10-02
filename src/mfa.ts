import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerificationKind } from './contract.js';
import { MemoryStore, type GatewayStore } from './gateway/store.js';

/**
 * Step-up verification through the CLIENT's own MFA system.
 *
 * When the gateway answers `verify_first`, the server opens a challenge and
 * posts it, signed, to a URL the client configured. The client's backend runs
 * whatever it already has (a banking-app push, a one-time code, a callback by
 * a human) and posts the signed result back. The agent is never part of this
 * exchange: it holds neither the secret nor a route that records a result.
 *
 * A challenge is bound to one conversation, one action and the hash of its
 * exact parameters, is answered once, and expires.
 */

export const SIGNATURE_HEADER = 'anticlus-signature';
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;
export const CHALLENGE_TTL_MS = 10 * 60_000;
/** How long a passed verification keeps counting for its action. */
export const VERIFICATION_TTL_MS = 10 * 60_000;

export interface Challenge {
  id: string;
  conversationId: string;
  counterpartyId: string;
  action: string;
  paramsHash: string;
  /** The method the policy suggests; the client reports the one it used. */
  kind: VerificationKind;
  /** Where the check goes: taken from the counterparty record, never from the call. */
  target: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  passed: boolean | null;
}

/** What the HTTP server needs on top of the gateway's store. */
export interface LiveStore extends GatewayStore {
  saveChallenge(challenge: Challenge): Promise<void>;
  getChallenge(id: string): Promise<Challenge | null>;
  /** The challenge still waiting for this exact request, if any (so a repeated guard does not open a second one). */
  findOpenChallenge(conversationId: string, action: string, paramsHash: string, now: string): Promise<Challenge | null>;
  /** Atomic: true only for the one caller that found the challenge unanswered. */
  completeChallenge(id: string, passed: boolean, at: string): Promise<boolean>;
  /**
   * The call is over: its turns, verifications, open challenges and unused grants go. Audit rows stay,
   * and the id is remembered as ended so it cannot be reused to shed a failed verification.
   */
  deleteConversation(id: string): Promise<void>;
  isEnded(id: string): Promise<boolean>;
}

export class MemoryLiveStore extends MemoryStore implements LiveStore {
  private readonly challenges = new Map<string, Challenge>();
  private readonly ended = new Set<string>();

  async saveChallenge(challenge: Challenge): Promise<void> {
    this.challenges.set(challenge.id, { ...challenge });
  }

  async getChallenge(id: string): Promise<Challenge | null> {
    const found = this.challenges.get(id);
    return found ? { ...found } : null;
  }

  async findOpenChallenge(conversationId: string, action: string, paramsHash: string, now: string) {
    for (const c of this.challenges.values()) {
      if (
        c.conversationId === conversationId &&
        c.action === action &&
        c.paramsHash === paramsHash &&
        c.completedAt === null &&
        c.expiresAt > now
      )
        return { ...c };
    }
    return null;
  }

  async completeChallenge(id: string, passed: boolean, at: string): Promise<boolean> {
    const found = this.challenges.get(id);
    if (!found || found.completedAt !== null) return false;
    found.completedAt = at;
    found.passed = passed;
    return true;
  }

  async isEnded(id: string): Promise<boolean> {
    return this.ended.has(id);
  }

  async deleteConversation(id: string): Promise<void> {
    this.ended.add(id);
    this.conversations.delete(id);
    for (const [key, c] of this.challenges) if (c.conversationId === id) this.challenges.delete(key);
    for (const [key, g] of this.grants) if (g.conversationId === id && g.usedAt === null) this.grants.delete(key);
  }
}

/** `t=<unix ms>,v1=<hex hmac-sha256 of "<t>.<body>">`. The same scheme in both directions. */
export function sign(secret: string, body: string, at: number): string {
  const mac = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${mac}`;
}

export type SignatureRefusal = 'missing' | 'malformed' | 'stale' | 'mismatch';

export function verifySignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  now: number,
  toleranceMs = SIGNATURE_TOLERANCE_MS
): { ok: true } | { ok: false; reason: SignatureRefusal } {
  if (!header) return { ok: false, reason: 'missing' };
  const match = /^t=(\d{1,16}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!match) return { ok: false, reason: 'malformed' };
  const at = Number(match[1]);
  if (Math.abs(now - at) > toleranceMs) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(createHmac('sha256', secret).update(`${at}.${body}`).digest('hex'));
  const given = Buffer.from(match[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}
