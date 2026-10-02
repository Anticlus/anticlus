from __future__ import annotations

from typing import Any, Optional

import httpx


class AnticlusError(Exception):
    """Base class of the errors this package raises (except `InvalidSignature`)."""


class ApiError(AnticlusError):
    """The gateway answered with a status the call does not accept."""

    def __init__(self, status_code: int, error: Optional[str], body: Any) -> None:
        super().__init__(f"gateway answered {status_code}" + (f": {error}" if error else ""))
        self.status_code = status_code
        #: The gateway's `error` code, e.g. `unauthorized`, `unknown_challenge`, `already_answered`, `expired`.
        self.error = error
        self.body = body

    @classmethod
    def from_response(cls, response: httpx.Response) -> "ApiError":
        try:
            body: Any = response.json()
        except ValueError:
            body = response.text
        error = body.get("error") if isinstance(body, dict) else None
        return cls(response.status_code, error if isinstance(error, str) else None, body)


class GrantRefused(AnticlusError):
    """The gateway refused to consume the grant; the protected function did not run."""

    def __init__(self, reason: Optional[str]) -> None:
        super().__init__(f"grant refused: {reason or 'unknown'}")
        self.reason = reason
