import type { Counterparty, VerificationKind } from '../contract.js';
import type { Gateway, GrantRefusal } from './gateway.js';

/**
 * The fake back office the gateway protects. Every tool refuses to run without
 * a grant the gateway issued for exactly this conversation, action and
 * parameters, so the gateway is the only way in. What a call changes is scoped
 * to the counterparty the conversation was matched to: an Acme caller can
 * never touch Delta's record, whatever the parameters say.
 */

export type ErpRefusal =
  'no_grant' | GrantRefusal | 'no_counterparty' | 'no_verification' | 'bad_params' | 'not_found';

export type ErpResult<T> = { ok: true; data: T } | { ok: false; reason: ErpRefusal };

export interface ErpCall {
  grantId: string | null | undefined;
  conversationId: string;
  params: Record<string, string>;
}

export interface ErpExecution {
  action: string;
  conversationId: string;
  counterpartyId: string | null;
  params: Record<string, string>;
}

export interface Invoice {
  id: string;
  counterpartyId: string;
  status: 'paid' | 'due';
  amountDue: string;
}

export const SEED_INVOICES: readonly Invoice[] = [
  { id: 'INV-1001', counterpartyId: 'acme', status: 'paid', amountDue: '0.00' },
  { id: 'INV-1002', counterpartyId: 'acme', status: 'due', amountDue: '1250.00' },
  { id: 'INV-2001', counterpartyId: 'delta', status: 'due', amountDue: '830.50' },
  { id: 'INV-3001', counterpartyId: 'bruxfresh', status: 'due', amountDue: '410.00' }
];

export const OPENING_HOURS = 'Monday to Friday, 08:30 to 17:00.';

const normaliseIban = (iban: string): string => iban.replace(/\s+/g, '').toUpperCase();

export interface Erp {
  getOpeningHours(call: ErpCall): Promise<ErpResult<{ hours: string }>>;
  getInvoiceStatus(call: ErpCall): Promise<ErpResult<{ invoice: string; status: string; amountDue: string }>>;
  updateContactPerson(call: ErpCall): Promise<ErpResult<{ contactPerson: string }>>;
  updateSupplierIban(call: ErpCall): Promise<ErpResult<{ iban: string; verifiedBy: string }>>;
  /** A copy of a supplier's master record. */
  supplier(id: string): Counterparty | null;
  /** Everything the back office actually executed, in order. */
  executed(): readonly ErpExecution[];
}

export function createErp(options: {
  counterparties: readonly Counterparty[];
  gateway: Pick<Gateway, 'consumeGrant'>;
  invoices?: readonly Invoice[];
}): Erp {
  const master = new Map(
    options.counterparties.map((c) => [
      c.id,
      { ...c, bankAccounts: c.bankAccounts.map((a) => ({ ...a })) } satisfies Counterparty
    ])
  );
  const invoices = new Map((options.invoices ?? SEED_INVOICES).map((i) => [i.id, i]));
  const log: ErpExecution[] = [];

  async function run<T>(
    action: string,
    call: ErpCall,
    body: (ctx: { counterpartyId: string | null; verifiedBy: VerificationKind | null }) => ErpResult<T>
  ): Promise<ErpResult<T>> {
    if (!call.grantId) return { ok: false, reason: 'no_grant' };
    const consumed = await options.gateway.consumeGrant(
      call.grantId,
      call.conversationId,
      action,
      call.params
    );
    if (!consumed.ok) return { ok: false, reason: consumed.reason };
    const result = body({ counterpartyId: consumed.counterpartyId, verifiedBy: consumed.verifiedBy });
    if (result.ok) {
      log.push({
        action,
        conversationId: call.conversationId,
        counterpartyId: consumed.counterpartyId,
        params: { ...call.params }
      });
    }
    return result;
  }

  return {
    getOpeningHours: (call) =>
      run('get_opening_hours', call, () => ({ ok: true, data: { hours: OPENING_HOURS } })),

    getInvoiceStatus: (call) =>
      run('get_invoice_status', call, ({ counterpartyId }) => {
        const invoice = invoices.get(call.params.invoice ?? '');
        if (!counterpartyId) return { ok: false, reason: 'no_counterparty' };
        if (!invoice || invoice.counterpartyId !== counterpartyId) return { ok: false, reason: 'not_found' };
        return {
          ok: true,
          data: { invoice: invoice.id, status: invoice.status, amountDue: invoice.amountDue }
        };
      }),

    updateContactPerson: (call) =>
      run('update_contact_person', call, ({ counterpartyId }) => {
        const supplier = counterpartyId ? master.get(counterpartyId) : undefined;
        if (!supplier) return { ok: false, reason: 'no_counterparty' };
        const name = call.params.name?.trim();
        if (!name) return { ok: false, reason: 'bad_params' };
        supplier.contactPerson = name;
        return { ok: true, data: { contactPerson: name } };
      }),

    updateSupplierIban: (call) =>
      run('update_supplier_iban', call, ({ counterpartyId, verifiedBy }) => {
        const supplier = counterpartyId ? master.get(counterpartyId) : undefined;
        if (!supplier) return { ok: false, reason: 'no_counterparty' };
        const iban = normaliseIban(call.params.iban ?? '');
        if (!iban) return { ok: false, reason: 'bad_params' };
        if (!verifiedBy) return { ok: false, reason: 'no_verification' };
        if (!supplier.bankAccounts.some((a) => a.iban === iban))
          supplier.bankAccounts.push({ iban, verifiedBy });
        return { ok: true, data: { iban, verifiedBy } };
      }),

    supplier(id) {
      const found = master.get(id);
      return found ? { ...found, bankAccounts: found.bankAccounts.map((a) => ({ ...a })) } : null;
    },

    executed: () => log.map((e) => ({ ...e, params: { ...e.params } }))
  };
}
