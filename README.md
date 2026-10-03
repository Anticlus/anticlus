# Anticlus

Anticlus is an authorization gateway for voice agents. It exists so that an AI voice agent can be given
the permissions it is usually denied: changing a supplier's bank account, releasing a payment, updating
contact details. Those stay with humans today because nothing said on a call can be trusted.

The gateway sits between the agent and those actions. Before each protected action the agent's host asks
the gateway, and the primary control is **verification outside the call**: a signed challenge to the MFA
system the company already has (an app push, a one-time code, a callback to the number on file), bound to
the exact action and parameters. On `allow` the gateway issues a single-use grant for those parameters, and
the protected tool consumes it before it acts. Nothing the caller says, and nothing the model outputs, can
produce a grant by itself.

Detection comes second. The gateway matches the caller against the records on file and reads the call for
social engineering, and that decides *whom* to verify with, whether verification is possible at all (an
unknown caller or "the CEO" gets `deny` or `escalate`, not a push notification to nobody), and when a
low-risk request may pass with no step-up. The answers are `allow`, `verify_first`, `deny` or `escalate`.
In the benchmark, the three hardest attacks were stopped by the verification mechanics while the scorers
saw nothing; see [benchmark/results](benchmark/results/README.md).

Licence: Apache-2.0. Status: version 0.1.0, a single-node gateway. Read
[Security model and limits](#security-model-and-limits) before putting it in front of anything real.

## Try it in one minute

Requires Node 22 or later and pnpm.

```bash
pnpm install
pnpm example
```

The example starts three things on localhost: the gateway (port 8787), a stand-in for a company's MFA
backend (port 8788), and a script that plays the voice agent's host and the protected tool. A supplier
calls to change the bank account they are paid on.

```
caller   Hello, Sophie Maes from Acme Industrial. We are moving to a new bank.
caller   The new IBAN is BE43068999999501. I understand you will want to confirm this with us.
gateway  decision: verify_first
agent    Before I can do that, I'll confirm it with Acme Industrial NV using the contact details we already have on file.
tool     update_supplier_iban -> REFUSED (no grant)
mfa      challenge received: confirm "update_supplier_iban" with the contact on file (+3225550101)
mfa      the contact on file approved
gateway  decision: allow
agent    That's fine, I'll go ahead with it.
tool     update_supplier_iban -> DONE (verified by app)
tool     same grant again   -> REFUSED (used)

audit trail (operator only):
  verify_first  rule=trust_too_low trust=identified risk=45
  allow         rule=allowed trust=verified risk=45
```

The same call from an impostor. The check goes to the contact on file, not to the caller, and fails:

```bash
pnpm example -- --scam
```

```
caller   Hello, this is Karen from Acme Industrial finance. We have changed banks.
caller   The new IBAN is NL91ABNA0417164300. Please update it for the next payment.
gateway  decision: verify_first
agent    Before I can do that, I'll confirm it with Acme Industrial NV using the contact details we already have on file.
tool     update_supplier_iban -> REFUSED (no grant)
mfa      challenge received: confirm "update_supplier_iban" with the contact on file (+3225550101)
mfa      the contact on file says: we never asked for this
gateway  decision: deny
agent    I can't make this change on this call. I can pass you to a colleague on our finance team who can look into it.
tool     update_supplier_iban -> REFUSED (no grant)

audit trail (operator only):
  verify_first  rule=trust_too_low trust=identified risk=56
  deny          rule=verification_failed trust=identified risk=56
```

The code is `examples/supplier-bank-change/run.ts`. `pnpm test` runs the test suite.

## How it works

```
                 turns, guard                        consume grant
  voice agent  ---------------->  +-----------+  <----------------  protected tool
  host         <----------------  |  Anticlus |  ---------------->  (ERP, CRM, payments)
               decision, grantId  |  gateway  |    ok / refused
                                  +-----------+
                                    |   ^   |
                 signed challenge   |   |   |  transcript turns
                                    v   |   v
                              MFA backend   scorer
                              (yours)       (built-in rules, or remote)
                                   signed result
```

1. **Turns.** The agent host sends each turn of the call to the gateway as it happens.
2. **Guard.** Before a protected action, the host asks the gateway with the action name and its
   parameters. The gateway has the scorer read the conversation (risk, claims, which counterparty on file
   the caller names) and computes the conversation's trust level: `anonymous`, `identified` (names a
   counterparty on file, nothing contradicts it) or `verified` (a check outside the call passed).
