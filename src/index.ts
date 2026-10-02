/** The public surface of the package: what a scorer, a client or an embedding host imports. */
export * from './contract.js';
export { createGateway, GRANT_TTL_MS, SCORER_TIMEOUT_MS, type Gateway, type GatewayOptions } from './gateway/gateway.js';
export { decide, RULES } from './gateway/decide.js';
export { canonicalJson, hashParams } from './gateway/hash.js';
export { MemoryStore, type AuditRow, type ConversationRecord, type GatewayStore, type GrantRecord } from './gateway/store.js';
export { computeTrust, indexCounterparties, matchedCounterparty } from './gateway/trust.js';
export { createScoringScorer, type ScoringScorerOptions } from './scorer/adapter.js';
export { scoreScript } from './scorer/script.js';
export { createRemoteScorer } from './remote-scorer.js';
export { createApp, type ServerOptions } from './server.js';
export { SqliteStore } from './store-sqlite.js';
export {
  MemoryLiveStore,
  sign,
  verifySignature,
  SIGNATURE_HEADER,
  type Challenge,
  type LiveStore
} from './mfa.js';
export { createMcpProxy, createHttpGuardClient, flattenArguments, type GuardClient } from './mcp-proxy.js';
export { SEED_COUNTERPARTIES } from './seed.js';
