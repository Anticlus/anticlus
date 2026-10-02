from __future__ import annotations

import functools
import json
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, TypeVar, Union
from urllib.parse import quote

import httpx

from .errors import ApiError, GrantRefused
from .models import Challenge, ConsumeResult, GuardDecision
from .signature import SIGNATURE_HEADER, SIGNATURE_TOLERANCE_MS, InvalidSignature, sign, verify_signature

T = TypeVar("T")
Params = Mapping[str, str]


def _now_ms() -> int:
    return int(time.time() * 1000)


class _Base:
    def __init__(
        self,
        base_url: str,
        bearer: Optional[str],
        http_client: Optional[httpx.Client],
        timeout: float,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer = bearer
        self._owns_client = http_client is None
        self._http = http_client if http_client is not None else httpx.Client(timeout=timeout)

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers: Dict[str, str] = dict(kwargs.pop("headers", None) or {})
        if self._bearer is not None:
            headers["authorization"] = f"Bearer {self._bearer}"
        return self._http.request(method, self._base_url + path, headers=headers, **kwargs)

    def close(self) -> None:
        """Close the HTTP client, unless it was passed in."""
        if self._owns_client:
            self._http.close()

    def __enter__(self: T) -> T:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _seg(value: str) -> str:
    return quote(value, safe="")


class AgentClient(_Base):
    """The agent host: adds turns and asks whether an action may run."""

    def __init__(
        self, base_url: str, agent_key: str, *, http_client: Optional[httpx.Client] = None, timeout: float = 10.0
    ) -> None:
        super().__init__(base_url, agent_key, http_client, timeout)

    def add_turn(self, conversation_id: str, role: str, text: str, at: Optional[str] = None) -> None:
        """Record one turn. `role` is `caller` or `agent`; `at` is an ISO 8601 UTC datetime."""
        body: Dict[str, Any] = {"role": role, "text": text}
        if at is not None:
            body["at"] = at
        response = self._request("POST", f"/v1/conversations/{_seg(conversation_id)}/turns", json=body)
        if response.status_code != 204:
            raise ApiError.from_response(response)

    def guard(self, conversation_id: str, action: str, params: Optional[Params] = None) -> GuardDecision:
        body = {"conversationId": conversation_id, "action": action, "params": dict(params or {})}
        response = self._request("POST", "/v1/guard", json=body)
        if response.status_code != 200:
            raise ApiError.from_response(response)
        return GuardDecision.from_json(response.json())

    def end_conversation(self, conversation_id: str) -> None:
        """The call is over: the gateway drops its turns, open challenges and unused grants."""
        response = self._request("DELETE", f"/v1/conversations/{_seg(conversation_id)}")
        if response.status_code != 204:
            raise ApiError.from_response(response)


class ToolClient(_Base):
    """The protected tool: consumes a grant before it acts."""

    def __init__(
        self, base_url: str, tool_key: str, *, http_client: Optional[httpx.Client] = None, timeout: float = 10.0
    ) -> None:
        super().__init__(base_url, tool_key, http_client, timeout)

    def consume_grant(
        self, grant_id: str, conversation_id: str, action: str, params: Optional[Params] = None
    ) -> ConsumeResult:
        """Consume a grant. A 409 refusal is returned as `ok=False` with its reason, not raised."""
        body = {"conversationId": conversation_id, "action": action, "params": dict(params or {})}
        response = self._request("POST", f"/v1/grants/{_seg(grant_id)}/consume", json=body)
        if response.status_code not in (200, 409):
            raise ApiError.from_response(response)
        try:
            data = response.json()
        except ValueError:
            raise ApiError.from_response(response) from None
        if not isinstance(data, dict):
            raise ApiError.from_response(response)
        if response.status_code == 200 and data.get("ok") is True:
            return ConsumeResult(
                ok=True, counterparty_id=data.get("counterpartyId"), verified_by=data.get("verifiedBy"), raw=data
            )
        return ConsumeResult(ok=False, reason=data.get("reason"), raw=data)


class MfaClient(_Base):
    """The client's MFA backend: verifies the challenge webhook and posts the signed result."""

    def __init__(
        self,
        base_url: str,
        secret: str,
        *,
        http_client: Optional[httpx.Client] = None,
        timeout: float = 10.0,
        now_ms: Callable[[], int] = _now_ms,
    ) -> None:
        super().__init__(base_url, None, http_client, timeout)
        self._secret = secret
        self._now_ms = now_ms

    def verify_webhook(
        self,
        raw_body: Union[str, bytes],
        signature_header: Optional[str],
        tolerance_ms: int = SIGNATURE_TOLERANCE_MS,
    ) -> Challenge:
        """Verify the signature over the raw request body, then parse it. Raises `InvalidSignature`."""
        verify_signature(self._secret, raw_body, signature_header, self._now_ms(), tolerance_ms)
        try:
            data = json.loads(raw_body)
            if data.get("type") != "verification.requested":
                raise ValueError(f"unexpected webhook type: {data.get('type')!r}")
            return Challenge.from_json(data)
        except (AttributeError, KeyError) as exc:
            raise ValueError(f"malformed webhook body: {exc}") from exc

    def answer(
        self, challenge_id: str, passed: bool, method: Optional[str] = None, note: Optional[str] = None
    ) -> None:
        """Report the result of a challenge.

        Raises `ApiError` with `.error` set to `bad_signature` (401), `unknown_challenge` (404),
        `already_answered` (409) or `expired` (410).
        """
        body: Dict[str, Any] = {"challengeId": challenge_id, "passed": passed}
        if method is not None:
            body["method"] = method
        if note is not None:
            body["note"] = note
        raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = {"content-type": "application/json", SIGNATURE_HEADER: sign(self._secret, raw, self._now_ms())}
        response = self._request("POST", "/v1/verifications", content=raw, headers=headers)
        if response.status_code != 200:
            raise ApiError.from_response(response)


class AdminClient(_Base):
    """Reads the audit trail."""

    def __init__(
        self, base_url: str, admin_key: str, *, http_client: Optional[httpx.Client] = None, timeout: float = 10.0
    ) -> None:
        super().__init__(base_url, admin_key, http_client, timeout)

    def audit(self, conversation_id: Optional[str] = None) -> List[Dict[str, Any]]:
        params = {"conversationId": conversation_id} if conversation_id is not None else None
        response = self._request("GET", "/v1/audit", params=params)
        if response.status_code != 200:
            raise ApiError.from_response(response)
        rows: List[Dict[str, Any]] = response.json()["rows"]
        return rows


def guarded(tool: ToolClient, action: str) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """Decorate a protected function so it runs only after its grant was consumed.

    The decorated function is called as `fn(grant_id, conversation_id, params, *args, **kwargs)`;
    the wrapped one receives `fn(params, *args, **kwargs)`. Raises `GrantRefused` when the
    gateway refuses, and the wrapped function does not run.
    """

    def decorate(fn: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(fn)
        def wrapper(grant_id: str, conversation_id: str, params: Params, *args: Any, **kwargs: Any) -> T:
            result = tool.consume_grant(grant_id, conversation_id, action, params)
            if not result.ok:
                raise GrantRefused(result.reason)
            return fn(params, *args, **kwargs)

        return wrapper

    return decorate


__all__ = ["AgentClient", "ToolClient", "MfaClient", "AdminClient", "guarded", "InvalidSignature"]
