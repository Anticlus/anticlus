import type {
  ActionPolicy,
  Counterparty,
  Decision,
  SentinelScoreResult,
  TrustLevel,
  VerificationRequest
} from '../contract.js';

const TRUST_RANK: Record<TrustLevel, number> = { anonymous: 0, identified: 1, verified: 2 };

/** The rule ids. They go to the audit trail only, never to the caller (BR-11). */
export const RULES = {
  riskOverLimit: 'risk_over_limit',
  claimContradicted: 'claim_contradicted',
  counterpartyContradicted: 'counterparty_contradicted',
  verificationFailed: 'verification_failed',
  trustTooLow: 'trust_too_low',
  factCheckNotBack: 'fact_check_not_back',
  allowed: 'allowed'
} as const;

export interface DecideInput {
  policy: ActionPolicy;
  trust: TrustLevel;
  score: SentinelScoreResult;
  params: Readonly<Record<string, string>>;
  /** A fact-check for this conversation is still running. */
  factCheckPending: boolean;
  /** The counterparty record the scorer matched, for the callback target. */
  counterparty: Counterparty | null;
  /** A verification for that counterparty failed in this conversation. */
  verificationFailed: boolean;
}

export interface DecideOutput {
  decision: Decision;
  rule: string;
  /** Sayable to the caller: no rule ids, no score, no threshold, no figures. */
  reasons: string[];
  spokenReply: string;
  verification: VerificationRequest | null;
}

function out(
  decision: Decision,
  rule: string,
  reasons: string[],
  spokenReply: string,
  verification: VerificationRequest | null = null
): DecideOutput {
  return { decision, rule, reasons, spokenReply, verification };
}

/**
 * The policy gate, pure. The order is the point:
 *  1. risk at or above the action's limit: escalate;
 *  2. a contradicted claim on a parameter of this action, a contradicted
 *     counterparty on a change, or a failed verification: deny (BEFORE the
 *     trust check, so a contradicted caller is refused, not asked to verify);
 *  3. trust below what the action needs: verify first, through the official
 *     contact details on file, never through ones given in the conversation;
 *  4. a fact-check that has not come back (BR-10): verify first;
 *  5. allow.
 */
export function decide(input: DecideInput): DecideOutput {
  const { policy, trust, score, counterparty } = input;

  if (score.risk >= policy.riskLimit) {
    return out(
      'escalate',
      RULES.riskOverLimit,
      ['This request needs a colleague to review it.'],
      "I'm going to pass this to a colleague on our finance team, who will get back to you."
    );
  }

  const touched = score.claims.filter(
    (c) => c.touches !== undefined && policy.parameterKeys.includes(c.touches)
  );
  const denial = (rule: string) =>
    out(
      'deny',
      rule,
      ["I can't make this change on this call.", 'A colleague on our finance team can look at it with you.'],
      "I can't make this change on this call. I can pass you to a colleague on our finance team who can look into it."
    );
  if (touched.some((c) => c.status === 'contradicted')) return denial(RULES.claimContradicted);
  if (policy.tier >= 2 && score.counterparty.contradicted) return denial(RULES.counterpartyContradicted);
  if (policy.tier >= 2 && input.verificationFailed) return denial(RULES.verificationFailed);

  if (TRUST_RANK[trust] < TRUST_RANK[policy.requiredTrust]) {
    if (counterparty) {
      return out(
        'verify_first',
        RULES.trustTooLow,
        ['Requests like this need to be confirmed outside this call.'],
        `Before I can do that, I'll confirm it with ${counterparty.name} using the contact details we already have on file.`,
        { kind: 'callback', counterpartyId: counterparty.id, target: counterparty.officialPhone }
      );
    }
    return out(
      'verify_first',
      RULES.trustTooLow,
      ["I can't share or change that without knowing which company you represent."],
      'Could you tell me which company you are calling from, so I can look up your record?'
    );
  }

  if (policy.needsFactCheck) {
    const unsettled =
      touched.length === 0 || touched.some((c) => c.status === 'pending' || c.status === 'unchecked');
    if (input.factCheckPending || unsettled) {
      return out(
        'verify_first',
        RULES.factCheckNotBack,
        ["I'm still checking some details, so I can't complete this just yet."],
        "I'm still checking a few details, so I can't complete this just yet."
      );
    }
  }

  return out('allow', RULES.allowed, ['Request approved.'], "That's fine, I'll go ahead with it.");
}
