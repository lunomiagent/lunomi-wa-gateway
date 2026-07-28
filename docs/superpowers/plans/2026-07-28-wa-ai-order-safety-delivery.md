# WA AI Order Safety and Delivery Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ambiguous or staff messages from creating orders and make WhatsApp delivery state observable beyond socket submission.

**Architecture:** Add a pure order-policy module and a pure delivery tracker, then integrate both at the existing AI-provider and Baileys event boundaries. Supabase remains the source of truth for catalog, outlet, session phone, and stored orders.

**Tech Stack:** Node.js 22, CommonJS, Node test runner, Supabase JS, Baileys 7.0.0-rc13.

## Global Constraints

- Work directly on `main` as explicitly requested.
- Do not deploy, send a live WhatsApp message, delete production rows, or reset the WhatsApp session.
- Preserve exact inbound LID primary routing and existing PN fallback semantics.
- Never trust model-provided phone numbers, prices, totals, products, or outlets.

---

### Task 1: Deterministic Order Policy

**Files:**
- Create: `orderPolicy.js`
- Modify: `aiEngine.js`
- Test: `test/orderPolicy.test.js`

**Interfaces:**
- Produces: `isOrderToolAllowed({ userRole, currentUserMessage, contextMessages })`
- Produces: `filterToolsForSession(tools, sessionContext, nameSelector)`
- Produces: `canonicalizeOrderPayload({ toolArgs, sessionPhone, catalogProducts, validOutletCodes })`

- [ ] **Step 1: Write failing policy tests**

Test that staff/owner and ambiguous customer messages cannot expose the order
tool, while an explicit confirmation immediately after an assistant
confirmation prompt can. Test that canonicalization uses session phone and
catalog prices and rejects unknown products/outlets.

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `node --test test/orderPolicy.test.js`

Expected: FAIL because `orderPolicy.js` does not exist.

- [ ] **Step 3: Implement the pure policy**

Normalize Indonesian text, require an explicit confirmation phrase containing
order intent, require the latest context message to be an assistant confirmation
question, filter provider tool definitions, and canonicalize only exact active
catalog product names and valid outlet codes.

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: `node --test test/orderPolicy.test.js`

Expected: all policy tests PASS.

- [ ] **Step 5: Add executor-boundary regression tests**

Export a dependency-injected order execution boundary from `aiEngine.js` and
prove an unauthorized tool call cannot invoke `saveWaOrder`.

- [ ] **Step 6: Integrate all AI providers**

Pass `userRole`, `currentUserMessage`, and `contextMessages` into
`sessionContext`; filter Gemini/OpenAI-format tools per session; query active
catalog products and valid outlet before save; use the session phone; recalculate
the total; await the notification callback.

### Task 2: Delivery Lifecycle Evidence

**Files:**
- Create: `deliveryTracker.js`
- Modify: `index.js`
- Test: `test/deliveryTracker.test.js`

**Interfaces:**
- Produces: `createDeliveryTracker({ timeoutMs, onTimeout, setTimer, clearTimer })`
- Consumes: outbound message IDs and Baileys numeric message status updates.

- [ ] **Step 1: Write failing tracker tests**

Test timeout emission/removal, terminal receipt cleanup, and non-terminal status
retention.

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `node --test test/deliveryTracker.test.js`

Expected: FAIL because `deliveryTracker.js` does not exist.

- [ ] **Step 3: Implement the pure tracker**

Store a timer with each pending message, clear it for delivery/error terminal
states, and expose pending count for the status endpoint.

- [ ] **Step 4: Integrate Baileys events**

Replace the raw pending map with the tracker, log delivery timeout as
unconfirmed, include error details when present, expose pending count at
`/status`, and log `reachoutTimeLock` from `connection.update`.

- [ ] **Step 5: Run targeted delivery tests**

Run: `node --test test/deliveryTracker.test.js test/waReplyDelivery.test.js`

Expected: all targeted tests PASS.

### Task 3: Credential and Completion Verification

**Files:**
- Modify: `aiEngine.js`
- Create: `.env.example`

- [ ] **Step 1: Remove embedded Groq credential**

Read only `process.env.GROQ_API_KEY`; document required environment variable
names without values in `.env.example`.

- [ ] **Step 2: Run complete verification**

Run: `npm test`

Run: `node --check aiEngine.js && node --check index.js && node --check orderPolicy.js && node --check deliveryTracker.js`

Run: `git diff --check`

Run a repository secret-pattern scan that confirms the removed Groq key prefix
is absent outside ignored dependencies and user-owned diagnostic files.

- [ ] **Step 3: Review diff and commit**

Confirm only planned files changed, preserve the three pre-existing untracked
diagnostic files, commit intentionally on `main`, and push `main` to origin.
