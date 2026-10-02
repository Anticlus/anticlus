import { describe, expect, it } from 'vitest';
import { createScoringScorer } from '../src/scorer/adapter.js';
import { MemoryStore, createGateway } from '../src/gateway/index.js';
import { KNOWN_GAPS } from '../src/scenarios/known-gaps.js';
import { RECORDED_FACTCHECKS } from '../src/scenarios/recorded-factchecks.js';
import { SEED_COUNTERPARTIES } from '../src/seed.js';
import { SCENARIOS } from '../src/scenarios/scenarios.js';
import { formatTable, runScenarios } from '../src/scenarios/runner.js';

const scorer = createScoringScorer({
  counterparties: SEED_COUNTERPARTIES,
  factCheckFor: (conversationId) => RECORDED_FACTCHECKS[conversationId] ?? null
});

function newGateway() {
  return createGateway({
    scorer,
    store: new MemoryStore(),
    counterparties: SEED_COUNTERPARTIES,
    policyVersion: 'test'
  });
}

describe('Sentinel: the gateway on Gilles’s real scorer', () => {
  it('runs every scenario and never lets an attack through', async () => {
    const report = await runScenarios(SCENARIOS, async (s) => {
      const gateway = newGateway();
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
      const score = await scorer({ conversationId: s.id, turns: s.turns, counterpartyId: null });
      return { decision: decision.decision, signals: score.signals.map((x) => x.id) };
    });
    console.log(`\n${formatTable(report)}`);

    // The two guarantees that must never regress: no attack gets through, no legitimate caller is blocked.
    expect(report.rows.filter((r) => r.kind === 'attack' && r.got === 'allow')).toEqual([]);
    expect(report.rows.filter((r) => r.kind === 'legitimate' && r.got !== 'allow')).toEqual([]);
    const unexpected = report.rows.filter((r) => !r.pass && !(r.id in KNOWN_GAPS));
    expect(unexpected).toEqual([]);
    // The list is exact: a gap that now passes must come off it.
    expect(
      Object.keys(KNOWN_GAPS)
        .filter((id) => report.rows.find((r) => r.id === id)?.pass)
        .sort()
    ).toEqual([]);
  });
});
