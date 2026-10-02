import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpProxy, flattenArguments, type GuardAnswer, type GuardClient } from '../src/mcp-proxy.js';

async function setup(answer: GuardAnswer | Error, consumeOk = true) {
  const executed: Array<Record<string, unknown>> = [];
  const upstreamServer = new McpServer({ name: 'erp', version: '1.0.0' });
  upstreamServer.registerTool(
    'update_supplier_iban',
    { description: 'Change the bank account on a supplier record.', inputSchema: { iban: z.string() } },
    async (input) => {
      executed.push(input);
      return { content: [{ type: 'text', text: `IBAN set to ${input.iban}` }] };
    }
  );
  const [upA, upB] = InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(upB);
  const upstream = new Client({ name: 'proxy', version: '0' });
  await upstream.connect(upA);

  const seen: Array<{ kind: string; request: unknown }> = [];
  const guard: GuardClient = {
    async guard(request) {
      seen.push({ kind: 'guard', request });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async consume(grantId, request) {
      seen.push({ kind: `consume:${grantId}`, request });
      return consumeOk;
    }
  };
  const proxy = createMcpProxy({ upstream, guard, conversationId: 'call-7' });
  const [agentA, agentB] = InMemoryTransport.createLinkedPair();
  await proxy.connect(agentB);
  const agent = new Client({ name: 'agent', version: '0' });
  await agent.connect(agentA);

  const call = async (args: Record<string, unknown>) => {
    const result = await agent.callTool({ name: 'update_supplier_iban', arguments: args });
    return (result.content as Array<{ text: string }>)[0]!.text;
  };
  return { agent, call, executed, seen };
}

describe('the MCP proxy', () => {
  it("shows the upstream's tools unchanged", async () => {
    const t = await setup({ decision: 'deny', spokenReply: 'no', grantId: null });
    const { tools } = await t.agent.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['update_supplier_iban']);
  });

  it('forwards a call only after an allow and a consumed grant', async () => {
    const t = await setup({ decision: 'allow', spokenReply: 'ok', grantId: 'g1' });
    expect(await t.call({ iban: 'BE43068999999501' })).toBe('IBAN set to BE43068999999501');
    expect(t.executed).toEqual([{ iban: 'BE43068999999501' }]);
    const expected = {
      conversationId: 'call-7',
      action: 'update_supplier_iban',
      params: { iban: 'BE43068999999501' }
    };
    expect(t.seen).toEqual([
      { kind: 'guard', request: expected },
      { kind: 'consume:g1', request: expected }
    ]);
  });

  it('judges the call on the host conversation, whatever the model sends', async () => {
    const t = await setup({ decision: 'deny', spokenReply: 'no', grantId: null });
    // The upstream schema drops the extra argument; the point is what the guard was asked.
    await t.call({ iban: 'X', conversationId: 'someone-elses-call' });
    expect((t.seen[0]!.request as { conversationId: string }).conversationId).toBe('call-7');
  });

  it.each(['verify_first', 'deny', 'escalate'] as const)('answers %s itself and never reaches the upstream', async (decision) => {
    const t = await setup({ decision, spokenReply: 'I will confirm that first.', grantId: null });
    const text = await t.call({ iban: 'NL91ABNA0417164300' });
    expect(text).toContain(`NOT EXECUTED (${decision})`);
    expect(text).toContain('I will confirm that first.');
    expect(t.executed).toEqual([]);
  });

  it('fails closed when the gateway is unreachable or the grant is refused', async () => {
    const down = await setup(new Error('connect ECONNREFUSED'));
    expect(await down.call({ iban: 'X' })).toContain('NOT EXECUTED (gateway_unavailable)');
    expect(down.executed).toEqual([]);

    const refused = await setup({ decision: 'allow', spokenReply: 'ok', grantId: 'g2' }, false);
    expect(await refused.call({ iban: 'X' })).toContain('NOT EXECUTED (grant_refused)');
    expect(refused.executed).toEqual([]);

    const noGrant = await setup({ decision: 'allow', spokenReply: 'ok', grantId: null });
    expect(await noGrant.call({ iban: 'X' })).toContain('NOT EXECUTED');
    expect(noGrant.executed).toEqual([]);
  });

  it('flattens arguments to the string map a grant is bound to', () => {
    expect(flattenArguments({ iban: 'BE1', amount: 12, nested: { a: 1 }, none: null })).toEqual({
      iban: 'BE1',
      amount: '12',
      nested: '{"a":1}'
    });
  });
});
