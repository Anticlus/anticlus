import type { FactCheck } from '../contract.js';
import { factCheckOf } from '../scorer/factcheck.js';

/**
 * The web check is an H run, so it is the one input recorded for the scripted
 * scenarios: the findings an H run returns, scored by Gilles's own
 * `factCheckOf`. Everything else in a replay is computed for real.
 */
export function recorded(findings: Record<string, unknown>): FactCheck {
  return factCheckOf({
    id: 'recorded',
    state: 'completed',
    liveUrl: null,
    error: null,
    answer: JSON.stringify(findings)
  });
}

const ATTACKER_IBAN_NOT_LISTED = recorded({
  companyFound: true,
  officialWebsite: 'https://acme-industrial.example',
  officialPhones: ['+3225550101'],
  callerPhoneListed: false,
  ibanListed: false,
  domainOfficial: null,
  sources: ['https://acme-industrial.example/legal']
});

/** Keyed by scenario id, which is the conversation id of a replay. */
export const RECORDED_FACTCHECKS: Readonly<Record<string, FactCheck>> = {
  'a1-iban-change-urgent': ATTACKER_IBAN_NOT_LISTED,
  'a3-false-multichannel-proof': ATTACKER_IBAN_NOT_LISTED,
  'a5-memory-poisoning': ATTACKER_IBAN_NOT_LISTED,
  'l3-iban-change-verified-callback': recorded({
    companyFound: true,
    officialWebsite: 'https://acme-industrial.example',
    officialPhones: ['+3225550101'],
    callerPhoneListed: true,
    ibanListed: true,
    domainOfficial: true,
    sources: ['https://acme-industrial.example/legal']
  })
};
