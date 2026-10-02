/**
 * Scenarios where Gilles's real scorer ends in a different SAFE decision than
 * the scenario file expects, or misses a signal. None lets an attack through.
 * The expectations were written for an ideal scorer; each entry needs a
 * decision from the team, not a patch. Shared by the adapter test and the
 * replay/eval, so the dashboard shows the same five rows the tests list.
 */
export const KNOWN_GAPS: Readonly<Record<string, string>> = {
  'a1-iban-change-urgent':
    'Risk is above the tier-3 limit, so it escalates before the contradicted IBAN can deny (spec Flow B says deny, then escalate).',
  'a2-ceo-secrecy': 'The scorer misses the urgency in this wording.',
  'a3-false-multichannel-proof': 'Risk is high, so it escalates instead of asking for a callback.',
  'a4-voice-prompt-injection':
    'The injection adds too little risk to escalate; it still stops at verify_first.',
  'h1-nl-helpdesk-contact-change': 'Dutch: the scoring rules cover English and French only.'
};
