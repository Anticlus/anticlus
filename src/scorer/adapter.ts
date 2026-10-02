import {
  combineWeights,
  type CallMetadata,
  type Claim,
  type Counterparty,
  type FactCheck,
  type ScoreResult as ScoringResult,
  type Scorer,
  type SentinelScoreResult,
  type Signal,
  type SignalId,
  type Turn
} from '../contract.js';
import { scoreScript } from './script.js';

/**
 * Adapts Gilles's scoring tools (`apps/server/src/scoring`, risk 0..100 from weighted
 * reasons) to the gateway's `Scorer`. The gateway keeps the decision and the
 * trust; this only turns what the scoring tools found into signals, claims,
 * a counterparty match and one risk number.
 *
 * What it does not do: raise trust (a score never does, BR-4), fetch the web
 * (a fact-check is an H run that arrives through `factCheckFor`), or touch the
 * database (history arrives through `historyFor`).
 */

/** Gilles's reason codes mapped to the contract's signals. A code not listed still counts in the risk, but is not a social-engineering signal. */
const SIGNAL_FOR_CODE: Readonly<Record<string, SignalId>> = {
  urgency: 'urgency',
  authority: 'authority',
  secrecy: 'secrecy',
  channel_switch: 'channel_switch',
  callback_number_given: 'channel_switch',
  credentials_request: 'code_request',
  instruction_injection: 'prompt_injection',
  verification_bypass: 'known_script',
  payment_details_change: 'known_script',
  unusual_payment: 'known_script'
};

/**
 * Two signals the scoring tools do not have yet: asking the agent to remember
 * an instruction (memory poisoning) and asking for remote access. English and
 * French, like the rest of his rules.
 */
const SUPPLEMENT: ReadonlyArray<{ id: SignalId; code: string; weight: number; patterns: readonly RegExp[] }> =
  [
    {
      id: 'memory_instruction',
      code: 'memory_instruction',
      weight: 0.5,
      patterns: [
        /\b(remember|keep in mind|note for (the )?future|from now on|always)\b[^.?!]{0,80}\b(invoices?|payments?|account|iban|bank)\b/i,
        /\b(souviens-toi|retiens|dor[ée]navant|à partir de maintenant)\b[^.?!]{0,80}\b(factures?|paiements?|compte|iban|banque)\b/i
      ]
    },
    {
      id: 'remote_access_request',
      code: 'remote_access_request',
      weight: 0.4,
      patterns: [
        /\b(anydesk|teamviewer|remote access|share your screen|install (this|the) (app|software))\b/i,
        /\b(acc[èe]s [àa] distance|partager (votre )?[ée]cran)\b/i
      ]
    }
  ];

const DEFAULT_METADATA: CallMetadata = { callerAddress: 'browser-call', channel: 'web_voice' };

export interface ScoringScorerOptions {
  counterparties: readonly Counterparty[];
  /** What is known of the call besides its words. A neutral browser call by default. */
  metadataFor?: (conversationId: string) => CallMetadata | undefined;
  /** The conversation's fact-check (an H run), when there is one. `running` reads as pending, never as confirmed (BR-10). */
  factCheckFor?: (conversationId: string) => FactCheck | null | undefined;
  /** The history score of the caller, when the caller's previous calls are known. Adds reasons, never subtracts. */
  historyFor?: (conversationId: string) => Promise<ScoringResult | null> | ScoringResult | null;
  now?: () => Date;
}

const normalize = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const firstToken = (v: string) => normalize(v).split(' ')[0] ?? '';
const digits = (v: string) => v.replace(/\D/g, '');
const host = (v: string) =>
  v
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');

/** The counterparty the caller named: the one the gateway already matched, else a name whose first word (4+ letters) is the same. */
function matchCounterparty(
  claimedName: string | null,
  knownId: string | null,
  counterparties: readonly Counterparty[]
): Counterparty | null {
  if (knownId) return counterparties.find((c) => c.id === knownId) ?? null;
  if (!claimedName) return null;
  const token = firstToken(claimedName);
  if (token.length < 4) return null;
  return counterparties.find((c) => firstToken(c.name) === token) ?? null;
}

