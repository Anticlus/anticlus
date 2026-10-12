import type {
  ActionPolicy,
  Counterparty,
  Decision,
  CallScore,
  TrustLevel,
  VerificationRequest
} from '../contract.js';

const TRUST_RANK: Record<TrustLevel, number> = { anonymous: 0, identified: 1, verified: 2 };

/** The rule ids. They go to the audit trail only, never to the caller. */
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
  score: CallScore;
  params: Readonly<Record<string, string>>;
  /** A fact-check for this conversation is still running. */
  factCheckPending: boolean;
  /** The counterparty record the scorer matched, for the callback target. */
  counterparty: Counterparty | null;
  /** A verification for that counterparty failed in this conversation. */
  verificationFailed: boolean;
  /**
   * Every signal came from content a tool returned, none from the caller: a
   * document or page carried an injection. The caller's own request is then
   * not what is suspect, so the risk does not escalate the conversation; the
   * injected values are refused, and any change needs the verification.
   */
  contentOnly?: boolean;
}

/** The same value as a person reads it on a screen: letters and digits only, case ignored. */
const fold = (v: string) => v.toLowerCase().replace(/[^a-z0-9@.]/g, '');

/** Whether the parameter the claim touches carries the claim's value (an injected IBAN, address, path). */
function carries(params: Readonly<Record<string, string>>, touches: string, value: string): boolean {
  const given = params[touches];
  if (given === undefined) return false;
  const a = fold(given);
  const b = fold(value);
  if (!b) return true;
  return a === b || (b.length >= 6 && a.includes(b)) || (a.length >= 6 && b.includes(a));
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
 *  1. risk at or above the action's limit: escalate (unless every signal came
 *     from content a tool returned: then the caller is not the suspect);
 *  2. a contradicted claim whose value this action carries, a contradicted
 *     counterparty on a change, or a failed verification: deny (BEFORE the
 *     trust check, so a contradicted caller is refused, not asked to verify);
 *  3. trust below what the action needs: verify first, through the official
 *     contact details on file, never through ones given in the conversation;
 *  4. a fact-check that has not come back: verify first;
 *  5. allow.
 */
export function decide(input: DecideInput): DecideOutput {
  const { policy, trust, score, counterparty } = input;

  if (score.risk >= policy.riskLimit && !input.contentOnly) {
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
  // A contradicted claim refuses the action. When the contradiction comes from injected content, only
  // the action that carries the injected value is refused: the user's own transfer to another account is not.
  const refused = (c: (typeof touched)[number]) =>
    c.status === 'contradicted' && (!input.contentOnly || carries(input.params, c.touches!, c.value));
  if (touched.some(refused)) return denial(RULES.claimContradicted);
  if (policy.tier >= 2 && score.counterparty.contradicted) return denial(RULES.counterpartyContradicted);
  // One refusal by the contact on file ends the conversation's access to anything that needs
  // identification: the caller is not who they say, and the contact is not asked again.
  if (policy.tier >= 1 && input.verificationFailed) return denial(RULES.verificationFailed);

  // Under an injection in the content, no change goes through on identification alone.
  const requiredTrust = input.contentOnly && policy.tier >= 2 ? 'verified' : policy.requiredTrust;
  if (TRUST_RANK[trust] < TRUST_RANK[requiredTrust]) {
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
