import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTION_POLICIES,
  scenarioSchema,
  sentinelScoreResultSchema,
  type Decision,
  type Scenario,
  type SentinelScoreResult,
  type TrustLevel
} from '../src/contract.js';
import { ATTACKER_IBANS, SEED_COUNTERPARTIES } from '../src/seed.js';
import { SCENARIOS } from '../src/scenarios/scenarios.js';
import { IDEAL_SCORES } from '../src/scenarios/ideal-scores.js';
import { formatTable, runScenarios, summarize } from '../src/scenarios/runner.js';

/**
 * A minimal reference of the BR-9 order the team chose, used ONLY to check that
 * the expectations in the scenarios agree with the ideal scores. The gateway
 * has its own engine and its own tests.
 */
function reference(s: Scenario, score: SentinelScoreResult): Decision {
  const policy = DEFAULT_ACTION_POLICIES.find((p) => p.action === s.request.action)!;
  const matched = score.counterparty.matchedId;
  let trust: TrustLevel = 'anonymous';
  if (matched && !score.counterparty.contradicted) trust = 'identified';
  if (trust === 'identified' && s.verifications.some((v) => v.counterpartyId === matched && v.passed)) {
    trust = 'verified';
  }
  const rank: Record<TrustLevel, number> = { anonymous: 0, identified: 1, verified: 2 };
  if (score.risk >= policy.riskLimit) return 'escalate';
  if (
    score.claims.some(
      (c) => c.status === 'contradicted' && c.touches && policy.parameterKeys.includes(c.touches)
    )
  ) {
    return 'deny';
  }
  if (rank[trust] < rank[policy.requiredTrust]) return 'verify_first';
  if (policy.needsFactCheck && !score.claims.some((c) => c.touches === 'iban' && c.status === 'confirmed')) {
    return 'verify_first';
  }
  return 'allow';
}

describe('sentinel scenarios', () => {
  it('has 12 parsed scenarios with unique ids', () => {
    expect(SCENARIOS).toHaveLength(12);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(12);
    for (const s of SCENARIOS) expect(scenarioSchema.safeParse(s).success).toBe(true);
  });

  it('is 5 + 5 tuned and 1 + 1 held out', () => {
    const tuned = SCENARIOS.filter((s) => !s.heldOut);
    expect(tuned.filter((s) => s.kind === 'attack')).toHaveLength(5);
    expect(tuned.filter((s) => s.kind === 'legitimate')).toHaveLength(5);
    const held = SCENARIOS.filter((s) => s.heldOut);
    expect(held.map((s) => s.kind).sort()).toEqual(['attack', 'legitimate']);
  });

  it('only uses the default actions, the seed counterparties and 4 to 8 turns', () => {
    const actions = new Set(DEFAULT_ACTION_POLICIES.map((p) => p.action));
    const ids = new Set(SEED_COUNTERPARTIES.map((c) => c.id));
    for (const s of SCENARIOS) {
      expect(actions.has(s.request.action)).toBe(true);
      if (s.counterpartyId) expect(ids.has(s.counterpartyId)).toBe(true);
      for (const v of s.verifications) expect(ids.has(v.counterpartyId)).toBe(true);
      expect(s.turns.length).toBeGreaterThanOrEqual(4);
      expect(s.turns.length).toBeLessThanOrEqual(8);
    }
  });

  it('covers the three languages and all the attack kinds', () => {
    expect(new Set(SCENARIOS.map((s) => s.language))).toEqual(new Set(['en', 'fr', 'nl']));
    const expected = new Set(SCENARIOS.flatMap((s) => s.expect.signals));
    for (const id of [
      'urgency',
      'authority',
      'secrecy',
      'channel_switch',
      'known_script',
      'prompt_injection',
      'memory_instruction'
    ]) {
      expect(expected.has(id as never)).toBe(true);
    }
  });

  it('puts an attacker IBAN in every attack that changes an IBAN, and none on file', () => {
    const onFile = new Set(SEED_COUNTERPARTIES.flatMap((c) => c.bankAccounts.map((b) => b.iban)));
    for (const iban of ATTACKER_IBANS) expect(onFile.has(iban)).toBe(false);
    for (const s of SCENARIOS.filter(
      (x) => x.kind === 'attack' && x.request.action === 'update_supplier_iban'
    )) {
      expect(ATTACKER_IBANS).toContain(s.request.params.iban);
    }
  });
});

