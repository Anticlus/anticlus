# Policies, trust and the decision order

The gateway decides from three inputs: the **policy** of the action being asked for, the **trust level**
of the conversation, and the **score** the scorer returned. The scorer reports risk, claims and a
counterparty match. It never decides, and its score never raises trust.

## The policies file

`ANTICLUS_POLICIES` points to a JSON array, one object per protected action. `examples/policies.json` is a
working file.

```json
{
  "action": "update_supplier_iban",
  "tier": 3,
  "requiredTrust": "verified",
  "riskLimit": 60,
  "needsFactCheck": false,
  "parameterKeys": ["iban"]
}
```

| Field | Type | Meaning |
|---|---|---|
| `action` | string, 1 to 64 characters | The name the agent host passes to guard and the tool passes to consume. In MCP proxy mode, the MCP tool name |
| `tier` | `0`, `1`, `2` or `3` | What kind of action it is. See below |
| `requiredTrust` | `anonymous`, `identified` or `verified` | The trust the conversation must have |
| `riskLimit` | number, 0 to 100 | A risk at or above this value escalates |
| `needsFactCheck` | boolean | The action waits for a confirmed claim on one of its parameters. See the warning below |
| `parameterKeys` | array of strings, default `[]` | The parameters a claim can touch. A contradicted claim on one of them denies the action |

The file is validated at start; the gateway does not start on an invalid one. It is read once: restart the
gateway to apply a change.

**An action with no policy is denied.** The audit rule is `unknown_action`.

### Tiers

| Tier | Kind of action | Example |
|---|---|---|
| 0 | Public information | Opening hours |
| 1 | Account data | The status of an invoice |
| 2 | A change to a record | The contact person on file |
| 3 | Money | The bank account a supplier is paid on |

The tier is recorded in the audit row. It changes the decision in two places only: a contradicted
counterparty and a failed verification deny actions of tier 2 and 3, and leave tiers 0 and 1 to the trust
check.

### When `ANTICLUS_POLICIES` is not set

The gateway uses the four policies in `DEFAULT_ACTION_POLICIES` (`src/schemas.ts`):

| Action | Tier | Required trust | Risk limit | Needs fact-check | Parameter keys |
|---|---|---|---|---|---|
| `get_opening_hours` | 0 | anonymous | 100 | no | |
| `get_invoice_status` | 1 | identified | 70 | no | `invoice` |
| `update_contact_person` | 2 | verified | 60 | no | `phone`, `email` |
| `update_supplier_iban` | 3 | verified | 40 | yes | `iban` |

**With the built-in scorer, the default `update_supplier_iban` policy never allows a new account.** The
built-in rules cannot check an IBAN on the web, so the claim stays `unchecked` and `needsFactCheck` holds
the action back; and a caller who mentions a change of bank already scores above 40, so the decision is
`escalate` before that. This was observed on a local run: the same call that ends in `allow` under
`examples/policies.json` answers `escalate` (`risk_over_limit`, risk 45) under the defaults. Use
`needsFactCheck: true` only with a scorer that settles claims, and set `riskLimit` with your scorer's
scale in mind.

## Trust levels

Trust belongs to the conversation, is computed again on every guard call, and is blind to the risk, to
the signals, and to how long or how politely the caller talks.

| Level | When |
|---|---|
| `anonymous` | The default. Also when the scorer reports that something said contradicts the matched counterparty |
| `identified` | The scorer matched the caller's claimed organisation to a record in the counterparties file, and nothing contradicts it |
| `verified` | `identified`, and a verification for that counterparty passed outside the call, is bound to this action and these parameters, has not expired, and no verification for that counterparty failed |

`identified` rests on what the caller said, so it opens only what you would tell anyone who names a known
supplier. `verified` can only come from `POST /v1/verifications`, which the agent cannot call
([mfa.md](mfa.md)).

A match only counts when the id the scorer returned exists in the counterparties file.

## The decision order

For each guard call, in this order. The first rule that applies gives the decision.

