import { createHash } from 'node:crypto';

/** JSON with sorted keys: the same parameters always give the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${body.join(',')}}`;
}

/** sha-256 of the canonical JSON of a call's parameters: what a grant is bound to. */
export function hashParams(params: Record<string, string>): string {
  return createHash('sha256').update(canonicalJson(params)).digest('hex');
}