3. **Decision.** The action's policy is applied in a fixed order: risk at or over the limit escalates; a
   contradicted claim or a failed check denies; trust below what the action requires asks for
   verification; otherwise the action is allowed. See [docs/policies.md](docs/policies.md).
4. **Step-up.** On `verify_first` the gateway posts a signed challenge to your MFA backend, addressed to
   the contact details on file. The backend posts a signed result back. The agent has no part in this.
   See [docs/mfa.md](docs/mfa.md).
5. **Grant.** On `allow` the gateway issues a grant: one conversation, one action, the hash of the exact
   parameters, valid for 120 seconds, usable once. The protected tool calls the gateway to consume it
   and acts only if that succeeds.

The answer to the agent carries a decision, a sentence to say, and a grant id on `allow`. It never carries
the score, the rule or the verification target; those go to the audit trail.

Anything unknown, late or broken fails closed: an action without a policy is denied, and a scorer that
errors or takes more than 2 seconds counts as maximum risk.

## Run the gateway

The gateway is configured through environment variables and two JSON files.

| Variable | Required | Meaning |
|---|---|---|
| `ANTICLUS_COUNTERPARTIES` | yes | Path to the counterparties file |
| `ANTICLUS_AGENT_KEY` | yes | Bearer key of the agent host |
| `ANTICLUS_TOOL_KEY` | yes | Bearer key of the protected tool |
| `ANTICLUS_ADMIN_KEY` | yes | Bearer key for the audit trail |
| `ANTICLUS_MFA_SECRET` | yes | HMAC secret shared with your MFA backend |
| `ANTICLUS_MFA_WEBHOOK_URL` | no | Where challenges are posted. Without it, a challenge is only returned to the agent host |
| `ANTICLUS_POLICIES` | no | Path to the policies file. Without it, four built-in defaults apply (see the note below) |
| `ANTICLUS_SCORER_URL` | no | A remote scorer. Without it, the built-in rules are used |
| `ANTICLUS_SCORER_TIMEOUT_MS` | no | How long a scorer may take before the call counts as maximal risk (default 2000; set 4000 or more for an LLM-backed scorer) |
| `ANTICLUS_SCORER_KEY` | no | Bearer key sent to the remote scorer |
| `ANTICLUS_DB` | no | SQLite file. Default `anticlus.db` in the working directory; `/data/anticlus.db` in the Docker image |
| `PORT` | no | Default `8787` |

The gateway refuses to start when a required variable is missing or a file does not validate.

Set `ANTICLUS_POLICIES` when you use the built-in scorer. The built-in default for `update_supplier_iban`
waits for a web fact-check that the built-in scorer cannot do, so it never allows a new account;
`examples/policies.json` is a set that works with the built-in rules.

### From source

```bash
export ANTICLUS_AGENT_KEY=$(openssl rand -hex 32)
export ANTICLUS_TOOL_KEY=$(openssl rand -hex 32)
export ANTICLUS_ADMIN_KEY=$(openssl rand -hex 32)
export ANTICLUS_MFA_SECRET=$(openssl rand -hex 32)
export ANTICLUS_COUNTERPARTIES=examples/counterparties.json
export ANTICLUS_POLICIES=examples/policies.json

pnpm start                         # runs src/cli.ts with tsx
# or
pnpm build && node dist/cli.js
```

```
anticlus gateway on http://127.0.0.1:8787
scorer: built-in rules; policies: 4
```

### Docker

```bash
docker build -t anticlus:dev .

docker run -d --name anticlus -p 8787:8787 \
  -e ANTICLUS_AGENT_KEY -e ANTICLUS_TOOL_KEY -e ANTICLUS_ADMIN_KEY -e ANTICLUS_MFA_SECRET \
  -e ANTICLUS_COUNTERPARTIES=/config/counterparties.json \
  -e ANTICLUS_POLICIES=/config/policies.json \
  -v "$PWD/examples/counterparties.json:/config/counterparties.json:ro" \
  -v "$PWD/examples/policies.json:/config/policies.json:ro" \
  -v anticlus-data:/data \
  anticlus:dev
```

