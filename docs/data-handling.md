# Data handling: the self-hosted gateway

**Status: draft. Not legal advice.** This page describes what the open-source gateway in this repository
does with data, as read from the code at version 0.1.0. It is written to help an operator do their own
assessment. It is not a data processing agreement, and it makes no statement about any hosted service.
Have it reviewed by your own counsel before you process real calls.

## 1. Who is who

You run the gateway on your own infrastructure. The Anticlus authors operate nothing in that setup and
receive nothing from it: the code contains no telemetry and makes no outbound request other than the two
you configure (the MFA webhook and, optionally, a remote scorer).

| Role | Who |
|---|---|
| Controller | You, the company whose voice agent takes the call. You decide why calls are processed and you tell callers about it |
| Processor | Whoever you choose to involve: your host, your speech-to-text provider, the operator of a remote scorer if you configure one |
| Data subject | The caller, and any person named in the call or in a counterparty record |

## 2. What the gateway receives

The gateway handles text only. It never receives audio: transcription happens in your agent stack before
a turn is sent.

| Data | Sent by | Through |
|---|---|---|
| Transcript turns: role, text (up to 4000 characters), optional time | Agent host | `POST /v1/conversations/{id}/turns` |
| Action name and parameters (for example an IBAN) | Agent host, protected tool | `POST /v1/guard`, `POST /v1/grants/{id}/consume` |
| Verification result: challenge id, passed or failed, method, optional note | Your MFA backend | `POST /v1/verifications` |
| Counterparty records: name, registry number, official phone, domain, bank accounts, contact person | You | The file at `ANTICLUS_COUNTERPARTIES`, read at start |

The conversation id is chosen by your agent host. Do not put personal data in it (a phone number, for
example): it is stored in the audit trail, which is kept.

## 3. What is stored, and for how long

Everything is in one SQLite file, at `ANTICLUS_DB` (`/data/anticlus.db` in the Docker image), plus its
`-wal` and `-shm` side files. The gateway does not encrypt it.

