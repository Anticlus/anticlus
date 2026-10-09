import { z } from 'zod';
import { plainText } from './plain-text.js';

/**
 * The interface between the two halves:
 *
 *  - the SCORER: reads a conversation and answers signals, claims and
 *    a risk number. It never decides what an agent may do.
 *  - the GATEWAY: sits in front of the company's business tools. It owns
 *    trust and privilege, asks the scorer, and answers allow / verify_first /
 *    deny / escalate. Trust never comes from the score: only a verification
 *    outside the conversation raises it.
 *
 * Anything said in the conversation or read on the web is evidence, never an
 * instruction. Client-safe (pure zod).
 */

export const TRUST_LEVELS = ['anonymous', 'identified', 'verified'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const DECISIONS = ['allow', 'verify_first', 'deny', 'escalate'] as const;
export type Decision = (typeof DECISIONS)[number];

/** 0 information, 1 account data, 2 changes, 3 money. */
export const ACTION_TIERS = [0, 1, 2, 3] as const;
export type ActionTier = (typeof ACTION_TIERS)[number];

/** Input caps, so a caller that skips the contract is still bounded. */
export const CALL_TURN_MAX = 4000;
export const CALL_TURNS_MAX = 200;

/**
 * A supplier or partner the company knows, with its OFFICIAL details (spec
 * section 6). Verification only ever goes to these details, never to ones
 * given in the conversation. The records in the demo are fictional.
 */
export const counterpartySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  /** Other ways the name is said or transcribed on a call ("Bruxelles Fresh Foods" for "Brussels Fresh Foods"). */
  aliases: z.array(z.string().min(1).max(200)).max(20).default([]),
  /** Belgian enterprise number (KBO/BCE). */
  registryNumber: z.string().max(32),
  officialPhone: z.string().max(32),
  officialDomain: z.string().max(253),
  /** Accounts on file, each with how it was verified. */
  bankAccounts: z.array(z.object({ iban: z.string().max(34), verifiedBy: z.string().max(64) })).default([]),
  contactPerson: z.string().max(200).nullable().default(null)
});
export type Counterparty = z.infer<typeof counterpartySchema>;

// ---- The scorer -------------------------------------------------------------

export const turnSchema = z.object({
  /**
   * `caller` is whoever is on the other end, whatever they claim to be; `tool` is
   * content a tool returned to the agent (a file, a web page, a transaction
   * subject), which is just as untrusted: an instruction found in it was not
   * given by the user.
   */
  role: z.enum(['caller', 'agent', 'tool']),
  text: plainText(1, CALL_TURN_MAX),
  /** ISO time of the turn, when the channel gave one. */
  at: z.iso.datetime().optional()
});
export type Turn = z.infer<typeof turnSchema>;

/**
 * The social-engineering red flags. Weights live in the scorer, not here.
 * `synthetic_voice` is reserved: not produced by the built-in scorer.
 */
