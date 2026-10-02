# HTTP API

The gateway exposes seven routes. Three callers use them, each with its own credential, and no credential
opens another caller's route. The audit trail is read with a fourth.

| Caller | Credential | Routes |
|---|---|---|
| Agent host (the process that runs the voice agent) | `Authorization: Bearer <ANTICLUS_AGENT_KEY>` | add a turn, guard an action, delete a conversation |
| Client's MFA backend | `anticlus-signature` header, HMAC under `ANTICLUS_MFA_SECRET` | record a verification |
| Protected tool | `Authorization: Bearer <ANTICLUS_TOOL_KEY>` | consume a grant |
| Operator | `Authorization: Bearer <ANTICLUS_ADMIN_KEY>` | read the audit trail |

Bodies are JSON. A missing or wrong bearer key answers `401 {"error":"unauthorized"}` on every route that
takes one. Keys are compared in constant time.

All examples assume the gateway on `http://127.0.0.1:8787`.

## GET /healthz

No credential.

```
200 {"ok":true}
```

It says the process answers. It does not check the database or the scorer.

## POST /v1/conversations/{id}/turns

Agent key. Adds one turn of the call to the conversation. The gateway scores the whole conversation each
time an action is guarded, so send every caller turn before the guard call that follows it.

`{id}` is the conversation id. The host chooses it (one per call) and must never take it from the model's
output.

Request:

| Field | Type | Notes |
|---|---|---|
| `role` | `"caller"` or `"agent"` | `caller` is whoever is on the other end, whatever they claim to be |
| `text` | string, 1 to 4000 characters | No control characters other than tab, newline and carriage return |
| `at` | ISO 8601 date-time, optional | Time of the turn |

```bash
curl -X POST http://127.0.0.1:8787/v1/conversations/call-42/turns \
  -H "authorization: Bearer $ANTICLUS_AGENT_KEY" -H 'content-type: application/json' \
  -d '{"role":"caller","text":"Hello, Sophie Maes from Acme Industrial."}'
```

| Status | Body | When |
|---|---|---|
| 204 | empty | Stored |
| 400 | `{"error":"invalid_turn"}` | Not JSON, or the body does not match the table above |
| 401 | `{"error":"unauthorized"}` | Missing or wrong agent key |

## POST /v1/guard

Agent key. Asks whether one action with these exact parameters may run now.

Request:

| Field | Type | Notes |
|---|---|---|
| `conversationId` | string, 1 to 64 characters | Set by the host, never by the model |
| `action` | string, 1 to 64 characters | Must name a policy; an unknown action is denied |
| `params` | object of string to string, each value at most 500 characters | Defaults to `{}` |

Response, always `200` when the request is well formed:

| Field | Type | Notes |
|---|---|---|
| `decision` | `"allow"`, `"verify_first"`, `"deny"` or `"escalate"` | See [policies.md](policies.md) for the order |
| `reasons` | array of strings | Sentences the agent may say. No rule name, no score, no threshold |
| `spokenReply` | string | One sentence to speak to the caller |
| `grantId` | string or `null` | Set only on `allow` |
| `challenge` | `{ "id", "expiresAt" }` or `null` | Set on `verify_first` when a counterparty on file was matched |

The answer never carries the risk, the rule that fired or the verification target. Those are in the audit
trail only.

```bash
curl -X POST http://127.0.0.1:8787/v1/guard \
  -H "authorization: Bearer $ANTICLUS_AGENT_KEY" -H 'content-type: application/json' \
  -d '{"conversationId":"call-42","action":"update_supplier_iban","params":{"iban":"BE43068999999501"}}'
```

```json
{
  "decision": "verify_first",
  "reasons": ["Requests like this need to be confirmed outside this call."],
  "spokenReply": "Before I can do that, I'll confirm it with Acme Industrial NV using the contact details we already have on file.",
  "grantId": null,
  "challenge": { "id": "0b0c…", "expiresAt": "2026-10-02T21:50:00.000Z" }
}
```

What each decision means for the host:

- `allow`: pass `grantId` to the protected tool together with the same `conversationId`, `action` and
  `params`. The grant expires 120 seconds after it is issued.
