# Step-up verification through your MFA system

When the gateway answers `verify_first` for a caller it matched to a counterparty on file, it does not
verify anyone itself. It opens a **challenge**, posts it, signed, to a URL you configure, and waits for a
signed result. Your backend runs whatever check you already have (a push to a registered app, a one-time
code, a passkey, a callback by a person to the number on file) and reports whether it passed.

The voice agent is not part of this exchange. It holds neither the MFA secret nor a route that records a
result, so nothing said on the call can produce a passed verification.

## The flow

```
agent host                gateway                         your MFA backend
    |  POST /v1/guard        |                                   |
    |----------------------->|  decision: verify_first           |
    |<-----------------------|  challenge { id, expiresAt }      |
    |                        |  POST <ANTICLUS_MFA_WEBHOOK_URL>  |
    |                        |  anticlus-signature: t=..,v1=..   |
    |                        |---------------------------------->|  verify signature
    |                        |                          2xx      |  run the check against `target`
    |                        |<----------------------------------|
    |                        |  POST /v1/verifications           |
    |                        |  anticlus-signature: t=..,v1=..   |
    |                        |<----------------------------------|
    |                        |  200 {"recorded":true}            |
    |  POST /v1/guard (same action, same params)                 |
    |----------------------->|                                   |
    |<-----------------------|  allow + grantId   (check passed) |
    |                        |  deny              (check failed) |
```

1. The agent host calls `POST /v1/guard`. The policy needs trust `verified`, the caller is only
   `identified`, so the decision is `verify_first`.
2. The gateway stores a challenge bound to the conversation, the action and the SHA-256 of the exact
   parameters, with the counterparty's official phone number as `target`. It answers the agent host with
   the challenge id and expiry only.
3. The gateway posts the challenge to `ANTICLUS_MFA_WEBHOOK_URL`. The post does not block the answer to
   the agent host.
4. Your backend verifies the signature, runs its check, and posts the result to `POST /v1/verifications`,
   signed with the same secret.
5. The agent host calls guard again with the same action and parameters. A passed check gives `allow` and
   a grant; a failed one gives `deny`.

`pnpm example` runs this flow on localhost with a stand-in MFA backend
(`examples/supplier-bank-change/run.ts`).

## The webhook the gateway sends

```
POST <ANTICLUS_MFA_WEBHOOK_URL>
content-type: application/json
anticlus-signature: t=1790976536024,v1=<64 hex characters>

{
  "type": "verification.requested",
  "challengeId": "88cd8510-7b27-4069-8507-90bccc90d34a",
  "conversationId": "call-42",
  "counterpartyId": "acme",
  "action": "update_supplier_iban",
  "paramsHash": "85df1824e6ac20cef65a6443a804f0f53453cf69ed9ef6b582a8be8100815be4",
  "kind": "callback",
  "target": "+3225550101",
  "expiresAt": "2026-10-02T21:38:39.100Z"
}
```

| Field | Meaning |
|---|---|
| `challengeId` | What you send back in the result |
| `counterpartyId` | The id in your counterparties file |
| `action`, `paramsHash` | What the verification is for. `paramsHash` is the SHA-256 of the parameters as JSON with sorted keys; the values are not sent |
| `kind` | The method the gateway suggests. In this version it is always `callback`. You may use another method and report it |
| `target` | The `officialPhone` of the counterparty record. It is never a number given during the call |
| `expiresAt` | 10 minutes after the challenge was opened |

Answer with any 2xx status. The body of your answer is ignored. The gateway waits 5 seconds, and sends each
challenge once: there is no retry. A non-2xx answer or a timeout is written to the gateway's standard error
with the challenge id; the challenge stays open until it expires, and the agent host still has its id.

When `ANTICLUS_MFA_WEBHOOK_URL` is not set, no webhook is sent. The challenge id is still returned to the
agent host in the guard answer, and a result can still be posted to `/v1/verifications` by whatever holds
the secret.

## The result you send back

```
POST /v1/verifications
anticlus-signature: t=<unix ms>,v1=<hex>

{"challengeId":"88cd8510-7b27-4069-8507-90bccc90d34a","passed":true,"method":"otp","note":"code confirmed"}
```

