import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * The gateway as an MCP proxy: the agent connects here instead of to the real
 * MCP server, and every tool call is guarded before it is forwarded.
 *
 *  - The tool list is the upstream's, unchanged.
 *  - A call is forwarded only after the gateway allowed it AND the grant for
 *    exactly these arguments was consumed. Anything else (verify first, deny,
 *    escalate, an unknown tool, the gateway unreachable) is answered here,
 *    with the sentence the agent may say, and never reaches the upstream.
 *  - The conversation id is fixed by the host when it starts the proxy. It is
 *    never read from the tool arguments: the model does not choose which
 *    conversation it is judged on.
 *
 * The upstream must be reachable only through this proxy.
 */

export interface GuardAnswer {
  decision: 'allow' | 'verify_first' | 'deny' | 'escalate';
  spokenReply: string;
  grantId: string | null;
}

export interface GuardClient {
  guard(request: { conversationId: string; action: string; params: Record<string, string> }): Promise<GuardAnswer>;
  consume(
    grantId: string,
    request: { conversationId: string; action: string; params: Record<string, string> }
  ): Promise<boolean>;
}

/** The guard client over the gateway's HTTP API. The proxy is both the agent's host and the enforcement point, so it holds both keys. */
export function createHttpGuardClient(
  baseUrl: string,
  keys: { agent: string; tool: string },
  fetchImpl: typeof fetch = fetch
): GuardClient {
  const post = (path: string, key: string, body: unknown) =>
    fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
  return {
    async guard(request) {
      const res = await post('/v1/guard', keys.agent, request);
      if (!res.ok) throw new Error(`gateway answered ${res.status}`);
      return (await res.json()) as GuardAnswer;
    },
    async consume(grantId, request) {
      const res = await post(`/v1/grants/${encodeURIComponent(grantId)}/consume`, keys.tool, request);
      return res.ok && ((await res.json()) as { ok: boolean }).ok === true;
    }
  };
}

/** Tool arguments as the flat string map a policy and a grant are bound to. */
export function flattenArguments(args: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

const FALLBACK_REPLY = "I can't do that right now. I can pass you to a colleague who can help.";

function notExecuted(decision: string, spokenReply: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `NOT EXECUTED (${decision}). The action was not performed. Say to the caller: "${spokenReply}"`
      }
    ]
  };
}

export interface McpProxyOptions {
  /** A connected client to the real MCP server. */
  upstream: Client;
  guard: GuardClient;
  /** Set by the host for this call. Never taken from the model. */
  conversationId: string;
  name?: string;
}

export function createMcpProxy(options: McpProxyOptions): Server {
  const { upstream, guard, conversationId } = options;
  const server = new Server(
    { name: options.name ?? 'anticlus-proxy', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => upstream.listTools(request.params));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const guarded = {
      conversationId,
      action: request.params.name,
      params: flattenArguments(request.params.arguments)
    };
    let answer: GuardAnswer;
    try {
      answer = await guard.guard(guarded);
    } catch {
      return notExecuted('gateway_unavailable', FALLBACK_REPLY);
    }
    if (answer.decision !== 'allow' || !answer.grantId) {
      return notExecuted(answer.decision === 'allow' ? 'deny' : answer.decision, answer.spokenReply);
    }
    let consumed = false;
    try {
      consumed = await guard.consume(answer.grantId, guarded);
    } catch {
      consumed = false;
    }
    if (!consumed) return notExecuted('grant_refused', FALLBACK_REPLY);
    return upstream.callTool(request.params);
  });

  return server;
}
