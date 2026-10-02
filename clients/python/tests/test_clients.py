import json
from typing import Callable, List

import httpx
import pytest

from anticlus import (
    AdminClient,
    AgentClient,
    ApiError,
    Challenge,
    ConsumeResult,
    GrantRefused,
    InvalidSignature,
    MfaClient,
    ToolClient,
    guarded,
    sign,
    verify_signature,
)

BASE = "http://gateway.test"
NOW = 1700000000000


def client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_add_turn() -> None:
    seen: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    agent = AgentClient(BASE, "agent-key", http_client=client(handler))
    assert agent.add_turn("c 1", "caller", "Hello", at="2026-10-02T10:00:00Z") is None
    request = seen[0]
    assert request.method == "POST"
    assert request.url.raw_path == b"/v1/conversations/c%201/turns"
    assert request.headers["authorization"] == "Bearer agent-key"
    assert json.loads(request.content) == {"role": "caller", "text": "Hello", "at": "2026-10-02T10:00:00Z"}


def test_add_turn_omits_at_and_raises_on_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content) == {"role": "agent", "text": "Hi"}
        return httpx.Response(401, json={"error": "unauthorized"})

    agent = AgentClient(BASE, "bad", http_client=client(handler))
    with pytest.raises(ApiError) as info:
        agent.add_turn("c1", "agent", "Hi")
    assert info.value.status_code == 401
    assert info.value.error == "unauthorized"


def test_guard_verify_first() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/guard"
        assert request.headers["authorization"] == "Bearer agent-key"
        assert json.loads(request.content) == {
            "conversationId": "c1",
            "action": "update_contact_person",
            "params": {"phone": "+3225550199"},
        }
        return httpx.Response(
            200,
            json={
                "decision": "verify_first",
                "reasons": ["sensitive_change"],
                "spokenReply": "I need to verify this first.",
                "grantId": None,
                "challenge": {"id": "ch1", "expiresAt": "2026-10-02T10:10:00.000Z"},
            },
        )

    decision = AgentClient(BASE, "agent-key", http_client=client(handler)).guard(
        "c1", "update_contact_person", {"phone": "+3225550199"}
    )
    assert decision.decision == "verify_first"
    assert not decision.allowed
    assert decision.reasons == ["sensitive_change"]
    assert decision.spoken_reply == "I need to verify this first."
    assert decision.grant_id is None
    assert decision.challenge is not None
    assert decision.challenge.id == "ch1"
    assert decision.challenge.expires_at == "2026-10-02T10:10:00.000Z"


def test_guard_allow_defaults_params() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["params"] == {}
        return httpx.Response(
            200,
            json={"decision": "allow", "reasons": [], "spokenReply": "Done.", "grantId": "g1", "challenge": None},
        )

    decision = AgentClient(BASE, "k", http_client=client(handler)).guard("c1", "read_balance")
    assert decision.allowed and decision.grant_id == "g1" and decision.challenge is None


def test_end_conversation() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert request.url.path == "/v1/conversations/c1"
        return httpx.Response(204)

    assert AgentClient(BASE, "k", http_client=client(handler)).end_conversation("c1") is None


def test_consume_grant_ok() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/grants/g1/consume"
        assert request.headers["authorization"] == "Bearer tool-key"
        assert json.loads(request.content) == {"conversationId": "c1", "action": "pay", "params": {"iban": "BE1"}}
        return httpx.Response(200, json={"ok": True, "counterpartyId": "acme", "verifiedBy": "otp"})

    result = ToolClient(BASE, "tool-key", http_client=client(handler)).consume_grant("g1", "c1", "pay", {"iban": "BE1"})
    assert result == ConsumeResult(ok=True, counterparty_id="acme", verified_by="otp")


def test_consume_grant_409_is_returned_not_raised() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"ok": False, "reason": "already_used"})

    result = ToolClient(BASE, "k", http_client=client(handler)).consume_grant("g1", "c1", "pay")
    assert result.ok is False
    assert result.reason == "already_used"
    assert result.counterparty_id is None


def test_consume_grant_other_errors_raise() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    with pytest.raises(ApiError):
        ToolClient(BASE, "k", http_client=client(handler)).consume_grant("g1", "c1", "pay")


