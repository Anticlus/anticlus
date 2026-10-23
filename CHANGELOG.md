# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-23

First public release. A single-node authorization gateway for voice agents.

### Added

- The gateway: `POST /v1/guard` answers `allow`, `verify_first`, `deny` or `escalate` for a protected
  action, from the action's policy, the conversation's trust level and the scorer's risk.
- Single-use grants bound to one conversation, one action and the hash of the exact parameters, valid for
  120 seconds and consumed once by the protected tool.
- Step-up verification through the company's own MFA backend: a signed challenge to the contact on file,
  never to the caller, and a signed result that alone can raise trust.
- The trust ladder: unknown, identified by name, authenticated by the host, verified outside the call. A
  name alone opens no account data; a host-vouched principal cannot be contradicted by content the agent
  read, only by the caller.
- A refused verification closes the conversation's access to anything that would need the contact again;
  an ended conversation id cannot be reused.
- Built-in keyword scorer in English and French, and a remote-scorer contract (`ANTICLUS_SCORER_URL`) for
  plugging in a hosted scorer. A scorer error or timeout counts as maximum risk.
- Tool-result turns, so injected content refuses only the values it asked for while the caller's own
  request falls back to verification.
- SQLite store with an operator-readable audit trail.
- MCP proxy mode (`anticlus-mcp-proxy`) that guards an upstream MCP server's tools.
- Python client (`clients/python`) with a voice-agent example.
- Runnable examples: the supplier bank-account change, legitimate and scam, and the MCP proxy.
- Documentation: HTTP API, the MFA flow and signature scheme, policies and the decision order, data
  handling (draft).
- Dockerfile and docker-compose for a local deployment; CI running typecheck, tests and build.

### Known limits

See *Security model and limits* in the README. In short: static bearer keys, no rate limiting, plain HTTP,
single node, a rule-based scorer, no external security review.

[0.1.0]: https://github.com/Anticlus/anticlus/releases/tag/v0.1.0