/**
 * Words that make a supplier's name the OBJECT of the sentence ("your open
 * invoices with Acme", "les factures de Delta") rather than who is calling.
 */
const REFERENTIAL = new Set([
  'invoice', 'invoices', 'amount', 'amounts', 'payment', 'payments', 'account', 'accounts', 'record', 'records',
  'list', 'status', 'supplier', 'suppliers', 'vendor', 'vendors', 'about', 'regarding', 'concerning',
  'facture', 'factures', 'montant', 'montants', 'paiement', 'paiements', 'compte', 'comptes', 'fiche', 'fiches',
  'liste', 'statut', 'fournisseur', 'fournisseurs', 'concernant'
]);
const REFERENTIAL_WINDOW = 5;

/** True when `words[at]` starts a mention that the few words before it turn into a reference. */
function isReference(words: readonly string[], at: number): boolean {
  return words.slice(Math.max(0, at - REFERENTIAL_WINDOW), at).some((w) => REFERENTIAL.has(w));
}

/**
 * A supplier on file that the caller presents as their own company: its full
 * name, or its first word (4+ letters) as a whole word, in a place where it is
 * not merely talked ABOUT. Asking for "the open invoices with Acme" names Acme
 * without claiming to be Acme, and must not identify the caller. More than one
 * supplier claimed means no match, never a guess.
 */
