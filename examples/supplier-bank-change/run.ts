/**
 * The supplier bank-change call, end to end over real HTTP on localhost.
 *
 * Three processes in one script, each holding only its own credential:
 *   1. the gateway (port 8787),
 *   2. the client's MFA backend (port 8788): a stand-in for the system a
 *      company already has (a banking-app push, a one-time code, a callback),
 *   3. the voice agent's host and the protected back-office tool.
 *
 * Run it twice:
 *   pnpm example            the real supplier, the MFA check passes
 *   pnpm example -- --scam  an impostor, the MFA check fails
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { ActionPolicy } from '../../src/contract.js';
import { MemoryLiveStore, SIGNATURE_HEADER, sign, verifySignature } from '../../src/mfa.js';
import { createScoringScorer } from '../../src/scorer/adapter.js';
import { SEED_COUNTERPARTIES } from '../../src/seed.js';
import { createApp } from '../../src/server.js';

const scam = process.argv.includes('--scam');
const GATEWAY = 'http://127.0.0.1:8787';
const KEYS = { agent: 'demo-agent-key', tool: 'demo-tool-key', admin: 'demo-admin-key' };
const MFA_SECRET = 'demo-mfa-secret';
const say = (who: string, text: string) => console.log(`${who.padEnd(8)} ${text}`);

// The self-hosted gateway runs on the built-in rules; checking an IBAN on the
// web is a hosted scorer, so this policy does not wait for it.
const policies: ActionPolicy[] = [
  {
    action: 'update_supplier_iban',
    tier: 3,
    requiredTrust: 'verified',
    riskLimit: 60,
    needsFactCheck: false,
    parameterKeys: ['iban']
  }
];

// 1. The gateway.
const gateway = serve({
  port: 8787,
  fetch: createApp({
    store: new MemoryLiveStore(),
    scorer: createScoringScorer({ counterparties: SEED_COUNTERPARTIES }),
    counterparties: SEED_COUNTERPARTIES,
    policies,
    keys: KEYS,
    mfa: { secret: MFA_SECRET, webhookUrl: 'http://127.0.0.1:8788/mfa' }
  }).fetch
});

// 2. The client's MFA backend. It trusts only a signed challenge, and answers with a signed result.
let answered: Promise<void> = Promise.resolve();
const mfa = new Hono();
mfa.post('/mfa', async (c) => {
  const raw = await c.req.text();
  if (!verifySignature(MFA_SECRET, raw, c.req.header(SIGNATURE_HEADER), Date.now()).ok) {
    return c.json({ error: 'bad_signature' }, 401);
  }
  const challenge = JSON.parse(raw) as { challengeId: string; target: string; action: string };
  say('mfa', `challenge received: confirm "${challenge.action}" with the contact on file (${challenge.target})`);
  answered = (async () => {
    // Here the real system pushes to the supplier's registered app or calls the number on file.
    const passed = !scam;
    say('mfa', passed ? 'the contact on file approved' : 'the contact on file says: we never asked for this');
    const body = JSON.stringify({ challengeId: challenge.challengeId, passed, method: 'app' });
    await fetch(`${GATEWAY}/v1/verifications`, {
      method: 'POST',
      headers: { [SIGNATURE_HEADER]: sign(MFA_SECRET, body, Date.now()) },
      body
    });
  })();
  return c.json({ accepted: true });
});
const mfaServer = serve({ port: 8788, fetch: mfa.fetch });

// 3a. The protected tool: it changes nothing without a grant the gateway confirms.
async function updateSupplierIban(grantId: string | null, conversationId: string, iban: string): Promise<string> {
  if (!grantId) return 'REFUSED (no grant)';
  const res = await fetch(`${GATEWAY}/v1/grants/${grantId}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.tool}` },
    body: JSON.stringify({ conversationId, action: 'update_supplier_iban', params: { iban } })
  });
  const out = (await res.json()) as { ok: boolean; reason?: string; verifiedBy?: string };
  return out.ok ? `DONE (verified by ${out.verifiedBy})` : `REFUSED (${out.reason})`;
}

// 3b. The voice agent's host.
const agent = (path: string, body: unknown) =>
  fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.agent}` },
    body: JSON.stringify(body)
  });

async function main() {
  const conversationId = `call-${Date.now()}`;
  const iban = scam ? 'NL91ABNA0417164300' : 'BE43068999999501';
  const lines = scam
    ? [
        'Hello, this is Karen from Acme Industrial finance. We have changed banks.',
        `The new IBAN is ${iban}. Please update it for the next payment.`
      ]
    : [
        'Hello, Sophie Maes from Acme Industrial. We are moving to a new bank.',
        `The new IBAN is ${iban}. I understand you will want to confirm this with us.`
      ];
  for (const text of lines) {
    say('caller', text);
    await agent(`/v1/conversations/${conversationId}/turns`, { role: 'caller', text });
  }

  const request = { conversationId, action: 'update_supplier_iban', params: { iban } };
  type Decision = { decision: string; spokenReply: string; grantId: string | null };

  const first = (await (await agent('/v1/guard', request)).json()) as Decision;
  say('gateway', `decision: ${first.decision}`);
  say('agent', first.spokenReply);
  say('tool', `update_supplier_iban -> ${await updateSupplierIban(first.grantId, conversationId, iban)}`);

  await new Promise((resolve) => setTimeout(resolve, 200));
  await answered;

  const second = (await (await agent('/v1/guard', request)).json()) as Decision;
  say('gateway', `decision: ${second.decision}`);
  say('agent', second.spokenReply);
  say('tool', `update_supplier_iban -> ${await updateSupplierIban(second.grantId, conversationId, iban)}`);
  if (second.grantId) {
    say('tool', `same grant again   -> ${await updateSupplierIban(second.grantId, conversationId, iban)}`);
  }

  const audit = (await (
    await fetch(`${GATEWAY}/v1/audit?conversationId=${conversationId}`, {
      headers: { authorization: `Bearer ${KEYS.admin}` }
    })
  ).json()) as { rows: Array<{ decision: string; rule: string; trust: string; risk: number }> };
  console.log('\naudit trail (operator only):');
  for (const row of audit.rows) console.log(`  ${row.decision.padEnd(13)} rule=${row.rule} trust=${row.trust} risk=${row.risk}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    gateway.close();
    mfaServer.close();
  });
