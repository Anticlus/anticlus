import { counterpartySchema, type Counterparty } from './contract.js';

/**
 * The demo company's suppliers. Fictional: the names, enterprise numbers and
 * phone numbers are invented, the domains are reserved `.example` names and the
 * IBANs are the published example numbers of the standard.
 */
export const SEED_COUNTERPARTIES: readonly Counterparty[] = [
  {
    id: 'acme',
    name: 'Acme Industrial NV',
    registryNumber: '0999.000.001',
    officialPhone: '+3225550101',
    officialDomain: 'acme-industrial.example',
    bankAccounts: [{ iban: 'BE68539007547034', verifiedBy: 'onboarding' }],
    contactPerson: 'Sophie Maes'
  },
  {
    id: 'delta',
    name: 'Delta Logistics BV',
    registryNumber: '0999.000.002',
    officialPhone: '+3225550102',
    officialDomain: 'delta-logistics.example',
    bankAccounts: [{ iban: 'BE62510007547061', verifiedBy: 'onboarding' }],
    contactPerson: 'Pieter Janssens'
  },
  {
    id: 'bruxfresh',
    name: 'Brussels Fresh Foods SRL',
    aliases: ['Bruxelles Fresh Foods'],
    registryNumber: '0999.000.003',
    officialPhone: '+3225550103',
    officialDomain: 'bruxfresh.example',
    bankAccounts: [{ iban: 'BE71096123456769', verifiedBy: 'onboarding' }],
    contactPerson: 'Amina Benali'
  }
].map((c) => counterpartySchema.parse(c));

/** IBANs that appear in attack scenarios: valid in form, on nobody's record. */
export const ATTACKER_IBANS = ['NL91ABNA0417164300', 'DE89370400440532013000'] as const;
