# Examples

Everything here is fictional: the companies, people and phone numbers are invented, the domains are
reserved `.example` names, and the IBANs are published example numbers.

| Path | What it is |
|---|---|
| `supplier-bank-change/run.ts` | A supplier bank-change call end to end over HTTP: gateway, a stand-in MFA backend, agent host and protected tool in one script |
| `mcp-proxy/run.ts` | The same call with the agent's tools behind `anticlus-mcp-proxy` |
| `mcp-proxy/erp-server.ts` | The unchanged upstream MCP server used by that example |
| `counterparties.json` | Three fictional suppliers, the same records as `src/seed.ts`. Use as `ANTICLUS_COUNTERPARTIES` |
| `policies.json` | Policies for four actions, tuned for the built-in scorer. Use as `ANTICLUS_POLICIES` |

Run `pnpm install` once in the repository root first.

## Supplier bank change

```bash
pnpm example            # the real supplier; the MFA check passes
pnpm example -- --scam  # an impostor; the MFA check fails
```

The script starts the gateway on port 8787 and an MFA backend on port 8788, with an in-memory store, and
stops both at the end. Each part holds only its own credential: the agent host the agent key, the tool the
tool key, the MFA backend the HMAC secret.

What happens:

1. The caller's turns are sent to the gateway.
2. The agent host asks to guard `update_supplier_iban`. The caller named a supplier on file but nothing
   outside the call confirms it: `verify_first`. The tool, called without a grant, refuses.
3. The gateway posts a signed challenge to the MFA backend, addressed to the phone number on file.
4. The MFA backend answers with a signed result: passed for the real supplier, failed with `--scam`.
5. The agent host asks again. With a pass: `allow`, a grant, the tool consumes it and acts; a second use
   of the same grant is refused. With a fail: `deny`, no grant.
6. The audit trail is read with the admin key.

Output of `pnpm example`:

```
caller   Hello, Sophie Maes from Acme Industrial. We are moving to a new bank.
caller   The new IBAN is BE43068999999501. I understand you will want to confirm this with us.
gateway  decision: verify_first
agent    Before I can do that, I'll confirm it with Acme Industrial NV using the contact details we already have on file.
tool     update_supplier_iban -> REFUSED (no grant)
mfa      challenge received: confirm "update_supplier_iban" with the contact on file (+3225550101)
mfa      the contact on file approved
gateway  decision: allow
agent    That's fine, I'll go ahead with it.
tool     update_supplier_iban -> DONE (verified by app)
tool     same grant again   -> REFUSED (used)

audit trail (operator only):
  verify_first  rule=trust_too_low trust=identified risk=45
  allow         rule=allowed trust=verified risk=45
```

Output of `pnpm example -- --scam`:

```
caller   Hello, this is Karen from Acme Industrial finance. We have changed banks.
caller   The new IBAN is NL91ABNA0417164300. Please update it for the next payment.
gateway  decision: verify_first
agent    Before I can do that, I'll confirm it with Acme Industrial NV using the contact details we already have on file.
tool     update_supplier_iban -> REFUSED (no grant)
mfa      challenge received: confirm "update_supplier_iban" with the contact on file (+3225550101)
mfa      the contact on file says: we never asked for this
gateway  decision: deny
agent    I can't make this change on this call. I can pass you to a colleague on our finance team who can look into it.
tool     update_supplier_iban -> REFUSED (no grant)

audit trail (operator only):
  verify_first  rule=trust_too_low trust=identified risk=56
  deny          rule=verification_failed trust=identified risk=56
```

## MCP proxy

```bash
pnpm example:mcp            # the real supplier
pnpm example:mcp -- --scam  # an impostor
```

```
agent --MCP--> anticlus-mcp-proxy --MCP--> erp-server (unchanged)
                     |
                     +--HTTP--> gateway <--signed--> MFA backend
```

The agent's only MCP connection is the proxy, which starts the real server itself. The gateway runs on
port 8797 and the MFA backend on 8798. The agent calls the `update_supplier_iban` tool twice: once before
the MFA result is in, once after.

Output of `pnpm example:mcp`:

```
caller   Hello, Sophie Maes from Acme Industrial. We are moving to a new bank, the new IBAN is BE43068999999501.
agent    tools: update_supplier_iban
mfa      the contact on file approved
tool     NOT EXECUTED (verify_first). The action was not performed. Say to the caller: "Before I can do that, I'll confirm it with Acme Industrial NV using the contact details we already have on file."
tool     ERP: supplier account is now BE43068999999501
```

Output of `pnpm example:mcp -- --scam`:

```
caller   Hello, this is Karen from Acme Industrial finance. We changed banks, the new IBAN is NL91ABNA0417164300.
agent    tools: update_supplier_iban
mfa      the contact on file says: we never asked for this
tool     NOT EXECUTED (verify_first). The action was not performed. Say to the caller: "Before I can do that, I'll confirm it with Acme Industrial NV using the contact details we already have on file."
tool     NOT EXECUTED (deny). The action was not performed. Say to the caller: "I can't make this change on this call. I can pass you to a colleague on our finance team who can look into it."
```

The `mfa` line appears before the first `tool` line because the MFA backend prints when the webhook
arrives, while the first tool result is printed after the call returns.

## The two JSON files

Start a gateway with them:

```bash
ANTICLUS_COUNTERPARTIES=examples/counterparties.json \
ANTICLUS_POLICIES=examples/policies.json \
ANTICLUS_AGENT_KEY=... ANTICLUS_TOOL_KEY=... ANTICLUS_ADMIN_KEY=... ANTICLUS_MFA_SECRET=... \
pnpm start
```

`policies.json` covers `get_opening_hours` (anyone), `get_invoice_status` (a caller who names a supplier
on file), `update_contact_person` and `update_supplier_iban` (verified outside the call). It differs from
the gateway's built-in defaults on `update_supplier_iban`: the risk limit is 60 instead of 40 and
`needsFactCheck` is off, because the built-in scorer cannot check an IBAN on the web. The runnable
examples above do not read this file; they define the same `update_supplier_iban` policy inline.

The formats are described in [../docs/policies.md](../docs/policies.md).