The image runs as the non-root `node` user, keeps its SQLite file on the `/data` volume, listens on 8787
and has a health check on `/healthz`. It contains no counterparties file: mount your own.

With Compose, which reads the four secrets from the environment (or a `.env` file) and mounts the two
example files:

```bash
docker compose up -d --build
```

Check it:

```bash
curl http://127.0.0.1:8787/healthz
# {"ok":true}

curl -X POST http://127.0.0.1:8787/v1/guard \
  -H "authorization: Bearer $ANTICLUS_AGENT_KEY" -H 'content-type: application/json' \
  -d '{"conversationId":"call-1","action":"get_opening_hours"}'
# {"decision":"allow","reasons":["Request approved."],"spokenReply":"That's fine, I'll go ahead with it.","grantId":"b855dc17-…","challenge":null}
```

## HTTP API

| Route | Who calls it | Credential |
|---|---|---|
| `GET /healthz` | Anyone | None |
| `POST /v1/conversations/{id}/turns` | Agent host | Bearer `ANTICLUS_AGENT_KEY` |
| `POST /v1/guard` | Agent host | Bearer `ANTICLUS_AGENT_KEY` |
| `DELETE /v1/conversations/{id}` | Agent host, when the call ends | Bearer `ANTICLUS_AGENT_KEY` |
| `POST /v1/verifications` | Your MFA backend | `anticlus-signature` header, HMAC under `ANTICLUS_MFA_SECRET` |
| `POST /v1/grants/{id}/consume` | Protected tool | Bearer `ANTICLUS_TOOL_KEY` |
| `GET /v1/audit` | Operator | Bearer `ANTICLUS_ADMIN_KEY` |

No credential opens another caller's routes: the agent key cannot record a verification or consume a
grant, and the tool key cannot ask for a decision. Requests, responses and error codes for every route are
in [docs/api.md](docs/api.md).

## The MFA webhook

On `verify_first` for a caller matched to a counterparty on file, the gateway posts this to
`ANTICLUS_MFA_WEBHOOK_URL`:

```json
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

`target` is the official phone number in the counterparty record, never a number given on the call. The
request carries a signature header:

```
anticlus-signature: t=<unix ms>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

Your backend verifies the signature (timestamp within 5 minutes), answers 2xx, runs its own check, and
posts the result to the gateway signed the same way:

```bash
BODY='{"challengeId":"'"$CHALLENGE_ID"'","passed":true,"method":"otp"}'
T=$(node -e 'console.log(Date.now())')
MAC=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$ANTICLUS_MFA_SECRET" | awk '{print $NF}')

curl -X POST http://127.0.0.1:8787/v1/verifications \
  -H "anticlus-signature: t=$T,v1=$MAC" -d "$BODY"
# {"recorded":true}
```

A challenge is bound to one conversation, one action and the hash of its parameters, expires after
10 minutes and accepts one answer. A passed result counts for 10 minutes, for that action and those
parameters only. A failed result denies changes for that counterparty for the rest of the conversation.
The webhook is sent once, with a 5-second timeout and no retry. The full flow, a test vector and the
failure cases are in [docs/mfa.md](docs/mfa.md).

## MCP proxy mode

If the agent reaches its tools over MCP, the gateway can front an existing MCP server without changing
it. The agent connects to `anticlus-mcp-proxy` instead of the real server:

```
agent --MCP (stdio)--> anticlus-mcp-proxy --MCP--> your MCP server (unchanged)
                              |
                              +--HTTP--> gateway
```

The proxy lists the upstream's tools unchanged. On each tool call it asks the gateway to guard the call
(the tool name is the action, the arguments are the parameters), consumes the grant, and only then
forwards the call. Anything else (`verify_first`, `deny`, `escalate`, a refused grant, the gateway
unreachable) is answered by the proxy with `NOT EXECUTED` and the sentence the agent may say, and never
reaches the upstream.

```bash
pnpm build

export ANTICLUS_URL=http://127.0.0.1:8787
export ANTICLUS_AGENT_KEY=... ANTICLUS_TOOL_KEY=...
export ANTICLUS_CONVERSATION_ID=call-123        # set by the host, one proxy process per call

node dist/mcp-proxy-cli.js -- node ./your-mcp-server.js        # upstream over stdio
node dist/mcp-proxy-cli.js --url https://mcp.internal.example/mcp   # upstream over streamable HTTP (not run)
```

