# Security policy

Anticlus is an authorization gateway: its job is to stop a voice agent from executing a protected action on
the strength of what was said on a call. A flaw that lets a caller, a model output, or an unauthenticated
client obtain a grant, pass a verification, or read another caller's data is a vulnerability. So is anything
that weakens the guarantees listed under [Security model and limits](README.md#security-model-and-limits).

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a
vulnerability**. Include the version or commit, the steps to reproduce, and what an attacker gains. We will
acknowledge the report, keep you informed while we work on it, and credit you in the fix unless you prefer
otherwise.

## Supported versions

Only the latest release on the `main` branch receives fixes. Version 0.1.0 is a single-node gateway with no
external security review; read the limits section of the README before deploying it in front of anything
real.

## Out of scope

- The documented limits: static bearer keys, no rate limiting, plain HTTP, single-node SQLite.
- Weaknesses of the built-in keyword scorer. It is a set of rules, and the README says so; the gateway's
  refusals do not depend on it.
- A protected tool that does not consume a grant, or an agent that can reach the tool by another path.
  Enforcement is in the tool, and the README says so too.