| # | Condition | Decision | Audit rule |
|---|---|---|---|
| 0 | The action has no policy | `deny` | `unknown_action` |
| 1 | `risk >= riskLimit` | `escalate` | `risk_over_limit` |
| 2a | A claim that touches one of the action's `parameterKeys` is `contradicted` | `deny` | `claim_contradicted` |
| 2b | Tier 2 or 3, and the scorer reports the matched counterparty as contradicted | `deny` | `counterparty_contradicted` |
| 2c | Tier 2 or 3, and a verification for the matched counterparty failed in this conversation | `deny` | `verification_failed` |
| 3 | Trust is below `requiredTrust` | `verify_first` | `trust_too_low` |
| 4 | `needsFactCheck`, and no claim touches the action's parameters, or one that does is `pending` or `unchecked` | `verify_first` | `fact_check_not_back` |
| 5 | None of the above | `allow`, with a grant | `allowed` |

The order matters:

- **Risk first.** A conversation over the limit goes to a person, whatever the trust. A passed
  verification does not lower the risk.
- **Deny before verify.** A caller whose claim is contradicted, or whose check already failed, is refused.
  They are not offered another verification.
- **Verify before fact-check.** Step 3 has two forms. When a counterparty on file was matched, the
  gateway opens an MFA challenge addressed to the official contact details of that record. When none was
  matched, there is nobody to verify with: the reply asks which company the caller represents, and no
  challenge is opened.

Rule 0 is in `src/gateway/gateway.ts`; rules 1 to 5 are the pure function `decide` in
`src/gateway/decide.ts`.

### Failing closed

- **Scorer failure.** If the scorer throws, answers something that does not match the schema, or takes
  more than 2 seconds, the gateway uses risk 100 with no match. Rule 1 then applies to every action,
  including one with `riskLimit` 100, so the decision is `escalate`. The audit rule reads `scorer_failed`.
- **No turns yet.** A conversation with no turns is not sent to the scorer. Its risk is 0 and its trust
  `anonymous`, so only actions that require `anonymous` trust are allowed.
- **Unknown action.** Denied, as above.
- **No grant, no action.** `allow` alone does nothing. The protected tool must consume the grant, and the
  consume call fails for another conversation, another action, other parameters, a second use, or after
  120 seconds.

### What the caller hears

Each decision comes with `reasons` and one `spokenReply`. They are fixed English sentences in
`src/gateway/decide.ts` and contain no rule name, score, threshold or verification target. The wording
mentions "a colleague on our finance team"; it is not configurable in this version.

## The counterparties file

`ANTICLUS_COUNTERPARTIES` (required) points to a JSON array of the parties the company knows, with their
official details. `examples/counterparties.json` has three fictional suppliers.

```json
{
  "id": "acme",
  "name": "Acme Industrial NV",
  "registryNumber": "0999.000.001",
  "officialPhone": "+3225550101",
  "officialDomain": "acme-industrial.example",
  "bankAccounts": [{ "iban": "BE68539007547034", "verifiedBy": "onboarding" }],
  "contactPerson": "Sophie Maes"
}
```

| Field | Type | Used for |
|---|---|---|
| `id` | string, 1 to 64 characters | The key stored in challenges and grants and sent in the MFA webhook |
| `name` | string, 1 to 200 characters | Matching the organisation the caller names; spoken in the `verify_first` reply |
| `registryNumber` | string, at most 32 characters | Company registry number (in the examples, a Belgian enterprise number) |
| `officialPhone` | string, at most 32 characters | The `target` of every MFA challenge for this counterparty |
| `officialDomain` | string, at most 253 characters | The built-in scorer marks the counterparty contradicted when the caller gives another domain |
| `bankAccounts` | array of `{ iban, verifiedBy }`, default `[]` | An IBAN already on file counts as a confirmed claim |
| `contactPerson` | string or `null`, default `null` | Informational |

The file is read once at start. Verification always goes to the details in this file and never to a number
or address given during the call, so the file is the root of trust: whoever can edit it decides who gets
verified. Keep it out of reach of the agent.