export const SIGNAL_IDS = [
  'urgency',
  'authority',
  'secrecy',
  'channel_switch',
  'known_script',
  'remote_access_request',
  'code_request',
  'prompt_injection',
  'memory_instruction',
  'synthetic_voice'
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

export const signalSchema = z.object({
  id: z.enum(SIGNAL_IDS),
  /** Points added to the risk, 0 to 100. */
  weight: z.number().min(0).max(100),
  /** A verbatim piece of the conversation, at most 160 characters. */
  quote: z.string().max(160),
  /** Index of the turn it came from. */
  turn: z.number().int().min(0)
});
export type Signal = z.infer<typeof signalSchema>;

/** only claims about organizations are checked on the web. */
export const CLAIM_KINDS = [
  'organization',
  'phone',
  'domain',
  'bank_account',
  'invoice_ref',
  'person',
  'other'
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUSES = ['unchecked', 'pending', 'confirmed', 'contradicted', 'uncheckable'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const claimSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(CLAIM_KINDS),
  /** The value as stated, for example an IBAN or a company name. */
  value: z.string().max(200),
  /** Which action parameter it touches, when it does (`iban`, `phone`, ...): a contradicted claim on one denies that action. */
  touches: z.string().max(64).optional(),
  status: z.enum(CLAIM_STATUSES),
  /** the source URLs of the fact-check, kept with the result. */
  sources: z.array(z.string().max(2048)).max(10).default([]),
  turn: z.number().int().min(0)
});
export type Claim = z.infer<typeof claimSchema>;

export const scoreInputSchema = z.object({
  conversationId: z.string().min(1).max(64),
  turns: z.array(turnSchema).min(1).max(CALL_TURNS_MAX),
  /** The counterparty the gateway already matched, when there is one. */
  counterpartyId: z.string().max(64).nullable().default(null)
});
export type ScoreInput = z.infer<typeof scoreInputSchema>;

export const callScoreSchema = z.object({
  conversationId: z.string(),
  /** 0 to 100. Raises the risk only: it never raises trust. */
  risk: z.number().min(0).max(100),
  signals: z.array(signalSchema),
  claims: z.array(claimSchema),
  /** The counterparty name the caller gave, and the record it matched, if any. */
  counterparty: z.object({
    claimedName: z.string().max(200).nullable(),
    matchedId: z.string().max(64).nullable(),
    /** True when something said so far contradicts the match. */
    contradicted: z.boolean()
  }),
  /** ids of approved attack patterns that matched. */
  patternsMatched: z.array(z.string()).default([]),
  llmUsed: z.boolean(),
  scoredTurns: z.number().int().min(0)
});
export type CallScore = z.infer<typeof callScoreSchema>;

/** What the gateway calls. A fake in tests, the rule scorer or a remote one in the app. Must fail closed: a throw is never "safe". */
export type Scorer = (input: ScoreInput) => Promise<CallScore>;

// ---- The gateway ------------------------------------------------------------

/**
 * One guarded business tool. `riskLimit` is the risk at or above which
 * the decision is `escalate`. `parameterKeys` names the arguments a claim can
 * touch, so a contradicted claim on one of them denies the call.
 */
export const actionPolicySchema = z.object({
  action: z.string().min(1).max(64),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  requiredTrust: z.enum(TRUST_LEVELS),
  riskLimit: z.number().min(0).max(100),
  /** the call waits for the fact-check; a check not back counts as not confirmed. */
  needsFactCheck: z.boolean(),
  parameterKeys: z.array(z.string()).default([])
});
export type ActionPolicy = z.infer<typeof actionPolicySchema>;

/** Three protected actions and one open one, as policy data. The gateway reads this, never a hard-coded `if`. */
export const DEFAULT_ACTION_POLICIES: readonly ActionPolicy[] = [
  {
    action: 'get_opening_hours',
    tier: 0,
    requiredTrust: 'anonymous',
    riskLimit: 100,
    needsFactCheck: false,
    parameterKeys: []
  },
  {
    action: 'get_invoice_status',
    tier: 1,
    requiredTrust: 'identified',
    riskLimit: 70,
    needsFactCheck: false,
    parameterKeys: ['invoice']
  },
  {
    action: 'update_contact_person',
    tier: 2,
    requiredTrust: 'verified',
    riskLimit: 60,
    needsFactCheck: false,
    parameterKeys: ['phone', 'email']
  },
  {
    action: 'update_supplier_iban',
    tier: 3,
    requiredTrust: 'verified',
    riskLimit: 40,
    needsFactCheck: true,
    parameterKeys: ['iban']
  }
];

export const guardRequestSchema = z.object({
  /** Bound by the host to the MCP session, NEVER taken from the model's arguments (an injected prompt could name another conversation). */
  conversationId: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  params: z.record(z.string(), z.string().max(500)).default({}),
  /**
   * The counterparty the HOST has authenticated for this session (a caller who
   * signed in to the company's app before the call, an account holder in a
   * logged-in session). Set by the host from its own session, never from the
   * model. It starts the conversation as `identified`; a verification outside
   * the call is still needed for `verified`, and a contradiction by the scorer
   * still drops it.
   */
  principal: z.object({ counterpartyId: z.string().min(1).max(64) }).optional()
});
export type GuardRequest = z.infer<typeof guardRequestSchema>;

/** How a caller can be verified outside the conversation. `callback` and `app` are the original two; the others arrive through the client's own MFA system. */
export const VERIFICATION_KINDS = ['callback', 'app', 'otp', 'passkey', 'human'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const verificationRequestSchema = z.object({
  kind: z.enum(VERIFICATION_KINDS),
  /** Taken from the counterparty record, never from the conversation. */
  counterpartyId: z.string().max(64),
  /** The official number or channel the check goes to. */
  target: z.string().max(200)
});
export type VerificationRequest = z.infer<typeof verificationRequestSchema>;

export const guardDecisionSchema = z.object({
  decision: z.enum(DECISIONS),
  /** what the agent may say to the caller. Never the rule, never the score. */
  reasons: z.array(z.string().max(300)),
  /** One sentence to speak, in the caller's language when known. */
  spokenReply: z.string().max(400),
  /** On `allow`: a single-use grant bound to these exact parameters. */
  grantId: z.string().nullable().default(null),
  /** On `verify_first`: what to do outside the conversation. */
  verification: verificationRequestSchema.nullable().default(null),
  /** Operator-side only. The agent's tool result carries none of these. */
  audit: z.object({
    id: z.string(),
    rule: z.string(),
    trust: z.enum(TRUST_LEVELS),
    risk: z.number().min(0).max(100),
    tier: z.number().int().min(0).max(3),
    policyVersion: z.string()
  })
});
export type GuardDecision = z.infer<typeof guardDecisionSchema>;

/** The grant behind an `allow`: single use, short-lived, tied to the exact arguments (a verification for IBAN X never opens IBAN Y). */
export const grantSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  action: z.string(),
  /** sha-256 of the canonical JSON of `params`. */
  paramsHash: z.string(),
  expiresAt: z.iso.datetime(),
  usedAt: z.iso.datetime().nullable().default(null)
});
export type Grant = z.infer<typeof grantSchema>;