`method` is one of `callback`, `app`, `otp`, `passkey`, `human` and defaults to the challenge's `kind`.
`note` is optional, at most 300 characters. The statuses are listed in [api.md](api.md#post-v1verifications).

Report a failed check as `"passed": false`. Do not simply drop it: a recorded failure makes the gateway
deny every change (tier 2 and 3 action) for that counterparty for the rest of the conversation, while a
missing result leaves the conversation at `verify_first`.

## The signature scheme

The same scheme is used in both directions, with the secret in `ANTICLUS_MFA_SECRET`.

```
anticlus-signature: t=<t>,v1=<mac>

t    the sender's clock, Unix time in milliseconds, decimal digits
mac  lowercase hex of HMAC-SHA256(key = secret, message = "<t>.<raw body>")
```

The message is the timestamp, a full stop, and the request body **exactly as sent**, byte for byte. Verify
against the raw body before parsing it; re-serialising the JSON changes the bytes and breaks the MAC.

The receiver refuses a signature when:

| Reason | Condition |
|---|---|
| `missing` | No header |
| `malformed` | The header does not match `t=<1 to 16 digits>,v1=<64 lowercase hex characters>` |
| `stale` | `t` differs from the receiver's clock by more than 5 minutes, in either direction |
| `mismatch` | The MAC is not the expected one. Compared in constant time |

### Worked example

Secret `secret`, body `{"a":1}`, `t = 1700000000000`.

The signed message is the 21 bytes `1700000000000.{"a":1}`, and the header is:

```
t=1700000000000,v1=4ef2732b0d632a6897af3a6d02a6de287f60d6c5f15dabdb0ceb045a34e3c5a7
```

Reproduce it:

```bash
printf '%s' '1700000000000.{"a":1}' | openssl dgst -sha256 -hmac secret
# 4ef2732b0d632a6897af3a6d02a6de287f60d6c5f15dabdb0ceb045a34e3c5a7
```

```js
import { createHmac } from 'node:crypto';
createHmac('sha256', 'secret').update('1700000000000.{"a":1}').digest('hex');
```

```python
import hashlib, hmac
hmac.new(b"secret", b'1700000000000.{"a":1}', hashlib.sha256).hexdigest()
```

### Answering a challenge from a shell

```bash
BODY='{"challengeId":"'"$CHALLENGE_ID"'","passed":true,"method":"otp"}'
T=$(node -e 'console.log(Date.now())')
MAC=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$ANTICLUS_MFA_SECRET" | awk '{print $NF}')

curl -X POST http://127.0.0.1:8787/v1/verifications \
  -H "anticlus-signature: t=$T,v1=$MAC" \
  -d "$BODY"
# {"recorded":true}
```

### A webhook receiver in Node

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.ANTICLUS_MFA_SECRET;
const sign = (body, t) => `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;

function verify(rawBody, header) {
  const m = /^t=(\d{1,16}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m || Math.abs(Date.now() - Number(m[1])) > 5 * 60_000) return false;
  const expected = Buffer.from(sign(rawBody, m[1]));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// In your HTTP handler, with the raw request body as a string:
async function onWebhook(rawBody, headers) {
  if (!verify(rawBody, headers['anticlus-signature'])) return 401;
  const challenge = JSON.parse(rawBody);

  const passed = await runYourCheck(challenge.target, challenge.action); // your MFA system

  const body = JSON.stringify({ challengeId: challenge.challengeId, passed, method: 'app' });
  await fetch('http://127.0.0.1:8787/v1/verifications', {
    method: 'POST',
    headers: { 'anticlus-signature': sign(body, Date.now()) },
    body
  });
  return 200;
}
```

`sign` and `verify` above were run against the worked example; `onWebhook` is a sketch around them
(`runYourCheck` is yours). A complete receiver is in `examples/supplier-bank-change/run.ts`, which uses
`sign` and `verifySignature` from `src/mfa.ts`. In
Python, `MfaClient.verify_webhook` and `MfaClient.answer` in `clients/python` do both halves.

## Expiry

| What | Lifetime | Counted from |
|---|---|---|
| Signature timestamp | 5 minutes either side of the receiver's clock | `t` in the header |
| Challenge | 10 minutes | The guard call that opened it |
| Passed verification | 10 minutes | The moment the result was recorded |
| Grant | 120 seconds | The guard call that answered `allow` |

A failed verification does not expire. It counts until the conversation is deleted.

These values are constants in `src/mfa.ts` and `src/gateway/gateway.ts`. The command-line gateway has no
setting for them.

## What binds a verification to an action

A challenge carries the conversation id, the action and the hash of the parameters of the guard call that
opened it. When the result is recorded, the gateway copies those three from the stored challenge, not from
the request, so the MFA backend cannot move a result to another action.

On the next guard call a passed verification counts only when all of these hold:

- it belongs to the same conversation;
- its `action` equals the action being guarded;
- its `paramsHash` equals the hash of the parameters being guarded;
- it has not expired;
- no verification for the same counterparty has failed in this conversation.

So a pass for IBAN X does not open IBAN Y, a pass for `update_supplier_iban` does not open
`update_contact_person`, and a pass in one call does not carry to the next. The grant issued on `allow` is
bound the same way and is consumed once.

## Failure cases

| Situation | What happens |
|---|---|
| The webhook URL is down, slow (over 5 s) or answers non-2xx | Logged on the gateway. No retry. Guard keeps answering `verify_first` with the same challenge until it expires; after that, the next guard call opens a new challenge and sends a new webhook |
| The MFA backend never answers | Same as above: the action is never allowed |
| The result arrives after 10 minutes | `410 expired`. Nothing is recorded |
| The result is sent twice | The second gets `409 already_answered`. The first stands, including when the two disagree |
| The signature is missing, malformed, stale or wrong | `401 bad_signature` with the reason. Nothing is recorded |
| The challenge id is unknown, or the conversation was deleted | `404 unknown_challenge` |
| The check failed (`passed: false`) | Recorded. Later guard calls for tier 2 and 3 actions on that counterparty answer `deny` for the rest of the conversation, whatever a later check says |
| The caller asks for different parameters after a pass | The pass does not match the new hash: `verify_first` again, with a new challenge |
| The agent host calls guard more than 10 minutes after the pass | The pass has expired: `verify_first` again |
| The clocks of the two sides differ by more than 5 minutes | Every signature is `stale`. Keep both hosts on NTP |
| The gateway restarts between challenge and result | Challenges are in SQLite; the result is still accepted |

## What the secret protects, and what it does not

Whoever holds `ANTICLUS_MFA_SECRET` can record a passed verification for any open challenge. Keep it on
the MFA backend and the gateway only; the agent host and the protected tool do not need it. There is one
secret per gateway, with no rotation mechanism other than restarting the gateway with a new value.

A captured signed request can be replayed within the 5-minute window, but a challenge accepts one answer,
so a replayed result gets `409`. A replayed webhook reaches only your own backend; deduplicate on
`challengeId` if a second check would be visible to the counterparty.

The signature authenticates the sender and the body. It does not encrypt: the webhook carries the
counterparty's official phone number, so serve both directions over TLS.
