import { describe, expect, it } from 'vitest';
import type { SentinelScoreResult } from '../src/contract.js';
import { SEED_COUNTERPARTIES } from '../src/seed.js';
import { MemoryStore, createGateway } from '../src/gateway/index.js';
import { SCENARIOS } from '../src/scenarios/scenarios.js';
import { IDEAL_SCORES } from '../src/scenarios/ideal-scores.js';
import { formatTable, runScenarios } from '../src/scenarios/runner.js';

function gatewayFor(scenarioId: string) {
  const score = IDEAL_SCORES[scenarioId] as SentinelScoreResult;
  return createGateway({
    scorer: async (input) => ({ ...score, conversationId: input.conversationId }),
    store: new MemoryStore(),
    counterparties: SEED_COUNTERPARTIES,
    policyVersion: 'test'
  });
}

describe('Sentinel: every scenario through the gateway with its ideal score', () => {
  it('gets the expected decision for all scenarios, held-out ones included', async () => {
    const report = await runScenarios(SCENARIOS, async (s) => {
      const gateway = gatewayFor(s.id);
      for (const turn of s.turns) await gateway.addTurn(s.id, turn);
      for (const v of s.verifications) {
        await gateway.recordVerification({
          conversationId: s.id,
          counterpartyId: v.counterpartyId,
          kind: 'callback',
          passed: v.passed
        });
      }
      const decision = await gateway.guard({
        conversationId: s.id,
        action: s.request.action,
        params: s.request.params
      });
      return { decision: decision.decision, signals: IDEAL_SCORES[s.id]!.signals.map((x) => x.id) };
    });
    console.log(`\n${formatTable(report)}`);
    expect(report.rows.filter((r) => !r.pass)).toEqual([]);
  });

  it('opens a grant only for the exact parameters it was issued for', async () => {
    const s = SCENARIOS.find((x) => x.id === 'l3-iban-change-verified-callback');
    if (!s) throw new Error('scenario l3 missing');
    const gateway = gatewayFor(s.id);
    for (const turn of s.turns) await gateway.addTurn(s.id, turn);
    for (const v of s.verifications) {
      await gateway.recordVerification({
        conversationId: s.id,
        counterpartyId: v.counterpartyId,
        kind: 'callback',
        passed: v.passed
      });
    }
    const decision = await gateway.guard({
      conversationId: s.id,
      action: s.request.action,
      params: s.request.params
    });
    expect(decision.decision).toBe('allow');
    expect(decision.grantId).toBeTruthy();
    const other = await gateway.consumeGrant(decision.grantId!, s.id, s.request.action, {
      ...s.request.params,
      iban: 'NL91ABNA0417164300'
    });
    expect(other.ok).toBe(false);
  });
});
