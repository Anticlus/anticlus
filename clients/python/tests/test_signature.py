import pytest

from anticlus import InvalidSignature, sign, verify_signature

T = 1700000000000
VECTOR = "t=1700000000000,v1=4ef2732b0d632a6897af3a6d02a6de287f60d6c5f15dabdb0ceb045a34e3c5a7"


def test_vector() -> None:
    assert sign("secret", '{"a":1}', T) == VECTOR
    assert sign("secret", b'{"a":1}', T) == VECTOR


def test_valid_signature_passes() -> None:
    assert verify_signature("secret", '{"a":1}', VECTOR, T) is None
    verify_signature("secret", '{"a":1}', VECTOR, T + 300_000)
    verify_signature("secret", '{"a":1}', VECTOR, T - 300_000)


def reason(body: str, header, now: int, secret: str = "secret") -> str:
    with pytest.raises(InvalidSignature) as info:
        verify_signature(secret, body, header, now)
    return info.value.reason


def test_tampered_body() -> None:
    assert reason('{"a":2}', VECTOR, T) == "mismatch"


def test_tampered_mac() -> None:
    flipped = VECTOR[:-1] + ("0" if VECTOR[-1] != "0" else "1")
    assert reason('{"a":1}', flipped, T) == "mismatch"


def test_wrong_secret() -> None:
    assert reason('{"a":1}', VECTOR, T, secret="other") == "mismatch"


def test_stale_timestamp() -> None:
    assert reason('{"a":1}', VECTOR, T + 300_001) == "stale"
    assert reason('{"a":1}', VECTOR, T - 300_001) == "stale"


def test_missing_and_malformed() -> None:
    assert reason('{"a":1}', None, T) == "missing"
    assert reason('{"a":1}', "", T) == "missing"
    assert reason('{"a":1}', "t=abc,v1=00", T) == "malformed"
    assert reason('{"a":1}', VECTOR.upper(), T) == "malformed"