def test_guarded_runs_after_consume_and_raises_when_refused() -> None:
    answers = [
        httpx.Response(200, json={"ok": True, "counterpartyId": "acme", "verifiedBy": None}),
        httpx.Response(409, json={"ok": False, "reason": "params_mismatch"}),
    ]
    calls: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append("consume:" + json.loads(request.content)["action"])
        return answers.pop(0)

    tool = ToolClient(BASE, "k", http_client=client(handler))

    @guarded(tool, "update_contact_person")
    def update_contact(params, suffix: str = "") -> str:
        calls.append("run")
        return params["phone"] + suffix

    assert update_contact("g1", "c1", {"phone": "+32"}, suffix="!") == "+32!"
    assert calls == ["consume:update_contact_person", "run"]

    with pytest.raises(GrantRefused) as info:
        update_contact("g2", "c1", {"phone": "+33"})
    assert info.value.reason == "params_mismatch"
    assert calls.count("run") == 1


WEBHOOK = json.dumps(
    {
        "type": "verification.requested",
        "challengeId": "ch1",
        "conversationId": "c1",
        "counterpartyId": "acme",
        "action": "update_contact_person",
        "paramsHash": "abc",
        "kind": "callback",
        "target": "+3225550101",
        "expiresAt": "2026-10-02T10:10:00.000Z",
    }
)


def mfa(handler: Callable[[httpx.Request], httpx.Response], now: int = NOW) -> MfaClient:
    return MfaClient(BASE, "s3cret", http_client=client(handler), now_ms=lambda: now)


def unreachable(request: httpx.Request) -> httpx.Response:
    raise AssertionError("no request expected")


def test_verify_webhook() -> None:
    challenge = mfa(unreachable).verify_webhook(WEBHOOK.encode(), sign("s3cret", WEBHOOK, NOW - 1000))
    assert challenge == Challenge(
        id="ch1",
        conversation_id="c1",
        counterparty_id="acme",
        action="update_contact_person",
        params_hash="abc",
        kind="callback",
        target="+3225550101",
        expires_at="2026-10-02T10:10:00.000Z",
    )


def test_verify_webhook_tampered() -> None:
    header = sign("s3cret", WEBHOOK, NOW)
    with pytest.raises(InvalidSignature) as info:
        mfa(unreachable).verify_webhook(WEBHOOK.replace("+3225550101", "+3225550199"), header)
    assert info.value.reason == "mismatch"


def test_verify_webhook_stale_and_missing() -> None:
    with pytest.raises(InvalidSignature) as info:
        mfa(unreachable).verify_webhook(WEBHOOK, sign("s3cret", WEBHOOK, NOW - 300_001))
    assert info.value.reason == "stale"
    with pytest.raises(InvalidSignature) as info:
        mfa(unreachable).verify_webhook(WEBHOOK, None)
    assert info.value.reason == "missing"


def test_answer_signs_the_exact_body() -> None:
    seen: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"recorded": True})

    assert mfa(handler).answer("ch1", True, method="otp", note="code ok") is None
    request = seen[0]
    assert request.url.path == "/v1/verifications"
    assert "authorization" not in request.headers
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == {"challengeId": "ch1", "passed": True, "method": "otp", "note": "code ok"}
    verify_signature("s3cret", request.content, request.headers["anticlus-signature"], NOW)
    assert request.headers["anticlus-signature"].startswith(f"t={NOW},v1=")


def test_answer_omits_optional_fields() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content) == {"challengeId": "ch1", "passed": False}
        return httpx.Response(200, json={"recorded": True})

    mfa(handler).answer("ch1", False)


@pytest.mark.parametrize(
    "status,error",
    [(401, "bad_signature"), (404, "unknown_challenge"), (409, "already_answered"), (410, "expired")],
)
def test_answer_errors(status: int, error: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": error})

    with pytest.raises(ApiError) as info:
        mfa(handler).answer("ch1", True)
    assert info.value.status_code == status
    assert info.value.error == error


def test_audit() -> None:
    seen: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"rows": [{"conversationId": "c1", "decision": "allow"}]})

    admin = AdminClient(BASE, "admin-key", http_client=client(handler))
    assert admin.audit("c1") == [{"conversationId": "c1", "decision": "allow"}]
    assert admin.audit() == [{"conversationId": "c1", "decision": "allow"}]
    assert seen[0].headers["authorization"] == "Bearer admin-key"
    assert seen[0].url.params["conversationId"] == "c1"
    assert seen[1].url.query == b""