- `verify_first` with a `challenge`: the gateway opened a challenge and posted it to the MFA webhook
  (see [mfa.md](mfa.md)). Call guard again with the same action and parameters after the MFA backend has
  answered. A repeated guard call while the challenge is still open returns the same challenge and sends
  no second webhook.
- `verify_first` without a `challenge`: the caller has not named a counterparty on file, or the policy
  waits for a fact-check that has not come back. Nothing was sent to the MFA backend.
- `deny`, `escalate`: do not run the action. Say `spokenReply`.

| Status | Body | When |
|---|---|---|
| 200 | the decision | Always, for a well-formed request, including unknown actions (`deny`) |
| 400 | `{"error":"invalid_request"}` | Not JSON, or the body does not match the request table |
| 401 | `{"error":"unauthorized"}` | Missing or wrong agent key |

Every guard call writes one audit row, whatever the decision.

## POST /v1/verifications

Called by the client's MFA backend. No bearer key: the request is authenticated by the
`anticlus-signature` header, computed over the raw body with `ANTICLUS_MFA_SECRET`. The scheme, a worked
example and the full flow are in [mfa.md](mfa.md).

Request:

| Field | Type | Notes |
|---|---|---|
| `challengeId` | string, 1 to 64 characters | The `challengeId` of the webhook |
| `passed` | boolean | The result of the check |
| `method` | `"callback"`, `"app"`, `"otp"`, `"passkey"` or `"human"`, optional | The method actually used. Defaults to the kind the challenge suggested |
| `note` | string, at most 300 characters, optional | Stored with the result |

| Status | Body | When |
|---|---|---|
| 200 | `{"recorded":true}` | The result was stored |
| 400 | `{"error":"invalid_request"}` | Signature valid, body not JSON or not matching the table |
| 401 | `{"error":"bad_signature","reason":"missing"}` | No `anticlus-signature` header |
| 401 | `{"error":"bad_signature","reason":"malformed"}` | Header is not `t=<digits>,v1=<64 lowercase hex>` |
| 401 | `{"error":"bad_signature","reason":"stale"}` | `t` is more than 5 minutes from the gateway's clock |
| 401 | `{"error":"bad_signature","reason":"mismatch"}` | The HMAC does not match |
| 404 | `{"error":"unknown_challenge"}` | No such challenge, or its counterparty is no longer in the counterparties file |
| 409 | `{"error":"already_answered"}` | The challenge already has a result. The first answer stands |
| 410 | `{"error":"expired"}` | The challenge is older than 10 minutes |

The signature is checked before the body is parsed.

## POST /v1/grants/{id}/consume

Tool key. The protected tool calls this before it acts, with the grant id it was handed and the action and
parameters it is about to execute. The gateway compares them with what the grant was issued for.

Request:

| Field | Type | Notes |
|---|---|---|
| `conversationId` | string, 1 to 64 characters | |
| `action` | string, 1 to 64 characters | |
| `params` | object of string to string, each value at most 500 characters | Defaults to `{}`. Compared by SHA-256 of the JSON with sorted keys, so key order does not matter and every value must be identical |

```bash
curl -X POST http://127.0.0.1:8787/v1/grants/$GRANT_ID/consume \
  -H "authorization: Bearer $ANTICLUS_TOOL_KEY" -H 'content-type: application/json' \
  -d '{"conversationId":"call-42","action":"update_supplier_iban","params":{"iban":"BE43068999999501"}}'
```

| Status | Body | When |
|---|---|---|
| 200 | `{"ok":true,"counterpartyId":"acme","verifiedBy":"app"}` | The grant was valid and is now used. `counterpartyId` and `verifiedBy` are `null` when the action needed no counterparty or no verification |
| 400 | `{"error":"invalid_request"}` | Not JSON, or the body does not match the table |
| 401 | `{"error":"unauthorized"}` | Missing or wrong tool key |
| 409 | `{"ok":false,"reason":"unknown"}` | No such grant |
| 409 | `{"ok":false,"reason":"wrong_conversation"}` | Issued for another conversation |
| 409 | `{"ok":false,"reason":"wrong_action"}` | Issued for another action |
| 409 | `{"ok":false,"reason":"wrong_params"}` | Issued for other parameters |
| 409 | `{"ok":false,"reason":"used"}` | Already consumed |
| 409 | `{"ok":false,"reason":"expired"}` | Older than 120 seconds |

