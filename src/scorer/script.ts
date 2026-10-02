import {
  combineWeights,
  levelOf,
  type CallMetadata,
  type ExtractedClaims,
  type IntendedAction,
  type IntendedActionKey,
  type ScoreReason,
  type ScriptScore
} from '../contract.js';

/**
 * The script tool: what is said, and the call's metadata, scored 0–100.
 *
 * Fixed rules, English and French (the Belgian case), one weight per family
 * of social-engineering pressure. Rules first is deliberate: they are
 * instant, free, explainable and run on every sample; an LLM pass can be
 * added on top for the hard cases without changing the shape. Each family
 * counts once, however often it is heard, so repetition does not inflate the
 * score; the evidence is the first sentence that matched.
 */

interface Rule {
  code: string;
  label: string;
  weight: number;
  patterns: RegExp[];
}

const RULES: readonly Rule[] = [
  {
    code: 'payment_details_change',
    label: 'Asks to change bank or payment details',
    weight: 0.45,
    patterns: [
      /\bnew (bank )?(account|iban|bank details)\b/i,
      /\b(changed|switched|moved) (our |my )?(bank|banks|account)\b/i,
      /\bupdate (the |our )?(bank|payment|iban)/i,
      /\bnouve(au|l) (compte|iban|rib)\b/i,
      /\bchang[ée] de (banque|compte)\b/i,
      /\bcoordonn[ée]es bancaires\b/i
    ]
  },
  {
    code: 'urgency',
    label: 'Creates urgency or a deadline',
    weight: 0.25,
    patterns: [
      /\b(urgent|urgently|immediately|right now|as soon as possible|asap|today|tonight|before (the )?end of (the )?day)\b/i,
      /\b(otherwise|or else) .{0,40}(blocked|suspended|cancel|penalt|late)/i,
      /\b(urgent|imm[ée]diatement|tout de suite|aujourd'hui|ce soir|au plus vite|sinon)\b/i
    ]
  },
  {
    code: 'authority',
    label: 'Claims authority or a senior role',
    weight: 0.2,
    patterns: [
      /\b(ceo|cfo|director|managing director|head of finance|fraud (department|team)|security (department|team)|police|tax (office|authority))\b/i,
      /\b(directeur|directrice|service (de )?fraude|police|spf finances|administrateur d[ée]l[ée]gu[ée])\b/i
    ]
  },
  {
    code: 'secrecy',
    label: 'Asks for secrecy or to keep it between us',
    weight: 0.3,
    patterns: [
      /\b(confidential|keep (this|it) between us|don'?t tell|do not tell|no need to (tell|inform|involve))\b/i,
      /\b(confidentiel|entre nous|n'en parlez|ne dites rien)\b/i
    ]
  },
  {
    code: 'verification_bypass',
    label: 'Discourages verification or a callback',
    weight: 0.4,
    patterns: [
      /\b(no need to (call|check|verify|confirm)|don'?t call|do not call|already (been )?verified|skip the (check|verification))\b/i,
      /\b(stay on the line|don'?t hang up|do not hang up)\b/i,
      /\b(pas besoin de (rappeler|v[ée]rifier)|ne raccrochez pas|d[ée]j[àa] v[ée]rifi[ée])\b/i
    ]
  },
  {
    code: 'channel_switch',
    label: 'Moves the request to another channel',
    weight: 0.15,
    patterns: [
      /\b(i'?ll|i will|we'?ll) (send|email|text|whatsapp) (you )?(the|it|a)\b/i,
      /\b(new|different|personal) (email|phone number|number)\b/i,
      /\b(je vous envoie|par whatsapp|nouvelle adresse (e-?mail|mail))\b/i
    ]
  },
  {
    code: 'credentials_request',
    label: 'Asks for a code, password or remote access',
    weight: 0.5,
    patterns: [
      /\b(one[- ]time (code|password)|verification code|otp|pin code|password|login|anydesk|teamviewer|remote access)\b/i,
      /\b(code (de|re[çc]u)|mot de passe|digipass|lecteur de carte|itsme)\b/i
    ]
  },
  {
    code: 'unusual_payment',
    label: 'Unusual payment method',
    weight: 0.45,
    patterns: [/\b(gift ?cards?|crypto|bitcoin|western union|moneygram|cartes? cadeaux?)\b/i]
  },
  {
    code: 'instruction_injection',
    label: 'Tries to give the agent instructions',
    weight: 0.6,
    patterns: [
      /\bignore (all |your )?(previous|prior) instructions\b/i,
      /\b(system (message|notice|prompt)|you are now|maintenance mode|developer mode|act as)\b/i,
      /\bignore[zr]? (les|tes|vos) instructions\b/i
    ]
  }
];

const ACTIONS: ReadonlyArray<{ action: IntendedActionKey; label: string; patterns: RegExp[] }> = [
  {
    action: 'update_supplier_iban',
    label: 'Change the supplier’s bank account',
    patterns: RULES[0]!.patterns
  },
  {
    action: 'release_payment',
    label: 'Release or speed up a payment',
    patterns: [
      /\b(pay|settle|transfer|wire) (the |this |our )?(invoice|amount|payment|balance)\b/i,
      /\b(release|process|send) (the )?(payment|transfer)\b/i,
      /\b(transfer|wire|pay)\b.{0,40}\b(account|iban)\b/i,
      /\b(payer|r[ée]gler|virer) (la |cette )?(facture|somme|montant)\b/i,
      /\bvirement\b/i
    ]
  },
  {
    action: 'share_invoice',
    label: 'Share invoice or account information',
    patterns: [
      /\b(send|share|read|confirm) (me )?(the |a )?(copy of (the )?)?(invoice|statement|amount due|account (number|details))\b/i,
      /\b(envoyer|confirmer) (la |une )?(facture|copie|montant)\b/i
    ]
  },
  {
    action: 'update_contact_details',
    label: 'Change contact details on file',
    patterns: [
      /\b(change|update) (the |our )?(email|e-mail|contact|address|phone number)\b/i,
      /\b(changer|modifier) (l'|la |le )?(adresse|e-?mail|contact|num[ée]ro)\b/i
    ]
  },
  {
    action: 'reset_access',
    label: 'Reset an access or a password',
    patterns: [
      /\b(reset|unlock|recover) (the |my |our )?(password|account|access)\b/i,
      /\b(r[ée]initialiser|d[ée]bloquer) (le |mon |notre )?(mot de passe|compte|acc[èe]s)\b/i
    ]
  }
];

/** An IBAN as said or typed: two letters, two digits, then 10 to 30 letters or digits, spaces allowed. */
const IBAN = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?)\b/i;
const PHONE = /(\+\d{2}[\d .\-/]{7,14}\d|\b0\d{2,3}[ .\-/]?\d{2}[ .\-/]?\d{2}[ .\-/]?\d{2,3}\b)/;
const DOMAIN = /\b([a-z0-9-]+\.(?:be|com|eu|net|org|io|fr|nl|help|info|biz|online|site))\b/i;
const ORG_STOP = '(?=[,.!?]| and | about | accounts?\\b| department\\b| finance\\b| billing\\b| vat\\b| recovery\\b| in [a-z]+\\b| i am | i\'m |$)';
const ORG_PATTERNS = [
  new RegExp(`\\b(?:calling from|from the|this is \\w+(?: \\w+)? (?:calling )?from|i'?m \\w+ from|i am \\w+ from|on behalf of|i work (?:for|at))\\s+([a-z][\\w&\\-]*(?: [a-z][\\w&\\-]*){0,3}?)${ORG_STOP}`, 'i'),
  /\b(?:de la part de|je suis \w+ de|j'appelle de la soci[ée]t[ée]|de chez)\s+([a-z][\w&\- ]{1,40}?)(?=[,.!?]| et |$)/i
];

/** Title Case for a name heard in lowercase ("acme supplies" → "Acme Supplies"). */
const titleCase = (v: string) => v.replace(/\b\w/g, (c) => c.toUpperCase());

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90'
};

/**
 * An IBAN read aloud, as speech to text writes it: "the new IBAN is g b two nine N. W. B. K. 6016…".
 * After the word IBAN, the single letters, digit groups and number words are joined until a word
 * that is none of them; the result counts when it has the shape of an IBAN.
 */
function spokenIban(transcript: string): string | null {
  const m = /\b(?:iban|account number|num[ée]ro de compte)\b(?: is| est|:)?\s+(.{10,160})/i.exec(transcript);
  if (!m) return null;
  let out = '';
  for (const raw of m[1]!.split(/[\s,]+/)) {
    const token = raw.replace(/[.\-]/g, '').toLowerCase();
    if (!token) continue;
    if (NUMBER_WORDS[token] !== undefined) out += NUMBER_WORDS[token];
    else if (/^[a-z]$/.test(token) || /^\d+$/.test(token)) out += token;
    else if (/^[a-z]{2}\d{2}[a-z0-9]*$/.test(token) && out === '') out += token;
    else if (out.length >= 4) break;
    else out = '';
  }
  const iban = out.toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban) ? iban : null;
}

/** The sentence around a match, trimmed, for the evidence. */
function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1, text.lastIndexOf('?', index) + 1, text.lastIndexOf('!', index) + 1);
  const ends = ['.', '?', '!'].map((c) => text.indexOf(c, index + length)).filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  const sentence = text.slice(start, end).trim();
  return sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence;
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return sentenceAround(text, m.index, m[0].length);
  }
  return null;
}

function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export function extractClaims(transcript: string, metadata: CallMetadata): ExtractedClaims {
  const written = IBAN.exec(transcript);
  const iban = written && /\d{6,}/.test(written[1]!.replace(/\s/g, '')) ? normalizeIban(written[1]!) : spokenIban(transcript);
  const phone = PHONE.exec(transcript);
  const domain = DOMAIN.exec(transcript);
  let organization = metadata.claimedOrganization?.trim() || null;
  if (!organization) {
    for (const pattern of ORG_PATTERNS) {
      const m = pattern.exec(transcript);
      if (m?.[1]) {
        organization = titleCase(m[1].trim().replace(/^the\s+/i, '')).replace(/\b(Spf|Fod|Vat|Kbo|Bce)\b/g, (w) => w.toUpperCase());
        break;
      }
    }
  }
  return {
    organization,
    iban,
    phone: phone ? phone[1]!.trim() : null,
    domain: domain ? domain[1]!.toLowerCase() : null
  };
}

function metadataReasons(metadata: CallMetadata, claims: ExtractedClaims): ScoreReason[] {
  const reasons: ScoreReason[] = [];
  const caller = metadata.callerAddress.trim();
  const isPhone = metadata.channel === 'phone' || metadata.channel === 'whatsapp';
  if (/^(anonymous|unknown|private|withheld|masqu[ée])$/i.test(caller)) {
    reasons.push({ code: 'hidden_caller', label: 'The caller’s number is hidden', weight: 0.2, evidence: caller });
  } else if (isPhone && caller.startsWith('+') && !caller.startsWith('+32') && claims.organization) {
    reasons.push({
      code: 'foreign_number',
      label: 'Calls from a foreign number while claiming an organization',
      weight: 0.1,
      evidence: caller
    });
  }
  if (claims.iban && !claims.iban.startsWith('BE')) {
    reasons.push({
      code: 'foreign_iban',
      label: 'The new bank account is not Belgian',
      weight: 0.2,
      evidence: claims.iban
    });
  }
  if (claims.phone && caller && claims.phone.replace(/\D/g, '') !== caller.replace(/\D/g, '')) {
    reasons.push({
      code: 'callback_number_given',
      label: 'Gives a callback number different from the calling one',
      weight: 0.15,
      evidence: claims.phone
    });
  }
  return reasons;
}

export function intendedActions(transcript: string, claims: ExtractedClaims): IntendedAction[] {
  const found: IntendedAction[] = [];
  for (const def of ACTIONS) {
    const evidence = firstMatch(transcript, def.patterns);
    if (!evidence) continue;
    const params: Record<string, string> = {};
    if (claims.organization) params.organization = claims.organization;
    if (def.action === 'update_supplier_iban' && claims.iban) params.iban = claims.iban;
    if (def.action === 'update_contact_details' && claims.phone) params.phone = claims.phone;
    found.push({ action: def.action, label: def.label, params, evidence });
  }
  return found;
}

export function scoreScript(transcript: string, metadata: CallMetadata, now = new Date()): ScriptScore {
  const claims = extractClaims(transcript, metadata);
  const reasons: ScoreReason[] = [];
  for (const rule of RULES) {
    const evidence = firstMatch(transcript, rule.patterns);
    if (evidence) reasons.push({ code: rule.code, label: rule.label, weight: rule.weight, evidence });
  }
  reasons.push(...metadataReasons(metadata, claims));
  // A new bank account AND pressure together is the textbook fraud: one more weight for the combination.
  const codes = new Set(reasons.map((r) => r.code));
  if (codes.has('payment_details_change') && (codes.has('urgency') || codes.has('verification_bypass') || codes.has('secrecy'))) {
    reasons.push({
      code: 'pattern_bank_change_under_pressure',
      label: 'Known pattern: a bank change under pressure',
      weight: 0.35,
      evidence: null
    });
  }
  reasons.sort((a, b) => b.weight - a.weight);
  const score = combineWeights(reasons.map((r) => r.weight));
  return {
    tool: 'script',
    score,
    level: levelOf(score),
    reasons,
    computedAt: now.toISOString(),
    claims,
    intendedActions: intendedActions(transcript, claims)
  };
}
