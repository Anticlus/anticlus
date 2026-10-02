"""The `anticlus-signature` header: `t=<unix ms>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`.

The same scheme signs the webhook the gateway sends and the answer posted back.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from typing import Optional, Union

SIGNATURE_HEADER = "anticlus-signature"
SIGNATURE_TOLERANCE_MS = 5 * 60_000

_HEADER = re.compile(r"^t=(\d{1,16}),v1=([0-9a-f]{64})$")

Body = Union[str, bytes]


class InvalidSignature(Exception):
    """The signature header is missing, malformed, stale or does not match the body."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"invalid signature: {reason}")
        #: One of `missing`, `malformed`, `stale`, `mismatch`.
        self.reason = reason


def _mac(secret: str, body: Body, at_ms: int) -> str:
    raw = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    message = str(at_ms).encode("ascii") + b"." + raw
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def sign(secret: str, body: Body, at_ms: int) -> str:
    """Return the header value for `body` signed at `at_ms` (unix milliseconds)."""
    return f"t={at_ms},v1={_mac(secret, body, at_ms)}"


def verify_signature(
    secret: str,
    body: Body,
    header: Optional[str],
    now_ms: int,
    tolerance_ms: int = SIGNATURE_TOLERANCE_MS,
) -> None:
    """Check `header` against the raw `body`. Returns None, or raises `InvalidSignature`.

    `body` must be the bytes received, before any JSON parsing.
    """
    if not header:
        raise InvalidSignature("missing")
    match = _HEADER.match(header.strip())
    if match is None:
        raise InvalidSignature("malformed")
    at_ms = int(match.group(1))
    if abs(now_ms - at_ms) > tolerance_ms:
        raise InvalidSignature("stale")
    expected = _mac(secret, body, at_ms)
    if not hmac.compare_digest(expected.encode("ascii"), match.group(2).encode("ascii")):
        raise InvalidSignature("mismatch")
