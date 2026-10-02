import Database from 'better-sqlite3';
import type { Turn, VerificationResult } from './contract.js';
import type { AuditRow, ConversationRecord, GrantRecord } from './gateway/store.js';
import type { Challenge, LiveStore } from './mfa.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, counterparty_id TEXT);
CREATE TABLE IF NOT EXISTS turns (
  conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_conversation ON verifications (conversation_id);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, action TEXT NOT NULL, params_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT, counterparty_id TEXT, verified_by TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, action TEXT NOT NULL, decision TEXT NOT NULL,
  rule TEXT NOT NULL, trust TEXT NOT NULL, risk REAL NOT NULL, tier INTEGER NOT NULL,
  policy_version TEXT NOT NULL, params_hash TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_conversation ON audit (conversation_id, at);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, counterparty_id TEXT NOT NULL, action TEXT NOT NULL,
  params_hash TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, completed_at TEXT, passed INTEGER
);
CREATE INDEX IF NOT EXISTS challenges_open ON challenges (conversation_id, action, params_hash);
`;

interface GrantRow {
  id: string;
  conversation_id: string;
  action: string;
  params_hash: string;
  expires_at: string;
  used_at: string | null;
  counterparty_id: string | null;
  verified_by: string | null;
}

interface ChallengeRow {
  id: string;
  conversation_id: string;
  counterparty_id: string;
  action: string;
  params_hash: string;
  kind: string;
  target: string;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  passed: number | null;
}

const toChallenge = (r: ChallengeRow): Challenge => ({
  id: r.id,
  conversationId: r.conversation_id,
  counterpartyId: r.counterparty_id,
  action: r.action,
  paramsHash: r.params_hash,
  kind: r.kind as Challenge['kind'],
  target: r.target,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  completedAt: r.completed_at,
  passed: r.passed === null ? null : r.passed === 1
});

/**
 * The gateway's store on one SQLite file: open grants, pending challenges and
 * the audit trail survive a restart. Turns are held only until the
 * conversation is deleted; the audit rows carry no transcript and no
 * parameter values.
 */
export class SqliteStore implements LiveStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async ensureConversation(id: string): Promise<ConversationRecord> {
    this.db.prepare('INSERT OR IGNORE INTO conversations (id) VALUES (?)').run(id);
    const row = this.db.prepare('SELECT counterparty_id FROM conversations WHERE id = ?').get(id) as {
      counterparty_id: string | null;
    };
    const turns = this.db
      .prepare('SELECT body FROM turns WHERE conversation_id = ? ORDER BY seq')
      .all(id) as Array<{ body: string }>;
    const verifications = this.db
      .prepare('SELECT body FROM verifications WHERE conversation_id = ? ORDER BY id')
      .all(id) as Array<{ body: string }>;
    return {
      id,
      turns: turns.map((t) => JSON.parse(t.body) as Turn),
      verifications: verifications.map((v) => JSON.parse(v.body) as VerificationResult),
      counterpartyId: row.counterparty_id
    };
  }

  async appendTurn(id: string, turn: Turn): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO conversations (id) VALUES (?)').run(id);
    this.db
      .prepare(
        'INSERT INTO turns (conversation_id, seq, body) VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM turns WHERE conversation_id = ?), ?)'
      )
      .run(id, id, JSON.stringify(turn));
  }

  async addVerification(id: string, result: VerificationResult): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO conversations (id) VALUES (?)').run(id);
    this.db.prepare('INSERT INTO verifications (conversation_id, body) VALUES (?, ?)').run(id, JSON.stringify(result));
  }

  async setCounterparty(id: string, counterpartyId: string | null): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO conversations (id) VALUES (?)').run(id);
    this.db.prepare('UPDATE conversations SET counterparty_id = ? WHERE id = ?').run(counterpartyId, id);
  }

  async saveGrant(grant: GrantRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO grants (id, conversation_id, action, params_hash, expires_at, used_at, counterparty_id, verified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        grant.id,
        grant.conversationId,
        grant.action,
        grant.paramsHash,
        grant.expiresAt,
        grant.usedAt,
        grant.counterpartyId,
        grant.verifiedBy
      );
  }

  async getGrant(id: string): Promise<GrantRecord | null> {
    const r = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!r) return null;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      action: r.action,
      paramsHash: r.params_hash,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      counterpartyId: r.counterparty_id,
      verifiedBy: r.verified_by as GrantRecord['verifiedBy']
    };
  }

  async markGrantUsed(id: string, at: string): Promise<boolean> {
    return this.db.prepare('UPDATE grants SET used_at = ? WHERE id = ? AND used_at IS NULL').run(at, id).changes === 1;
  }

  async appendAudit(row: AuditRow): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO audit (id, conversation_id, action, decision, rule, trust, risk, tier, policy_version, params_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        row.id,
        row.conversationId,
        row.action,
        row.decision,
        row.rule,
        row.trust,
        row.risk,
        row.tier,
        row.policyVersion,
        row.paramsHash,
        row.at
      );
  }

  async listAudit(conversationId?: string): Promise<AuditRow[]> {
    const select =
      'SELECT id, conversation_id AS conversationId, action, decision, rule, trust, risk, tier, policy_version AS policyVersion, params_hash AS paramsHash, at FROM audit';
    const rows =
      conversationId === undefined
        ? this.db.prepare(`${select} ORDER BY at, rowid`).all()
        : this.db.prepare(`${select} WHERE conversation_id = ? ORDER BY at, rowid`).all(conversationId);
    return rows as AuditRow[];
  }

  async saveChallenge(c: Challenge): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO challenges (id, conversation_id, counterparty_id, action, params_hash, kind, target, created_at, expires_at, completed_at, passed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        c.id,
        c.conversationId,
        c.counterpartyId,
        c.action,
        c.paramsHash,
        c.kind,
        c.target,
        c.createdAt,
        c.expiresAt,
        c.completedAt,
        c.passed === null ? null : c.passed ? 1 : 0
      );
  }

  async getChallenge(id: string): Promise<Challenge | null> {
    const r = this.db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) as ChallengeRow | undefined;
    return r ? toChallenge(r) : null;
  }

  async findOpenChallenge(conversationId: string, action: string, paramsHash: string, now: string) {
    const r = this.db
      .prepare(
        'SELECT * FROM challenges WHERE conversation_id = ? AND action = ? AND params_hash = ? AND completed_at IS NULL AND expires_at > ? LIMIT 1'
      )
      .get(conversationId, action, paramsHash, now) as ChallengeRow | undefined;
    return r ? toChallenge(r) : null;
  }

  async completeChallenge(id: string, passed: boolean, at: string): Promise<boolean> {
    return (
      this.db
        .prepare('UPDATE challenges SET completed_at = ?, passed = ? WHERE id = ? AND completed_at IS NULL')
        .run(at, passed ? 1 : 0, id).changes === 1
    );
  }

  async deleteConversation(id: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM turns WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM verifications WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM challenges WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM grants WHERE conversation_id = ? AND used_at IS NULL').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    })();
  }
}
