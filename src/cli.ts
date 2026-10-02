#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { actionPolicySchema, counterpartySchema, DEFAULT_ACTION_POLICIES } from './contract.js';
import { createRemoteScorer } from './remote-scorer.js';
import { createScoringScorer } from './scorer/adapter.js';
import { createApp } from './server.js';
import { SqliteStore } from './store-sqlite.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required. The gateway does not start without it.`);
    process.exit(1);
  }
  return value;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const counterparties = z.array(counterpartySchema).parse(readJson(required('ANTICLUS_COUNTERPARTIES')));
const policies = process.env.ANTICLUS_POLICIES
  ? z.array(actionPolicySchema).parse(readJson(process.env.ANTICLUS_POLICIES))
  : DEFAULT_ACTION_POLICIES;
const scorer = process.env.ANTICLUS_SCORER_URL
  ? createRemoteScorer(process.env.ANTICLUS_SCORER_URL, process.env.ANTICLUS_SCORER_KEY)
  : createScoringScorer({ counterparties });

const app = createApp({
  store: new SqliteStore(process.env.ANTICLUS_DB ?? 'anticlus.db'),
  scorer,
  counterparties,
  policies,
  keys: {
    agent: required('ANTICLUS_AGENT_KEY'),
    tool: required('ANTICLUS_TOOL_KEY'),
    admin: required('ANTICLUS_ADMIN_KEY')
  },
  mfa: {
    secret: required('ANTICLUS_MFA_SECRET'),
    webhookUrl: process.env.ANTICLUS_MFA_WEBHOOK_URL
  },
  onWebhookError: (error, challenge) =>
    console.error(`MFA webhook failed for challenge ${challenge.id}: ${String(error)}`)
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`anticlus gateway on http://127.0.0.1:${port}`);
  console.log(`scorer: ${process.env.ANTICLUS_SCORER_URL ? 'remote' : 'built-in rules'}; policies: ${policies.length}`);
});
