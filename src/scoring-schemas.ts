import { z } from 'zod';
import { plainText } from './plain-text.js';

/**
 * Scoring: the three scam-risk tools of Scam Sentinel, on ONE scale.
 *
 *  - `script`: what is said (the transcript so far) and the call's metadata.
 *  - `history`: the previous calls of this caller and of the organization it claims.
 *  - `factcheck`: H's agent checks the caller's claims on the web.
 *
 * Every tool answers a risk score from 0 (nothing suspicious) to 100 (a scam),
 * built the same way: each reason carries a weight between 0 and 1, and the
 * score is their noisy-OR, `100 × (1 − Π(1 − w))`. Two weak reasons add up,
 * one strong reason dominates, and the score never leaves 0–100. History and
 * fact-checks only ever ADD reasons: a clean history or a confirmed claim
 * gives 0, never a negative weight (trust comes from verification, not from
 * scores). Client-safe (pure zod).
 */

export const SCORING_TOOLS = ['script', 'history', 'factcheck', 'voice', 'known_scams'] as const;
export type ScoringTool = (typeof SCORING_TOOLS)[number];

export const SCORE_LEVELS = ['low', 'medium', 'high', 'pending', 'unknown'] as const;
export type ScoreLevel = (typeof SCORE_LEVELS)[number];

export const CALL_CHANNELS = ['phone', 'web_voice', 'whatsapp', 'teams', 'agent_to_agent'] as const;
export type CallChannel = (typeof CALL_CHANNELS)[number];

/** The company tools a caller may be trying to get the agent to use (the gateway decides on them). */
export const INTENDED_ACTIONS = [
  'update_supplier_iban',
  'release_payment',
  'share_invoice',
  'update_contact_details',
  'reset_access'
] as const;
export type IntendedActionKey = (typeof INTENDED_ACTIONS)[number];

export const TRANSCRIPT_MAX = 20000;

/** The score of a set of weights (each 0..1): their noisy-OR on 0..100. */
export function combineWeights(weights: readonly number[]): number {
  const keep = weights.reduce((p, w) => p * (1 - Math.min(1, Math.max(0, w))), 1);
  return Math.round(100 * (1 - keep));
}

