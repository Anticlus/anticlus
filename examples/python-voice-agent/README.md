# Example: a voice agent's host in Python

The three gateway calls a voice agent's host makes, in Python, framework-agnostic:

1. every caller utterance goes to the gateway (`AgentClient.add_turn`);
2. before a protected tool runs, the host asks (`AgentClient.guard`);
3. the tool consumes the grant before acting (`@guarded`).

`agent.py` plays a scripted call, so it needs no microphone and no model key. `mfa_backend.py` stands in
for the MFA system a company already has. `INTEGRATIONS.md` shows where the same calls go in Pipecat and
LiveKit Agents.

```bash
cd ../../clients/python && uv venv && uv pip install -e . && cd -
./run.sh          # the real supplier: verify_first, the contact approves, allow, the tool runs once
./run.sh --scam   # an impostor: verify_first, the contact refuses, deny, nothing runs
```
