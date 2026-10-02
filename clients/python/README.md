# anticlus (Python client)

Python client for the Anticlus gateway. One class per caller of the gateway:
`AgentClient` (agent host), `ToolClient` (protected tool), `MfaClient` (the
client's MFA backend) and `AdminClient` (audit trail). Requires Python 3.9 or
later; the only runtime dependency is `httpx`.

## Install

```bash
pip install -e clients/python            # from the repository root
pip install -e "clients/python[dev]"     # with pytest
```

## Agent host

```python
from anticlus import AgentClient

agent = AgentClient("http://127.0.0.1:8787", agent_key="...")
conversation = "call-42"  # bound by the host to the call, never taken from the model

agent.add_turn(conversation, "caller", "Hello, I would like to update our phone number.")

decision = agent.guard(conversation, "update_contact_person", {"phone": "+3225550199"})
say(decision.spoken_reply)

if decision.decision == "allow":
    # Hand the grant to the protected tool with the same action and params.
    run_tool(decision.grant_id, conversation, {"phone": "+3225550199"})
elif decision.decision == "verify_first":
    # The gateway opened a challenge and sent it to the MFA backend.
    # Call guard again with the same action and params once it was answered.
    print(decision.challenge.id, decision.challenge.expires_at)
else:  # "deny" or "escalate"
    print(decision.reasons)

agent.end_conversation(conversation)  # when the call is over
```

## Protected tool

```python
from anticlus import GrantRefused, ToolClient, guarded

tool = ToolClient("http://127.0.0.1:8787", tool_key="...")

# Explicit: a refusal (409) is returned, not raised.
result = tool.consume_grant(grant_id, conversation_id, "update_contact_person", params)
if result.ok:
    print(result.counterparty_id, result.verified_by)
else:
    print("refused:", result.reason)

# Decorator: the grant is consumed first; the function runs only if that succeeded.
@guarded(tool, "update_contact_person")
def update_contact_person(params):
    crm.set_phone(params["phone"])

try:
    update_contact_person(grant_id, conversation_id, params)
except GrantRefused as refused:
    print("refused:", refused.reason)
```

A grant is bound to one conversation, one action and the exact params, and is
consumed once.

## MFA backend

```python
from anticlus import ApiError, InvalidSignature, MfaClient

mfa = MfaClient("http://127.0.0.1:8787", secret="...")

def handle_webhook(raw_body: bytes, headers) -> int:
    # Pass the body as received, before any JSON parsing.
    try:
        challenge = mfa.verify_webhook(raw_body, headers.get("anticlus-signature"))
    except InvalidSignature:
        return 401

    # Run your own check against challenge.target (from the counterparty record).
    passed = run_check(challenge.kind, challenge.target, challenge.action)

    try:
        mfa.answer(challenge.id, passed, method="otp", note="code confirmed")
    except ApiError as err:
        # err.error: bad_signature, unknown_challenge, already_answered, expired
        log(err.status_code, err.error)
    return 200
```

`method` is one of `callback`, `app`, `otp`, `passkey`, `human`; it defaults to
the kind the challenge suggested.

## Signatures

`sign(secret, body, at_ms)` returns `t=<unix ms>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`.
`verify_signature(secret, body, header, now_ms, tolerance_ms=300000)` returns
`None` or raises `InvalidSignature` with `.reason` set to `missing`,
`malformed`, `stale` or `mismatch`. The comparison is constant-time.

## Audit

```python
from anticlus import AdminClient

rows = AdminClient("http://127.0.0.1:8787", admin_key="...").audit(conversation_id="call-42")
```

## Errors

Any status a method does not accept raises `ApiError` (`.status_code`,
`.error`, `.body`). Network failures raise the underlying `httpx` exception.
Every client accepts `http_client=httpx.Client(...)`, which is how the tests
inject `httpx.MockTransport`.

## Tests

```bash
cd clients/python
uv venv .venv && uv pip install -p .venv -e ".[dev]"
.venv/bin/pytest
```

`examples/live_check.py` runs the whole flow against a real gateway. It reads
`ANTICLUS_AGENT_KEY`, `ANTICLUS_TOOL_KEY`, `ANTICLUS_ADMIN_KEY`,
`ANTICLUS_MFA_SECRET` and optionally `ANTICLUS_URL` (default
`http://127.0.0.1:8787`); the gateway must be started with
`examples/counterparties.json`.