Things to know:

- Every upstream tool needs a policy named after it. A tool without one is denied.
- Arguments are flattened to strings for the policy and the grant: a string stays as it is, any other
  value is JSON-encoded, `null` and missing values are dropped.
- The conversation id comes from the proxy's environment, never from the tool arguments, so the model
  cannot choose which conversation it is judged on.
- The proxy holds both the agent key and the tool key. The upstream must be reachable only through the
  proxy; if the agent can reach it directly, nothing is enforced.
- The host still sends the call's turns to `POST /v1/conversations/{id}/turns`. The proxy does not see
  the conversation.

`pnpm example:mcp` and `pnpm example:mcp -- --scam` run the bank-change call through the proxy
(`examples/mcp-proxy/run.ts`); see [examples/README.md](examples/README.md) for the output.

## Python client

[clients/python](clients/python) has a Python client with one class per caller: `AgentClient`,
`ToolClient` (with a `@guarded` decorator that consumes the grant before the function runs), `MfaClient`
(verifies the webhook, signs the answer) and `AdminClient`. Install and usage are in
[clients/python/README.md](clients/python/README.md). Its commands were not run for this README.

## Policies and counterparties

Two JSON files, both validated at start and read once.

**Counterparties** (`ANTICLUS_COUNTERPARTIES`): the parties the company knows, with their official
details. Verification only ever goes to these details.

```json
[
  {
    "id": "acme",
    "name": "Acme Industrial NV",
    "registryNumber": "0999.000.001",
    "officialPhone": "+3225550101",
    "officialDomain": "acme-industrial.example",
    "bankAccounts": [{ "iban": "BE68539007547034", "verifiedBy": "onboarding" }],
    "contactPerson": "Sophie Maes"
  }
]
```

**Policies** (`ANTICLUS_POLICIES`): one entry per protected action.

```json
[
  {
    "action": "update_supplier_iban",
    "tier": 3,
    "requiredTrust": "verified",
    "riskLimit": 60,
    "needsFactCheck": false,
    "parameterKeys": ["iban"]
  }
]
```

| Field | Meaning |
|---|---|
| `action` | The name used in guard and consume calls (the MCP tool name in proxy mode) |
| `tier` | 0 information, 1 account data, 2 changes, 3 money |
| `requiredTrust` | `anonymous`, `identified` or `verified` |
| `riskLimit` | Risk (0 to 100) at or above which the decision is `escalate` |
| `needsFactCheck` | Wait for a confirmed claim on the action's parameters. Needs a scorer that checks claims |
| `parameterKeys` | Parameters a claim can touch; a contradicted claim on one denies the action |

Working files are in [examples/](examples): `counterparties.json` (three fictional suppliers) and
`policies.json`. Field limits, the trust levels and the decision order are in
[docs/policies.md](docs/policies.md).

## What is open here, and what a hosted scorer adds

Everything needed to run the gateway is in this repository: the decision logic, grants, the MFA
challenge flow, the SQLite store, the audit trail, the MCP proxy, the Python client, and a built-in
scorer made of keyword rules.

