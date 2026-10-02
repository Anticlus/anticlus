"""Python client for the Anticlus authorization gateway."""

from .clients import AdminClient, AgentClient, MfaClient, ToolClient, guarded
from .errors import AnticlusError, ApiError, GrantRefused
from .models import Challenge, ChallengeRef, ConsumeResult, GuardDecision
from .signature import SIGNATURE_HEADER, SIGNATURE_TOLERANCE_MS, InvalidSignature, sign, verify_signature

__version__ = "0.1.0"

__all__ = [
    "AdminClient",
    "AgentClient",
    "AnticlusError",
    "ApiError",
    "Challenge",
    "ChallengeRef",
    "ConsumeResult",
    "GrantRefused",
    "GuardDecision",
    "InvalidSignature",
    "MfaClient",
    "SIGNATURE_HEADER",
    "SIGNATURE_TOLERANCE_MS",
    "ToolClient",
    "guarded",
    "sign",
    "verify_signature",
]