describe('ideal scores', () => {
  it('has one valid score per scenario and none extra', () => {
    expect(Object.keys(IDEAL_SCORES).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
    for (const score of Object.values(IDEAL_SCORES))
      expect(sentinelScoreResultSchema.safeParse(score).success).toBe(true);
  });

  it('quotes the conversation verbatim, on the turn it names', () => {
    for (const s of SCENARIOS) {
      for (const sig of IDEAL_SCORES[s.id]!.signals) {
        expect(sig.quote.length).toBeLessThanOrEqual(160);
        expect(s.turns[sig.turn]!.text).toContain(sig.quote);
      }
    }
  });

  it('covers every signal a scenario expects', () => {
    for (const s of SCENARIOS) {
      const found = IDEAL_SCORES[s.id]!.signals.map((x) => x.id);
      for (const id of s.expect.signals) expect(found, s.id).toContain(id);
    }
  });

  it('keeps the risk equal to the sum of the signal weights', () => {
    for (const score of Object.values(IDEAL_SCORES)) {
      expect(score.risk).toBe(
        Math.min(
          100,
          score.signals.reduce((n, x) => n + x.weight, 0)
        )
      );
    }
  });

  it('agrees with the expected decision under the BR-9 order', () => {
    for (const s of SCENARIOS) expect(reference(s, IDEAL_SCORES[s.id]!), s.id).toBe(s.expect.decision);
  });

  it('never lets the score alone grant trust: a legitimate IBAN change needs its verification', () => {
    const l3 = SCENARIOS.find((s) => s.id === 'l3-iban-change-verified-callback')!;
    expect(reference({ ...l3, verifications: [] }, IDEAL_SCORES[l3.id]!)).toBe('verify_first');
  });
});

describe('runScenarios', () => {
  const perfect = async (s: Scenario) => ({ decision: s.expect.decision, signals: [...s.expect.signals] });

  it('counts a perfect runner as all passed', async () => {
    const report = await runScenarios(SCENARIOS, perfect);
    expect(report.summary).toMatchObject({
      total: 12,
      passed: 12,
      attacks: 6,
      attacksStopped: 6,
      legitimate: 6,
      legitimateAllowed: 6,
      falseAlarms: 0,
      heldOutPassed: 2,
      heldOutTotal: 2
    });
  });

  it('counts a missed attack, a false alarm and a missing signal separately', async () => {
    const report = await runScenarios(SCENARIOS, async (s) => {
      if (s.id === 'a1-iban-change-urgent')
        return { decision: 'allow', signals: ['urgency', 'known_script'] };
      if (s.id === 'l2-invoice-status-known-supplier') return { decision: 'escalate', signals: [] };
      if (s.id === 'a2-ceo-secrecy') return { decision: 'escalate', signals: ['authority'] };
      return perfect(s);
    });
    expect(report.summary.attacksStopped).toBe(5);
    expect(report.summary.falseAlarms).toBe(1);
    expect(report.summary.legitimateAllowed).toBe(5);
    expect(report.summary.passed).toBe(9);
    const a2 = report.rows.find((r) => r.id === 'a2-ceo-secrecy')!;
    expect(a2.pass).toBe(false);
    expect(a2.missingSignals).toEqual(['secrecy', 'urgency']);
  });

  it('treats a throwing runner as a failure, never as a pass or a stop', async () => {
    const report = await runScenarios(SCENARIOS, async () => {
      throw new Error('boom');
    });
    expect(report.summary.passed).toBe(0);
    expect(report.summary.attacksStopped).toBe(0);
    expect(report.rows.every((r) => r.got === 'error')).toBe(true);
  });

  it('prints the table with every scenario and the totals', async () => {
    const table = formatTable(await runScenarios(SCENARIOS, perfect));
    for (const s of SCENARIOS) expect(table).toContain(s.id);
    expect(table).toContain('attacks stopped: 6/6');
    expect(table).toContain('legitimate allowed: 6/6 (false alarms: 0)');
    expect(table).toContain('scenarios passed: 12/12');
    expect(summarize([]).total).toBe(0);
  });
});
