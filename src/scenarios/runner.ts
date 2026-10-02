import type { Decision, Scenario, SignalId } from '../contract.js';

/** What a system under test answers for one scenario. */
export type ScenarioRunner = (scenario: Scenario) => Promise<{ decision: Decision; signals: SignalId[] }>;

export interface ScenarioRow {
  id: string;
  kind: Scenario['kind'];
  heldOut: boolean;
  expected: Decision;
  got: Decision | 'error';
  /** Expected signals the system did not find. */
  missingSignals: SignalId[];
  pass: boolean;
}

export interface ScenarioSummary {
  total: number;
  passed: number;
  attacks: number;
  /** Attacks that did not end in `allow` (the target is all of them). */
  attacksStopped: number;
  legitimate: number;
  /** Legitimate requests decided `allow`. */
  legitimateAllowed: number;
  /** Legitimate requests that ended in `escalate` or `deny`. */
  falseAlarms: number;
  heldOutPassed: number;
  heldOutTotal: number;
}

export interface ScenarioReport {
  rows: ScenarioRow[];
  summary: ScenarioSummary;
}

/**
 * Runs every scenario through `runner` and judges it: the decision must be the
 * expected one and every expected signal must be found. A runner that throws
 * counts as an error row and a failure, never as a pass.
 */
export async function runScenarios(
  scenarios: readonly Scenario[],
  runner: ScenarioRunner
): Promise<ScenarioReport> {
  const rows: ScenarioRow[] = [];
  for (const s of scenarios) {
    let got: ScenarioRow['got'] = 'error';
    let found: SignalId[] = [];
    try {
      const out = await runner(s);
      got = out.decision;
      found = out.signals;
    } catch {
      got = 'error';
    }
    const missingSignals = s.expect.signals.filter((id) => !found.includes(id));
    rows.push({
      id: s.id,
      kind: s.kind,
      heldOut: s.heldOut,
      expected: s.expect.decision,
      got,
      missingSignals,
      pass: got === s.expect.decision && missingSignals.length === 0
    });
  }
  return { rows, summary: summarize(rows) };
}

export function summarize(rows: readonly ScenarioRow[]): ScenarioSummary {
  const attacks = rows.filter((r) => r.kind === 'attack');
  const legit = rows.filter((r) => r.kind === 'legitimate');
  const heldOut = rows.filter((r) => r.heldOut);
  return {
    total: rows.length,
    passed: rows.filter((r) => r.pass).length,
    attacks: attacks.length,
    attacksStopped: attacks.filter((r) => r.got !== 'allow' && r.got !== 'error').length,
    legitimate: legit.length,
    legitimateAllowed: legit.filter((r) => r.got === 'allow').length,
    falseAlarms: legit.filter((r) => r.got !== 'allow').length,
    heldOutPassed: heldOut.filter((r) => r.pass).length,
    heldOutTotal: heldOut.length
  };
}

/** The results table: one line per scenario, then the totals. */
export function formatTable(report: ScenarioReport): string {
  const { rows, summary: s } = report;
  const cols = ['scenario', 'kind', 'held out', 'expected', 'got', 'result'];
  const lines = rows.map((r) => [
    r.id,
    r.kind,
    r.heldOut ? 'yes' : 'no',
    r.expected,
    r.got,
    r.pass
      ? 'PASS'
      : r.missingSignals.length > 0 && r.got === r.expected
        ? `FAIL (missed ${r.missingSignals.join(',')})`
        : 'FAIL'
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [
    fmt(cols),
    fmt(widths.map((w) => '-'.repeat(w))),
    ...lines.map(fmt),
    '',
    `attacks stopped: ${s.attacksStopped}/${s.attacks}`,
    `legitimate allowed: ${s.legitimateAllowed}/${s.legitimate} (false alarms: ${s.falseAlarms})`,
    `held-out passed: ${s.heldOutPassed}/${s.heldOutTotal}`,
    `scenarios passed: ${s.passed}/${s.total}`
  ].join('\n');
}
