import type { Counterparty, SentinelScoreResult, TrustLevel, VerificationResult } from '../contract.js';

export type CounterpartyIndex = ReadonlyMap<string, Counterparty>;

export function indexCounterparties(list: readonly Counterparty[]): Map<string, Counterparty> {
  return new Map(list.map((c) => [c.id, c]));
}

/** The record the scorer matched, only when it really is on file. */
export function matchedCounterparty(
  score: SentinelScoreResult,
  counterparties: CounterpartyIndex
): Counterparty | null {
  const id = score.counterparty.matchedId;
  return id ? (counterparties.get(id) ?? null) : null;
}

/**
 * The trust level of a conversation. Pure, and deliberately blind to signals,
 * risk and how long or how politely the caller talks (BR-4).
 *  - BR-1: anonymous by default.
 *  - BR-2: identified when the caller names a counterparty on file and nothing
 *    contradicts it.
 *  - BR-3: verified only when a verification PASSED for that same counterparty
 *    outside the conversation, and none failed.
 * A contradiction drops the conversation back to anonymous.
 */
export function computeTrust(
  score: SentinelScoreResult,
  verifications: readonly VerificationResult[],
  counterparties: CounterpartyIndex
): TrustLevel {
  const counterparty = matchedCounterparty(score, counterparties);
  if (!counterparty || score.counterparty.contradicted) return 'anonymous';
  const mine = verifications.filter((v) => v.counterpartyId === counterparty.id);
  if (mine.some((v) => !v.passed)) return 'identified';
  return mine.some((v) => v.passed) ? 'verified' : 'identified';
}

/** True when a verification for this counterparty failed in this conversation. */
export function verificationFailed(
  counterparty: Counterparty | null,
  verifications: readonly VerificationResult[]
): boolean {
  return (
    counterparty !== null && verifications.some((v) => v.counterpartyId === counterparty.id && !v.passed)
  );
}
