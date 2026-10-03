# Where the three gateway calls go in a real voice framework

The host does three things per call, whatever the stack: send each caller utterance to the gateway, ask
the gateway before a protected tool runs, and let the tool consume the grant. `agent.py` does them with a
scripted call. Below, the same three calls in two frameworks. These snippets were written against the
frameworks' documented function-calling APIs and have **not been run**; treat them as a map, not a drop-in.

The conversation id is set by the host from its own session, never from model output.

## Pipecat

```python
from anticlus import AgentClient, ToolClient, GrantRefused
agent = AgentClient(GATEWAY_URL, AGENT_KEY)
tool = ToolClient(GATEWAY_URL, TOOL_KEY)

# 1. Every final caller transcript goes to the gateway.
class GatewayTurns(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):            # the caller's final text
            agent.add_turn(self.conversation_id, "caller", frame.text)
        await self.push_frame(frame, direction)

# 2 and 3. The function the LLM calls asks first, and the tool consumes the grant.
async def update_supplier_iban(params: FunctionCallParams):
    args = {"iban": params.arguments["iban"]}
    decision = agent.guard(conversation_id, "update_supplier_iban", args)
    if decision.decision != "allow" or not decision.grant_id:
        await params.result_callback({"done": False, "say": decision.spoken_reply})
        return
    try:
        erp.update_supplier_iban(decision.grant_id, conversation_id, args)   # @guarded: consumes the grant
    except GrantRefused as e:
        await params.result_callback({"done": False, "say": "I can't complete that right now."})
        return
    await params.result_callback({"done": True, "say": decision.spoken_reply})

llm.register_function("update_supplier_iban", update_supplier_iban)
```

## LiveKit Agents

```python
class Iris(Agent):
    @function_tool()
    async def update_supplier_iban(self, context: RunContext, iban: str) -> str:
        args = {"iban": iban}
        decision = agent.guard(self.conversation_id, "update_supplier_iban", args)
        if decision.decision != "allow" or not decision.grant_id:
            return f"NOT EXECUTED ({decision.decision}). Say to the caller: {decision.spoken_reply}"
        try:
            return erp.update_supplier_iban(decision.grant_id, self.conversation_id, args)
        except GrantRefused:
            return "NOT EXECUTED (grant refused)."

# Caller turns: subscribe to the session's final user transcripts.
@session.on("user_input_transcribed")
def on_transcript(ev):
    if ev.is_final:
        agent.add_turn(conversation_id, "caller", ev.transcript)
```

## The MFA side

The challenge webhook and its signed answer live in the company's backend, not in the agent process
(`mfa_backend.py` is the stand-in). The agent never holds the MFA secret.

## Or skip the code: MCP proxy

If the agent reaches its tools through MCP, run `anticlus-mcp-proxy` in front of the MCP server and
change nothing in the agent; see [../mcp-proxy](../mcp-proxy).
