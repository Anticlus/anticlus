#!/usr/bin/env node
/**
 * anticlus-mcp-proxy: a stdio MCP server that fronts another MCP server.
 *
 *   ANTICLUS_URL=http://127.0.0.1:8787 ANTICLUS_AGENT_KEY=... ANTICLUS_TOOL_KEY=... \
 *   ANTICLUS_CONVERSATION_ID=call-123 \
 *   anticlus-mcp-proxy --url https://mcp.internal.example/mcp
 *   anticlus-mcp-proxy -- node ./erp-mcp-server.js
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpGuardClient, createMcpProxy } from './mcp-proxy.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required. The proxy does not start without it.`);
    process.exit(1);
  }
  return value;
}

const args = process.argv.slice(2);
const urlAt = args.indexOf('--url');
const dashAt = args.indexOf('--');
const upstream = new Client({ name: 'anticlus-proxy', version: '0.1.0' });

if (urlAt >= 0 && args[urlAt + 1]) {
  await upstream.connect(new StreamableHTTPClientTransport(new URL(args[urlAt + 1]!)));
} else if (dashAt >= 0 && args[dashAt + 1]) {
  await upstream.connect(new StdioClientTransport({ command: args[dashAt + 1]!, args: args.slice(dashAt + 2) }));
} else {
  console.error('Usage: anticlus-mcp-proxy --url <upstream MCP URL>   or   anticlus-mcp-proxy -- <command> [args]');
  process.exit(1);
}

const proxy = createMcpProxy({
  upstream,
  guard: createHttpGuardClient(required('ANTICLUS_URL'), {
    agent: required('ANTICLUS_AGENT_KEY'),
    tool: required('ANTICLUS_TOOL_KEY')
  }),
  conversationId: required('ANTICLUS_CONVERSATION_ID')
});
await proxy.connect(new StdioServerTransport());
