from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional


@dataclass(frozen=True)
class ChallengeRef:
    """What the agent host learns about an open challenge: its id and expiry, nothing else."""

    id: str
    expires_at: str


@dataclass(frozen=True)
class GuardDecision:
    #: `allow`, `verify_first`, `deny` or `escalate`.
    decision: str
    reasons: List[str]
    spoken_reply: str
    grant_id: Optional[str]
    challenge: Optional[ChallengeRef]

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> "GuardDecision":
        challenge = data.get("challenge")
        return cls(
            decision=data["decision"],
            reasons=list(data.get("reasons") or []),
            spoken_reply=data.get("spokenReply", ""),
            grant_id=data.get("grantId"),
            challenge=ChallengeRef(id=challenge["id"], expires_at=challenge["expiresAt"]) if challenge else None,
        )


@dataclass(frozen=True)
class Challenge:
    """The `verification.requested` webhook the MFA backend receives."""

    id: str
    conversation_id: str
    counterparty_id: str
    action: str
    params_hash: str
    #: The suggested method: `callback`, `app`, `otp`, `passkey` or `human`.
    kind: str
    #: Where the check goes, taken from the counterparty record.
    target: str
    expires_at: str

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> "Challenge":
        return cls(
            id=data["challengeId"],
            conversation_id=data["conversationId"],
            counterparty_id=data["counterpartyId"],
            action=data["action"],
            params_hash=data["paramsHash"],
            kind=data["kind"],
            target=data["target"],
            expires_at=data["expiresAt"],
        )


@dataclass(frozen=True)
class ConsumeResult:
    ok: bool
    counterparty_id: Optional[str] = None
    verified_by: Optional[Any] = None
    #: Why the gateway refused, when `ok` is False.
    reason: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict, compare=False, repr=False)
