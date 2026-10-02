import { callScoreSchema, type Scorer } from './contract.js';

/**
 * A scorer behind an HTTP endpoint (the hosted one, or your own). It receives
 * the score input as JSON and answers a score result. Any failure throws: the
 * gateway then treats the risk as maximal.
 */
export function createRemoteScorer(url: string, apiKey?: string, fetchImpl: typeof fetch = fetch): Scorer {
  return async (input) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(input)
    });
    if (!res.ok) throw new Error(`scorer answered ${res.status}`);
    return callScoreSchema.parse(await res.json());
  };
}
