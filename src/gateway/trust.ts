import type { Counterparty, CallScore, TrustLevel, VerificationResult } from '../contract.js';

export type CounterpartyIndex = ReadonlyMap<string, Counterparty>;

export function indexCounterparties(list: readonly Counterparty[]): Map<string, Counterparty> {
  return new Map(list.map((c) => [c.id, c]));
}

/** The record the scorer matched, only when it really is on file. */
export function matchedCounterparty(
  score: CallScore,
  counterparties: CounterpartyIndex
): Counterparty | null {
  const id = score.counterparty.matchedId;
  return id ? (counterparties.get(id) ?? null) : null;
}

/**
 * The trust level of a conversation. Pure, and deliberately blind to signals,
 * risk and how long or how politely the caller talks.
 *  - anonymous by default.
 *  - identified when the caller names a counterparty on file and nothing
 *    contradicts it.
 *  - verified only when a verification PASSED for that same counterparty
 *    outside the conversation, and none failed.
 * A contradiction drops the conversation back to anonymous.
 */
export function computeTrust(
  score: CallScore,
  verifications: readonly VerificationResult[],
  counterparties: CounterpartyIndex,
  /** The counterparty the host authenticated for this session, when it did. */
  authenticatedAs: string | null = null
): TrustLevel {
  const counterparty = matchedCounterparty(score, counterparties);
  if (!counterparty || score.counterparty.contradicted) return 'anonymous';
  const base: TrustLevel = authenticatedAs === counterparty.id ? 'authenticated' : 'identified';
  const mine = verifications.filter((v) => v.counterpartyId === counterparty.id);
  if (mine.some((v) => !v.passed)) return base;
  return mine.some((v) => v.passed) ? 'verified' : base;
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