function namedOnFile(transcript: string, counterparties: readonly Counterparty[]): Counterparty | null {
  const words = normalize(transcript).split(' ');
  const hits = counterparties.filter((c) => {
    const name = normalize(c.name).split(' ');
    const token = name[0] ?? '';
    return words.some((word, at) => {
      const full = name.every((part, i) => words[at + i] === part);
      const short = token.length >= 4 && word === token;
      return (full || short) && !isReference(words, at);
    });
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** The index of the first turn that contains `needle`, else of the first caller turn, else 0. */
function turnOf(turns: readonly Turn[], needle: string | null | undefined): number {
  const text = needle?.trim();
  if (text) {
    const hit = turns.findIndex((t) => t.text.includes(text.slice(0, 60)));
    if (hit >= 0) return hit;
  }
  const caller = turns.findIndex((t) => t.role === 'caller');
  return caller >= 0 ? caller : 0;
}

const clip = (v: string, n = 160) => (v.length > n ? v.slice(0, n) : v);

export function createScoringScorer(options: ScoringScorerOptions): Scorer {
  const now = options.now ?? (() => new Date());

  return async (input): Promise<SentinelScoreResult> => {
    const turns = input.turns;
    // Only the caller's words are scored: what the agent says is not evidence about the caller.
    const transcript = turns
      .filter((t) => t.role === 'caller')
      .map((t) => t.text)
      .join('\n');

    const base = options.metadataFor?.(input.conversationId) ?? DEFAULT_METADATA;
    const known = input.counterpartyId
      ? (options.counterparties.find((c) => c.id === input.counterpartyId) ?? null)
      : null;
    const metadata: CallMetadata = {
      ...base,
      ...(known && !base.claimedOrganization ? { claimedOrganization: known.name } : {})
    };

    const script = scoreScript(transcript, metadata, now());
    const factcheck = options.factCheckFor?.(input.conversationId) ?? null;
    const history = (await options.historyFor?.(input.conversationId)) ?? null;
    const findings = factcheck?.state === 'completed' ? factcheck.findings : null;
    const checkRunning = factcheck?.state === 'running';

    // Signals: his reasons that are social-engineering flags, then the two we add.
    const byId = new Map<SignalId, Signal>();
    const keep = (signal: Signal) => {
      const old = byId.get(signal.id);
      if (!old || signal.weight > old.weight) byId.set(signal.id, signal);
    };
    for (const reason of script.reasons) {
      const id = SIGNAL_FOR_CODE[reason.code];
      if (!id || !reason.evidence) continue;
      keep({
        id,
        weight: Math.round(reason.weight * 100),
        quote: clip(reason.evidence),
        turn: turnOf(turns, reason.evidence)
      });
    }
    const extraWeights: number[] = [];
    for (const rule of SUPPLEMENT) {
      for (const turnIndex of turns.keys()) {
        const turn = turns[turnIndex]!;
        if (turn.role !== 'caller') continue;
        const match = rule.patterns.map((p) => p.exec(turn.text)).find(Boolean);
        if (!match) continue;
        keep({ id: rule.id, weight: Math.round(rule.weight * 100), quote: clip(match[0]), turn: turnIndex });
        extraWeights.push(rule.weight);
        break;
      }
    }

    // Counterparty: whom the caller says they are, and whether that record is on file.
    const matched =
      matchCounterparty(script.claims.organization, input.counterpartyId, options.counterparties) ??
      namedOnFile(transcript, options.counterparties);
    const claimedName = script.claims.organization ?? matched?.name ?? null;

    // Claims: the checkable statements, judged against the fact-check and the record on file.
    const claims: Claim[] = [];
    if (claimedName) {
      claims.push({
        id: 'c-org',
        kind: 'organization',
        value: claimedName,
        status: findings
          ? findings.companyFound === true
            ? 'confirmed'
            : findings.companyFound === false
              ? 'contradicted'
              : 'unchecked'
          : checkRunning
            ? 'pending'
            : 'unchecked',
        sources: findings?.sources ?? [],
        turn: turnOf(turns, claimedName)
      });
    }
    if (script.claims.iban) {
      const iban = script.claims.iban;
      const onFile = matched?.bankAccounts.some((a) => a.iban === iban) ?? false;
      claims.push({
        id: 'c-iban',
        kind: 'bank_account',
        value: iban,
        touches: 'iban',
        // An account already on file is not a change; a new one is only as good as the web check.
        status: onFile
          ? 'confirmed'
          : findings
            ? findings.ibanListed === true
              ? 'confirmed'
              : findings.ibanListed === false
                ? 'contradicted'
                : 'unchecked'
            : checkRunning
              ? 'pending'
              : 'unchecked',
        sources: findings?.sources ?? [],
        turn: turnOf(turns, iban)
      });
    }
    if (script.claims.phone) {
      const phone = script.claims.phone;
      const official = matched ? digits(matched.officialPhone) === digits(phone) : false;
      claims.push({
        id: 'c-phone',
        kind: 'phone',
        value: phone,
        touches: 'phone',
        status: official ? 'confirmed' : 'unchecked',
        sources: [],
        turn: turnOf(turns, phone)
      });
    }
    let domainContradicted = false;
    if (script.claims.domain) {
      const domain = script.claims.domain;
      // The record on file is the authority for a domain, unlike a bank account, which a real supplier may change.
      const status = matched
        ? host(domain) === host(matched.officialDomain)
          ? 'confirmed'
          : 'contradicted'
        : 'unchecked';
      domainContradicted = status === 'contradicted';
      claims.push({
        id: 'c-domain',
        kind: 'domain',
        value: domain,
        status,
        sources: [],
        turn: turnOf(turns, domain)
      });
    }

    const weights = [
      ...script.reasons.map((r) => r.weight),
      ...extraWeights,
      ...(factcheck?.reasons.map((r) => r.weight) ?? []),
      ...(history?.reasons.map((r) => r.weight) ?? [])
    ];

    return {
      conversationId: input.conversationId,
      risk: combineWeights(weights),
      signals: [...byId.values()].sort((a, b) => b.weight - a.weight),
      claims,
      counterparty: {
        claimedName,
        matchedId: matched?.id ?? null,
        contradicted: matched !== null && (domainContradicted || findings?.companyFound === false)
      },
      patternsMatched: script.reasons.filter((r) => r.code.startsWith('pattern_')).map((r) => r.code),
      llmUsed: false,
      scoredTurns: turns.length
    };
  };
}