/** The level a score reads as. */
export function levelOf(score: number): 'low' | 'medium' | 'high' {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

const optionalLine = (max: number) => plainText(0, max).optional();

/** What is known of a call besides its words. */
export const callMetadataSchema = z.object({
  /** The caller's number, handle or agent id, as presented (caller ID can be faked). */
  callerAddress: plainText(1, 100),
  channel: z.enum(CALL_CHANNELS),
  /** The organization the caller claims to represent, when known before the call. */
  claimedOrganization: optionalLine(200),
  /** The company receiving the call (the protected agent's company). */
  calleeCompany: optionalLine(200),
  /** The official website of the claimed organization, when the company has it on file. */
  officialWebsite: z.url({ protocol: /^https?$/ }).max(500).optional()
});
export type CallMetadata = z.infer<typeof callMetadataSchema>;

export const scoreReasonSchema = z.object({
  /** A stable key, e.g. `urgency`, `iban_not_listed`. */
  code: z.string(),
  /** One readable sentence. */
  label: z.string(),
  /** Its weight, 0..1. */
  weight: z.number(),
  /** The words or the source behind it, when there are any. */
  evidence: z.string().nullable()
});
export type ScoreReason = z.infer<typeof scoreReasonSchema>;

/** The one shape every tool answers. `score` is null while pending or when it could not be computed. */
export const scoreResultSchema = z.object({
  tool: z.enum(SCORING_TOOLS),
  score: z.number().int().min(0).max(100).nullable(),
  level: z.enum(SCORE_LEVELS),
  reasons: z.array(scoreReasonSchema),
  computedAt: z.string()
});
export type ScoreResult = z.infer<typeof scoreResultSchema>;

/** The claims the script tool pulled out of the words, for the fact-check. */
export const extractedClaimsSchema = z.object({
  organization: z.string().nullable(),
  iban: z.string().nullable(),
  phone: z.string().nullable(),
  domain: z.string().nullable()
});
export type ExtractedClaims = z.infer<typeof extractedClaimsSchema>;

export const intendedActionSchema = z.object({
  action: z.enum(INTENDED_ACTIONS),
  label: z.string(),
  /** The parameters heard so far (e.g. `{ iban }`). */
  params: z.record(z.string(), z.string()),
  /** The words that revealed it. */
  evidence: z.string()
});
export type IntendedAction = z.infer<typeof intendedActionSchema>;

// ── Calls (the history's memory) ─────────────────────────────────────────────

export const scoredCallCreateSchema = z.object({ metadata: callMetadataSchema });
export type ScoredCallCreate = z.infer<typeof scoredCallCreateSchema>;

/** The scores a client reports back as the call goes on; the max is kept for the history. */
export const scoredCallUpdateSchema = z.object({
  scriptScore: z.number().int().min(0).max(100).nullable().optional(),
  historyScore: z.number().int().min(0).max(100).nullable().optional(),
  factcheckScore: z.number().int().min(0).max(100).nullable().optional(),
  claimedOrganization: optionalLine(200),
  claimedIban: optionalLine(64),
  ended: z.boolean().optional()
});
export type ScoredCallUpdate = z.infer<typeof scoredCallUpdateSchema>;

export const scoredCallSchema = z.object({
  id: z.string(),
  callerAddress: z.string(),
  channel: z.enum(CALL_CHANNELS),
  claimedOrganization: z.string().nullable(),
  claimedIban: z.string().nullable(),
  scriptScore: z.number().nullable(),
  historyScore: z.number().nullable(),
  factcheckScore: z.number().nullable(),
  flagged: z.boolean(),
  createdAt: z.string(),
  endedAt: z.string().nullable()
});
export type ScoredCall = z.infer<typeof scoredCallSchema>;

export const scoredCallCreatedSchema = z.object({ call: scoredCallSchema });
export type ScoredCallCreated = z.infer<typeof scoredCallCreatedSchema>;

// ── The three tools ──────────────────────────────────────────────────────────

export const scriptScoreRequestSchema = z.object({
  transcript: plainText(0, TRANSCRIPT_MAX),
  metadata: callMetadataSchema
});
export type ScriptScoreRequest = z.infer<typeof scriptScoreRequestSchema>;

export const scriptScoreSchema = scoreResultSchema.extend({
  claims: extractedClaimsSchema,
  intendedActions: z.array(intendedActionSchema)
});
export type ScriptScore = z.infer<typeof scriptScoreSchema>;

export const historyScoreRequestSchema = z.object({
  metadata: callMetadataSchema,
  /** The current call, left out of its own history. */
  callId: z.uuid().optional(),
  claimedIban: optionalLine(64)
});
export type HistoryScoreRequest = z.infer<typeof historyScoreRequestSchema>;

export const factCheckRequestSchema = z.object({
  organization: plainText(1, 200),
  callerAddress: optionalLine(100),
  iban: optionalLine(64),
  domain: optionalLine(200),
  officialWebsite: z.url({ protocol: /^https$/ }).max(500).optional()
});
export type FactCheckRequest = z.infer<typeof factCheckRequestSchema>;

/** A fact-check is an H run: `id` is the run's id; poll `GET /scoring/factcheck/{id}`. */
export const factCheckSchema = scoreResultSchema.extend({
  id: z.string(),
  state: z.enum(['running', 'completed', 'failed']),
  liveUrl: z.string().nullable(),
  /** What H found, once completed and readable. */
  findings: z
    .object({
      companyFound: z.boolean().nullable(),
      officialWebsite: z.string().nullable(),
      officialPhones: z.array(z.string()),
      callerPhoneListed: z.boolean().nullable(),
      ibanListed: z.boolean().nullable(),
      sources: z.array(z.string())
    })
    .nullable()
});
export type FactCheck = z.infer<typeof factCheckSchema>;

// ── Voice clone (Resemble AI) ────────────────────────────────────────────────

/** The longest caller sample sent for voice analysis: 20 s of 16 kHz mono 16-bit, base64 (under the 1 MiB body cap). */
export const VOICE_SAMPLE_MAX_BASE64 = 900_000;

export const voiceCheckRequestSchema = z.object({
  /** The CALLER's channel only, as a 16-bit PCM WAV, base64. The trusted agent is never sent. */
  audio: z.base64().min(1).max(VOICE_SAMPLE_MAX_BASE64),
  contentType: z.literal('audio/wav')
});
export type VoiceCheckRequest = z.infer<typeof voiceCheckRequestSchema>;

export const voiceCheckSchema = scoreResultSchema.extend({
  id: z.string(),
  state: z.enum(['running', 'completed', 'failed']),
  provider: z.string()
});
export type VoiceCheck = z.infer<typeof voiceCheckSchema>;

export const voiceCheckParamsSchema = z.object({ id: z.string().min(1).max(100) });

// ── Known scams ──────────────────────────────────────────────────────────────

export const knownScamsRequestSchema = z.object({ transcript: plainText(0, TRANSCRIPT_MAX) });
export type KnownScamsRequest = z.infer<typeof knownScamsRequestSchema>;

export const knownScamMatchSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  /** The share of the script's indicators the call hits, 0..1. */
  coverage: z.number(),
  matched: z.array(z.string())
});
export type KnownScamMatch = z.infer<typeof knownScamMatchSchema>;

export const knownScamsScoreSchema = scoreResultSchema.extend({ matches: z.array(knownScamMatchSchema) });
export type KnownScamsScore = z.infer<typeof knownScamsScoreSchema>;
