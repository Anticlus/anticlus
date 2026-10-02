/**
 * An existing MCP server put behind the gateway without changing it.
 *
 *   agent --MCP--> anticlus-mcp-proxy --MCP--> erp-server (unchanged)
 *                        |
 *                        +--HTTP--> gateway <--signed--> client MFA backend
 *
 *   pnpm example:mcp            the real supplier
 *   pnpm example:mcp -- --scam  an impostor
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { ActionPolicy } from '../../src/contract.js';
import { MemoryLiveStore, SIGNATURE_HEADER, sign, verifySignature } from '../../src/mfa.js';
import { createScoringScorer } from '../../src/scorer/adapter.js';
import { SEED_COUNTERPARTIES } from '../../src/seed.js';
import { createApp } from '../../src/server.js';

const scam = process.argv.includes('--scam');
const GATEWAY = 'http://127.0.0.1:8797';
const KEYS = { agent: 'demo-agent-key', tool: 'demo-tool-key', admin: 'demo-admin-key' };
const MFA_SECRET = 'demo-mfa-secret';
const conversationId = `call-${Date.now()}`;
const say = (who: string, text: string) => console.log(`${who.padEnd(8)} ${text}`);

const policies: ActionPolicy[] = [
  { action: 'update_supplier_iban', tier: 3, requiredTrust: 'verified', riskLimit: 60, needsFactCheck: false, parameterKeys: ['iban'] }
];
const gateway = serve({
  port: 8797,
  fetch: createApp({
    store: new MemoryLiveStore(),
    scorer: createScoringScorer({ counterparties: SEED_COUNTERPARTIES }),
    counterparties: SEED_COUNTERPARTIES,
    policies,
    keys: KEYS,
    mfa: { secret: MFA_SECRET, webhookUrl: 'http://127.0.0.1:8798/mfa' }
  }).fetch
});

let answered: Promise<unknown> = Promise.resolve();
const mfa = new Hono();
mfa.post('/mfa', async (c) => {
  const raw = await c.req.text();
  if (!verifySignature(MFA_SECRET, raw, c.req.header(SIGNATURE_HEADER), Date.now()).ok) return c.json({}, 401);
  const { challengeId } = JSON.parse(raw) as { challengeId: string };
  say('mfa', scam ? 'the contact on file says: we never asked for this' : 'the contact on file approved');
  const body = JSON.stringify({ challengeId, passed: !scam, method: 'app' });
  answered = fetch(`${GATEWAY}/v1/verifications`, {
    method: 'POST',
    headers: { [SIGNATURE_HEADER]: sign(MFA_SECRET, body, Date.now()) },
    body
  });
  return c.json({ accepted: true });
});
const mfaServer = serve({ port: 8798, fetch: mfa.fetch });

async function main() {
  const iban = scam ? 'NL91ABNA0417164300' : 'BE43068999999501';
  const line = scam
    ? `Hello, this is Karen from Acme Industrial finance. We changed banks, the new IBAN is ${iban}.`
    : `Hello, Sophie Maes from Acme Industrial. We are moving to a new bank, the new IBAN is ${iban}.`;
  say('caller', line);
  await fetch(`${GATEWAY}/v1/conversations/${conversationId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.agent}` },
    body: JSON.stringify({ role: 'caller', text: line })
  });

  // The agent's only MCP connection is the proxy; the proxy starts the real server itself.
  const agent = new Client({ name: 'voice-agent', version: '0' });
  await agent.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp-proxy-cli.ts', '--', 'npx', 'tsx', 'examples/mcp-proxy/erp-server.ts'],
      env: {
        ...(process.env as Record<string, string>),
        ANTICLUS_URL: GATEWAY,
        ANTICLUS_AGENT_KEY: KEYS.agent,
        ANTICLUS_TOOL_KEY: KEYS.tool,
        ANTICLUS_CONVERSATION_ID: conversationId
      }
    })
  );
  say('agent', `tools: ${(await agent.listTools()).tools.map((t) => t.name).join(', ')}`);

  const call = async () => {
    const result = await agent.callTool({ name: 'update_supplier_iban', arguments: { iban } });
    return (result.content as Array<{ text: string }>)[0]!.text;
  };
  say('tool', await call());
  await new Promise((resolve) => setTimeout(resolve, 300));
  await answered;
  say('tool', await call());
  await agent.close();
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