The checks run in that order. Marking a grant used is one conditional update, so of two concurrent
consume calls exactly one gets `ok: true`.

The tool must treat anything other than `200` with `ok: true` as a refusal, including a network error.

## DELETE /v1/conversations/{id}

Agent key. Call it when the call is over.

It deletes the conversation's turns, its verification results, its challenges, its grants that were never
used, and the conversation row. Audit rows and used grants stay; neither contains a transcript or a
parameter value. See [data-handling.md](data-handling.md).

The id is remembered as ended. A later `POST /v1/conversations/{id}/turns` or `POST /v1/guard` for it answers
410 `{"error":"conversation_ended"}`, so a call cannot be restarted under the same id to shed a failed
verification. Use a new id for a new call.

| Status | Body | When |
|---|---|---|
| 204 | empty | Deleted, or there was nothing to delete |
| 401 | `{"error":"unauthorized"}` | Missing or wrong agent key |

## GET /v1/audit

Admin key. Returns the audit rows in time order. With `?conversationId=<id>`, only that conversation's
rows. There is no pagination.

```bash
curl "http://127.0.0.1:8787/v1/audit?conversationId=call-42" \
  -H "authorization: Bearer $ANTICLUS_ADMIN_KEY"
```

```json
{
  "rows": [
    {
      "id": "5f0e…",
      "conversationId": "call-42",
      "action": "update_supplier_iban",
      "decision": "verify_first",
      "rule": "trust_too_low",
      "trust": "identified",
      "risk": 45,
      "tier": 3,
      "policyVersion": "default-1",
      "paramsHash": "9c1b…",
      "at": "2026-10-02T21:40:00.000Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `rule` | Why the decision was taken: `allowed`, `trust_too_low`, `fact_check_not_back`, `verification_failed`, `claim_contradicted`, `counterparty_contradicted`, `risk_over_limit`, `unknown_action`, or `scorer_failed` (the scorer threw, timed out or answered something invalid) |
| `trust` | `anonymous`, `identified` or `verified` at the time of the decision |
| `risk` | 0 to 100, from the scorer; 100 when the scorer failed |
| `tier` | The policy's tier; 3 for an unknown action |
| `policyVersion` | `default-1` in this version; the command-line gateway does not set another value |
| `paramsHash` | SHA-256 of the parameters. The values themselves are not stored |

| Status | Body | When |
|---|---|---|
| 200 | `{"rows":[…]}` | |
| 401 | `{"error":"unauthorized"}` | Missing or wrong admin key |

## The remote scorer contract

Not a route of the gateway, but the one request it makes besides the MFA webhook. When
`ANTICLUS_SCORER_URL` is set, each guard call on a conversation with at least one turn sends:

```
POST <ANTICLUS_SCORER_URL>
content-type: application/json
authorization: Bearer <ANTICLUS_SCORER_KEY>      (only when the key is set)

{ "conversationId": "call-42", "turns": [ { "role": "caller", "text": "…" } ], "counterpartyId": null }
```

`counterpartyId` is the record matched earlier in the conversation, if any. The answer must match
`sentinelScoreResultSchema` in `src/schemas.ts`:

```json
{
  "conversationId": "call-42",
  "risk": 45,
  "signals": [ { "id": "urgency", "weight": 20, "quote": "…", "turn": 1 } ],
  "claims": [ { "id": "c1", "kind": "bank_account", "value": "BE43…", "touches": "iban", "status": "confirmed", "sources": [], "turn": 1 } ],
  "counterparty": { "claimedName": "Acme Industrial", "matchedId": "acme", "contradicted": false },
  "patternsMatched": [],
  "llmUsed": false,
  "scoredTurns": 2
}
```

A non-2xx status, an answer that does not match the schema, or no answer within 2 seconds counts as a
scorer failure: the risk is taken as 100, nothing is matched, and the audit row says `scorer_failed`.
