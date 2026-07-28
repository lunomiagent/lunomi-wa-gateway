# WA AI Order Safety and Delivery Evidence Design

## Problem

The AI can call `create_wa_order` for a staff session after an ambiguous message
because every provider receives the order tool and the executor trusts the
model's payload. A successful Baileys `sendMessage` return is also logged in a
way that can be mistaken for recipient delivery, even when no receipt follows.

## Chosen Design

Use deterministic server-side gates around the model:

1. Staff and owner sessions never receive `create_wa_order`.
2. Customer sessions receive it only when the current message explicitly
   confirms an order and the immediately preceding assistant message asks for
   order confirmation.
3. The executor repeats the same authorization check, always uses the session
   phone number, validates the outlet and active menu items against Supabase,
   and recalculates the total from catalog prices.
4. Ambiguous messages such as `Tes`, `Tes pesan`, and `Pesan` cannot pass the
   confirmation gate.

This keeps the existing conversational UI and database schema while moving
authorization and pricing out of probabilistic model output.

## Delivery Evidence

Track outbound message IDs until `DELIVERY_ACK`, `READ`, `PLAYED`, `ERROR`, or a
bounded timeout. Log `connection.update.reachoutTimeLock` explicitly and label a
timeout as `delivery unconfirmed`, not as success. Keep exact inbound LID as the
primary target and the mapped phone JID only as the existing thrown-send
fallback; this change does not guess a new routing strategy.

## Security

Remove the embedded Groq key from source. `GROQ_API_KEY` must come from the
runtime environment. The exposed credential must be rotated outside this
repository.

## Error Handling

Rejected order tool calls return a structured denial to the model and never
write `wa_orders`. Catalog/outlet validation errors are explicit and do not
fall back to model-provided prices. Notification callbacks are awaited so a
failed downstream notification cannot become an unhandled rejection.

## Tests

- Staff and owner tool lists exclude `create_wa_order`.
- Generic and ambiguous customer messages exclude the order tool.
- An explicit confirmation after an immediate confirmation prompt includes it.
- The executor guard rejects unauthorized calls before any save.
- Canonicalization replaces phone and prices with trusted values and rejects
  unknown products/outlets.
- Delivery tracking emits timeout, clears on terminal receipt, and reports
  restriction state.

## Out of Scope

No deployment, WhatsApp message send, production row deletion, session reset,
database migration, or speculative LID/PN routing change.
