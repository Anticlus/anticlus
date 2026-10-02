"""End-to-end check against a running gateway.

Environment: ANTICLUS_AGENT_KEY, ANTICLUS_TOOL_KEY, ANTICLUS_ADMIN_KEY, ANTICLUS_MFA_SECRET,
and optionally ANTICLUS_URL (default http://127.0.0.1:8787).
"""

from __future__ import annotations

import os
import sys
import uuid

from anticlus import AdminClient, AgentClient, MfaClient, ToolClient

URL = os.environ.get("ANTICLUS_URL", "http://127.0.0.1:8787")
ACTION = "update_contact_person"
PARAMS = {"phone": "+3225550199"}


def fail(message: str) -> "None":
    print(f"FAIL: {message}")
    sys.exit(1)


def main() -> None:
    agent = AgentClient(URL, os.environ["ANTICLUS_AGENT_KEY"])
    tool = ToolClient(URL, os.environ["ANTICLUS_TOOL_KEY"])
    admin = AdminClient(URL, os.environ["ANTICLUS_ADMIN_KEY"])
    mfa = MfaClient(URL, os.environ["ANTICLUS_MFA_SECRET"])
    conversation = f"pycheck-{uuid.uuid4().hex[:12]}"
    print(f"gateway: {URL}  conversation: {conversation}")

    agent.add_turn(
        conversation,
        "caller",
        "Hello, Sophie Maes from Acme Industrial. I would like to update our contact phone number.",
    )
    print("1. add_turn: 204")

    first = agent.guard(conversation, ACTION, PARAMS)
    print(f"2. guard: decision={first.decision} reasons={first.reasons} grantId={first.grant_id} challenge={first.challenge}")
    print(f"   spokenReply: {first.spoken_reply}")
    if first.decision != "verify_first" or first.challenge is None:
        fail("expected verify_first with a challenge")
    assert first.challenge is not None

    mfa.answer(first.challenge.id, True, method="otp", note="live_check.py")
    print(f"3. answer: challenge {first.challenge.id} recorded as passed")

    second = agent.guard(conversation, ACTION, PARAMS)
    print(f"4. guard: decision={second.decision} reasons={second.reasons} grantId={second.grant_id}")
    print(f"   spokenReply: {second.spoken_reply}")
    if second.decision != "allow" or second.grant_id is None:
        fail("expected allow with a grant")
    assert second.grant_id is not None

    result = tool.consume_grant(second.grant_id, conversation, ACTION, PARAMS)
    print(f"5. consume_grant: ok={result.ok} counterpartyId={result.counterparty_id} verifiedBy={result.verified_by} reason={result.reason}")
    if not result.ok:
        fail("expected the grant to be consumed")

    again = tool.consume_grant(second.grant_id, conversation, ACTION, PARAMS)
    print(f"6. consume_grant again: ok={again.ok} reason={again.reason}")

    rows = admin.audit(conversation)
    print(f"7. audit: {len(rows)} rows")

    agent.end_conversation(conversation)
    print("8. end_conversation: 204")
    print("OK")


if __name__ == "__main__":
    main()
