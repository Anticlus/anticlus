/** A stand-in for a company's existing MCP server. It knows nothing about the gateway. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'erp', version: '1.0.0' });
server.registerTool(
  'update_supplier_iban',
  { description: 'Change the bank account on a supplier record.', inputSchema: { iban: z.string() } },
  async ({ iban }) => ({ content: [{ type: 'text', text: `ERP: supplier account is now ${iban}` }] })
);
await server.connect(new StdioServerTransport());