The scorer is a plug-in point. With `ANTICLUS_SCORER_URL` set, the gateway posts the conversation to that
URL instead of using the built-in rules, and expects a score in the format described in
[docs/api.md](docs/api.md#the-remote-scorer-contract). You can put your own scorer there. A hosted scorer
is where the parts that need outside data or models belong:

- a web fact-check of the phone numbers and IBANs a caller claims, which is what `needsFactCheck`
  policies wait for;
- a larger library of scam patterns than the built-in rules;
- synthetic-voice detection.

None of those three is in this repository. A remote scorer receives the full transcript of each guarded
call; see [docs/data-handling.md](docs/data-handling.md). The scorer only reports risk and claims: trust
and the decision stay in the gateway, and a scorer that fails counts as maximum risk.

## Benchmark

The benchmark asks one question: when a caller talks a voice agent into requesting a protected action,
does the action run? It plays matched pairs of scam and legitimate calls, in English and French, against
a system under test and reports the attack success rate together with the false refusal rate, since
either one alone is trivial to drive to zero. The task, the scenarios, the metrics and the limits of the
current version are in [benchmark/SPEC.md](benchmark/SPEC.md), and the result files are in
[benchmark/results/](benchmark/results); `pnpm bench` runs the built-in rules on the transcripts.

Held-out set, 20 calls, nothing tuned on it:

| System | Input | Attack success | False refusals | Median decision time |
|---|---|---|---|---|
| This gateway, built-in rules | transcript or audio | 2/10 | 3/10 | about 1 ms |
| LLM judge, claude-haiku-4-5 | transcript | 0/10 | 1/10 | 1152 ms |
| LLM judge, claude-sonnet-5-5 | transcript | 0/10 | 0/10 | 3101 ms |
| This gateway with the hosted LLM scorer | transcript | 0/10 | 1/10 to 2/10 | tens of ms when pre-scored |

The built-in keyword rules are weaker than an LLM judge on hard calls, and far faster. The full tables, the
five calls the rules got wrong and the limits of these numbers are in
[benchmark/results/README.md](benchmark/results/README.md).

## Security model and limits

What the design relies on:

- **The model is not trusted.** The agent can ask; it cannot grant. A decision needs the agent key, a
  verification needs the MFA secret, and executing needs a grant that the tool checks with its own key.
- **The conversation is evidence, not instruction.** What the caller says can raise the risk. It cannot
  raise trust: only a signed result from the MFA backend does.
- **Verification goes to the record on file.** The target of a challenge comes from the counterparties
  file, never from the call.
- **Grants are narrow.** One conversation, one action, one exact set of parameters, 120 seconds, one use.
- **Failures close.** Unknown action: deny. Scorer error or timeout: maximum risk. Gateway unreachable in
  proxy mode: not executed.

What it does not do, in this version:

- **The built-in scorer is keyword rules, in English and French.** It is a set of regular expressions.
  A caller who avoids the listed phrases, or speaks another language, scores low. The gateway does not
  depend on the score to refuse a change (an unverified caller is still asked to verify), but risk-based
  escalation is only as good as the scorer.
- **Enforcement is in the tool.** The gateway cannot stop a tool that does not consume a grant, or an
  agent that can reach the tool by another path.
- **The conversation id must be set by the host, never by the model.** If the model can choose it, an
  injected prompt can point a request at another conversation, for example one where a verification
  passed.
- **Turns are what the host sends.** The gateway cannot tell whether the host sent every turn, or sent
  them truthfully. The agent key can end a conversation, which deletes its turns; an ended conversation id cannot be reused (410 `conversation_ended`), so ending a call does not shed a failed verification.
- **Keys are static bearer tokens** from environment variables: one per role, no scopes, no rotation
  without a restart, no per-client keys. The MFA secret is likewise a single shared value.
- **No rate limiting**, no request-size limit of its own, and plain HTTP. Put it on a private network
  behind TLS.
- **SQLite, single node.** One process, one file. No replication, no high availability, no multi-tenancy.
- **No retention job.** Turns are deleted only when the host calls `DELETE /v1/conversations/{id}`;
  audit rows are kept indefinitely. See [docs/data-handling.md](docs/data-handling.md).
- **The MFA webhook is sent once.** There is no retry and no delivery queue.
- **Spoken replies are fixed English sentences** written for an accounts-payable desk.
- **A hash is not secrecy.** Parameter hashes in the audit trail are unsalted SHA-256; a known IBAN can
  be matched against them.
- The code has had no external security review.

## Documentation

- [docs/api.md](docs/api.md): every route, with requests, responses and error codes
- [docs/mfa.md](docs/mfa.md): the step-up flow and the signature scheme
- [docs/policies.md](docs/policies.md): policies, trust levels, the decision order
- [docs/data-handling.md](docs/data-handling.md): what is stored, what leaves the machine (draft)
- [examples/README.md](examples/README.md): the runnable examples
- [benchmark/SPEC.md](benchmark/SPEC.md): the benchmark

## Why the name

Anticlus was one of the Greeks hidden inside the Trojan horse. In book 4 of the *Odyssey*, Helen walks
around the horse imitating the voices of the men's wives. The others keep silent; Anticlus is about to
answer, and Odysseus holds a hand over his mouth until she has gone. The gateway does the same job for
an agent that is about to answer a convincing voice.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
