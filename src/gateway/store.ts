import type { Grant, Turn, VerificationKind, VerificationResult } from '../contract.js';

export interface ConversationRecord {
  id: string;
  turns: Turn[];
  verifications: VerificationResult[];
  /** The counterparty last matched in this conversation, passed back to the scorer as a hint. */
  counterpartyId: string | null;
}

/** A grant plus what the gateway knew when it issued it (the contract's Grant stays the wire shape). */
export interface GrantRecord extends Grant {
  counterpartyId: string | null;
  /** How the counterparty was verified in this conversation, when it was. */
  verifiedBy: VerificationKind | null;
}

/**
 * One row per decision. Holds no transcript, no parameter values and no score
 * breakdown: the parameters appear only as their hash.
 */
export interface AuditRow {
  id: string;
  conversationId: string;
  action: string;
  decision: string;
  rule: string;
  trust: string;
  risk: number;
  tier: number;
  policyVersion: string;
  paramsHash: string;
  at: string;
}

/** What the gateway needs from storage. `MemoryStore` today, a Postgres store later. */
export interface GatewayStore {
  ensureConversation(id: string): Promise<ConversationRecord>;
  appendTurn(id: string, turn: Turn): Promise<void>;
  addVerification(id: string, result: VerificationResult): Promise<void>;
  setCounterparty(id: string, counterpartyId: string | null): Promise<void>;
  saveGrant(grant: GrantRecord): Promise<void>;
  getGrant(id: string): Promise<GrantRecord | null>;
  /** Atomic: true only for the one caller that found the grant unused. */
  markGrantUsed(id: string, at: string): Promise<boolean>;
  appendAudit(row: AuditRow): Promise<void>;
  listAudit(conversationId?: string): Promise<AuditRow[]>;
}

export class MemoryStore implements GatewayStore {
  protected readonly conversations = new Map<string, ConversationRecord>();
  protected readonly grants = new Map<string, GrantRecord>();
  protected readonly audit: AuditRow[] = [];

  async ensureConversation(id: string): Promise<ConversationRecord> {
    let record = this.conversations.get(id);
    if (!record) {
      record = { id, turns: [], verifications: [], counterpartyId: null };
      this.conversations.set(id, record);
    }
    return record;
  }

  async appendTurn(id: string, turn: Turn): Promise<void> {
    (await this.ensureConversation(id)).turns.push(turn);
  }

  async addVerification(id: string, result: VerificationResult): Promise<void> {
    (await this.ensureConversation(id)).verifications.push(result);
  }

  async setCounterparty(id: string, counterpartyId: string | null): Promise<void> {
    (await this.ensureConversation(id)).counterpartyId = counterpartyId;
  }

  async saveGrant(grant: GrantRecord): Promise<void> {
    this.grants.set(grant.id, { ...grant });
  }

  async getGrant(id: string): Promise<GrantRecord | null> {
    const grant = this.grants.get(id);
    return grant ? { ...grant } : null;
  }

  async markGrantUsed(id: string, at: string): Promise<boolean> {
    const grant = this.grants.get(id);
    if (!grant || grant.usedAt !== null) return false;
    grant.usedAt = at;
    return true;
  }

  async appendAudit(row: AuditRow): Promise<void> {
    this.audit.push({ ...row });
  }

  async listAudit(conversationId?: string): Promise<AuditRow[]> {
    return this.audit.filter((r) => conversationId === undefined || r.conversationId === conversationId);
  }
}