| Table | Content | Deleted when |
|---|---|---|
| `turns` | The transcript turns, as sent | `DELETE /v1/conversations/{id}` |
| `conversations` | Conversation id, id of the matched counterparty | `DELETE /v1/conversations/{id}` |
| `verifications` | Counterparty id, method, passed or failed, note, the action and parameter hash it is bound to, expiry | `DELETE /v1/conversations/{id}` |
| `challenges` | Conversation id, counterparty id, action, parameter hash, suggested method, **target (the counterparty's official phone number)**, times, result | `DELETE /v1/conversations/{id}` |
| `grants` | Grant id, conversation id, action, parameter hash, expiry, used time, counterparty id, verification method | Unused grants: `DELETE /v1/conversations/{id}`. **Used grants: never** |
| `audit` | Row id, conversation id, action, decision, rule, trust level, risk, tier, policy version, parameter hash, time | **Never** |

**The gateway has no retention timer.** Nothing is deleted on a schedule or on expiry. Transcript turns
stay in the database until the agent host calls `DELETE /v1/conversations/{id}`; if the host never calls
it (a crash, a dropped call), they stay indefinitely. Audit rows and used grants are never deleted by the
gateway. Retention of those is yours to implement, on the SQLite file directly, for example from a
maintenance job with `sqlite3`. The periods here are placeholders, not a recommendation:

```sql
DELETE FROM audit  WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-13 months');
DELETE FROM grants WHERE used_at IS NOT NULL AND used_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days');
```

SQLite does not overwrite deleted rows at once. If erasure must be physical, run `VACUUM` after deleting,
and account for backups of the file.

## 4. What is never stored

- **Audio.** The gateway has no route that accepts it.
- **Parameter values.** The IBAN, phone number or other argument of an action is used in memory to compute
  a SHA-256 hash; grants, challenges, verifications and audit rows hold the hash only. A hash of a
  low-entropy value such as an IBAN can be confirmed by someone who already has a candidate value, so
  treat it as pseudonymous, not anonymous. Note that a caller usually also *says* the value, in which
  case it is in the transcript turns until the conversation is deleted.
- **Score details.** Signals, quotes, claims and the claimed organisation name returned by the scorer are
  used for the decision and discarded. The audit row keeps the risk number and the rule only.
- **Request logs.** The gateway does not log requests or bodies. It writes two lines at start and one
  line per failed MFA webhook (the challenge id and the error). Your reverse proxy may log more.
- **Counterparty records.** They are read from your file into memory and are not copied to the database,
  apart from the counterparty id (in conversations, verifications, challenges and grants) and the official
  phone number (in challenges).

## 5. What leaves the machine

Two outbound requests exist. Both go only to URLs you set.

**The MFA webhook** (`ANTICLUS_MFA_WEBHOOK_URL`), on each new challenge:

- challenge id, conversation id, counterparty id, action name, parameter hash, suggested method, the
  counterparty's official phone number, expiry.
- No transcript, no parameter values, no risk.

**The remote scorer** (`ANTICLUS_SCORER_URL`), only when you set it, on every guard call for a
conversation that has at least one turn:

- the conversation id, **every turn of the conversation so far, in full text**, and the id of the matched
  counterparty if there is one. The bearer key in `ANTICLUS_SCORER_KEY` is sent as a header.
- Not sent: the action, its parameters, counterparty records, verification results, grants, the audit
  trail.

A remote scorer therefore receives the whole transcript of every guarded call, again on each guard call.
What it does with it (retention, sub-processors such as a web fact-check or a synthetic-voice service,
location) is governed by your agreement with whoever operates that endpoint, not by this document. Without
`ANTICLUS_SCORER_URL`, scoring runs inside the gateway process and the transcript stays on the machine.

Neither request is retried, and neither is encrypted by the gateway itself: use `https` URLs.

## 6. Deleting a conversation

```bash
curl -X DELETE http://127.0.0.1:8787/v1/conversations/call-42 \
  -H "authorization: Bearer $ANTICLUS_AGENT_KEY"
# 204
```

In one transaction this removes the conversation's turns, verification results, challenges, unused
grants and the conversation row. It keeps audit rows and used grants, which contain the conversation id,
the action name, the decision and a parameter hash, and no transcript.

Call it at the end of every call. The Python client's `end_conversation` does the same.

There is no route that deletes by caller (the gateway does not know the caller's number), none that
deletes audit rows, and none that exports a conversation. An erasure or access request that reaches the
audit trail has to be handled on the SQLite file.

## 7. What the caller hears

The reply for a refusal or a step-up contains no score, rule name, threshold or verification target.
Those are in the audit trail, readable with the admin key only.

## 8. Automated decisions

The gateway allows, asks for verification, denies or escalates without a person in the loop. `deny` and
`escalate` come with a sentence that hands the caller to a colleague; providing that colleague is up to
you. Whether this is a decision "based solely on automated processing" with legal or similarly
significant effect in your use is a question for your counsel.

## 9. Security measures in the gateway, and those left to you

In the gateway:

- Separate credentials for the agent host, the protected tool, the MFA backend and the operator; none
  opens another's routes. Keys and signatures are compared in constant time.
- What a caller says is passed to the scorer as data. It is not interpreted as an instruction by the
  gateway.
- A scorer that fails or is late counts as maximum risk.
- In the Docker image the process runs as a non-root user.

Left to you:

- TLS (the gateway listens on plain HTTP).
- Encryption at rest and backups of the SQLite file.
- Network placement: the gateway has no rate limiting and should not face the internet directly.
- Key storage and rotation: the keys are static values in environment variables.
- Access to the counterparties file, which decides where verifications are sent.
- Telling callers that the call is analysed.

## 10. Not in this version

- No scheduled retention or expiry-based deletion (section 3).
- No per-caller deletion or export.
- No multi-tenancy: one gateway serves one set of counterparties and policies. Rows carry no tenant id.
- No encryption of the database by the gateway.
- No audit of who read the audit trail.