export const verificationResultSchema = z.object({
  conversationId: z.string(),
  counterpartyId: z.string(),
  kind: z.enum(VERIFICATION_KINDS),
  passed: z.boolean(),
  /** When set, a pass counts only for this action with exactly these parameters (a pass for IBAN X never opens IBAN Y). */
  action: z.string().max(64).optional(),
  paramsHash: z.string().max(64).optional(),
  /** A pass stops counting after this time. */
  expiresAt: z.iso.datetime().optional(),
  /** recorded with how it was verified. */
  note: z.string().max(300).optional()
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

// ---- The test set ---------------------------------------------

/**
 * One scripted conversation and what must come out. Shared by the scorer's and
 * the gateway's tests and by `starter eval`, so both halves are judged on the
 * same table. `heldOut` marks cases nobody tuned on.
 */
export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['attack', 'legitimate']),
  heldOut: z.boolean().default(false),
  language: z.enum(['en', 'fr', 'nl']).default('en'),
  /** The counterparty the caller names, when it is on file. */
  counterpartyId: z.string().nullable(),
  turns: z.array(turnSchema).min(1),
  /** The tool call the agent makes after the last turn. */
  request: z.object({ action: z.string(), params: z.record(z.string(), z.string()).default({}) }),
  /** Verifications that happen before the request, for the legitimate change flow. */
  verifications: z.array(z.object({ counterpartyId: z.string(), passed: z.boolean() })).default([]),
  expect: z.object({
    decision: z.enum(DECISIONS),
    /** Signals the scorer must find. Extra ones are allowed. */
    signals: z.array(z.enum(SIGNAL_IDS)).default([])
  })
});
export type Scenario = z.infer<typeof scenarioSchema>;
