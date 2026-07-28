# Baileys v7 LID Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI replies to inbound WhatsApp LID conversations visible by migrating to Baileys v7, persisting the observed LID/phone mapping, and surfacing auth-state failures.

**Architecture:** Keep the application CommonJS and isolate the ESM-only Baileys package behind one cached dynamic-import loader. The Supabase auth adapter consumes that loader and persists all v7 signal-key categories, while the reply helper stores an inbound LID/PN mapping before sending to the exact inbound JID.

**Tech Stack:** Node.js 22+, CommonJS, `baileys@7.0.0-rc13`, Supabase JS, Node test runner.

## Global Constraints

- Pin `baileys` exactly to `7.0.0-rc13`.
- Require Node.js `>=22.0.0`.
- Do not convert the application to ESM.
- Do not change the Supabase schema or live data.
- Do not clear WhatsApp sessions automatically.
- Keep the exact inbound LID as the primary send target.
- Use the phone-number JID only after a primary send exception.
- Do not claim delivery from a returned message ID alone.
- Preserve `inspect_wa_bot.js`, `opus_deep_dive_wa.js`, and `test_join_error.js` as untracked user files.
- Work directly on `main`, as explicitly requested by the user, and push only after final verification.

---

## File Structure

- Create `baileysRuntime.js`: cached CommonJS-to-ESM import boundary.
- Create `test/baileysRuntime.test.js`: loader cache, retry, and contextual-error tests.
- Modify `useSupabaseAuth.js`: v7 runtime consumption and checked Supabase operations.
- Create `test/useSupabaseAuth.test.js`: auth-key persistence, conversion, and error propagation.
- Modify `waReplyDelivery.js`: persist the inbound LID/PN mapping before sending.
- Modify `test/waReplyDelivery.test.js`: mapping order, missing mapping data, and mapping-error regression coverage.
- Modify `index.js`: load v7 exports asynchronously, use the supported browser descriptor, remove automatic session deletion, and make logs distinguish submission from delivery.
- Modify `package.json`: replace scoped v6 with exact v7 and set Node 22 minimum.
- Modify `package-lock.json`: lock the v7 dependency graph.
- Modify `docs/superpowers/specs/2026-07-28-baileys-v7-lid-routing-design.md`: mark the approved design as approved.

---

### Task 1: Cached Baileys v7 Runtime Boundary

**Files:**
- Create: `baileysRuntime.js`
- Create: `test/baileysRuntime.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/superpowers/specs/2026-07-28-baileys-v7-lid-routing-design.md`

**Interfaces:**
- Consumes: native dynamic `import('baileys')`.
- Produces: `createBaileysLoader(importModule)` and shared `loadBaileys()`, both returning a promise for the Baileys module namespace.

- [x] **Step 1: Write failing loader tests**

Create `test/baileysRuntime.test.js` with tests that prove one importer call is
shared across concurrent loads and that a rejected import is wrapped and can be
retried:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createBaileysLoader } = require('../baileysRuntime');

test('shares one Baileys import across concurrent callers', async () => {
    let imports = 0;
    const runtime = { default: () => 'socket' };
    const load = createBaileysLoader(async () => {
        imports += 1;
        return runtime;
    });

    const [first, second] = await Promise.all([load(), load()]);

    assert.equal(imports, 1);
    assert.equal(first, runtime);
    assert.equal(second, runtime);
});

test('adds context to an import failure and retries on the next call', async () => {
    let imports = 0;
    const load = createBaileysLoader(async () => {
        imports += 1;
        if (imports === 1) throw new Error('module load failed');
        return { default: () => 'socket' };
    });

    await assert.rejects(load(), /Unable to load Baileys v7 runtime/);
    const runtime = await load();

    assert.equal(imports, 2);
    assert.equal(typeof runtime.default, 'function');
});
```

- [x] **Step 2: Run the loader tests and verify RED**

Run:

```powershell
node --test test/baileysRuntime.test.js
```

Expected: FAIL because `../baileysRuntime` does not exist.

- [x] **Step 3: Implement the minimal cached loader**

Create `baileysRuntime.js`:

```js
function createBaileysLoader(importModule = () => import('baileys')) {
    let runtimePromise = null;

    return function loadBaileysRuntime() {
        if (!runtimePromise) {
            runtimePromise = Promise.resolve()
                .then(importModule)
                .catch((error) => {
                    runtimePromise = null;
                    throw new Error('Unable to load Baileys v7 runtime', {
                        cause: error,
                    });
                });
        }
        return runtimePromise;
    };
}

const loadBaileys = createBaileysLoader();

module.exports = {
    createBaileysLoader,
    loadBaileys,
};
```

- [x] **Step 4: Run the loader tests and verify GREEN**

Run:

```powershell
node --test test/baileysRuntime.test.js
```

Expected: 2 tests pass.

- [x] **Step 5: Install and pin Baileys v7**

Run:

```powershell
npm.cmd install baileys@7.0.0-rc13 --save-exact
npm.cmd uninstall @whiskeysockets/baileys
npm.cmd pkg set engines.node=">=22.0.0"
```

Inspect `package.json` and `package-lock.json` to confirm the scoped package is
absent and `baileys` resolves exactly to `7.0.0-rc13`.

Execution note: PowerShell interpreted `>` in the planned `npm pkg set`
argument as redirection. The resulting empty artifact was inspected and
removed; `package.json` and the lockfile root engine were updated with targeted
patches instead.

- [x] **Step 6: Verify the real ESM import boundary**

Run:

```powershell
node -e "require('./baileysRuntime').loadBaileys().then(m => { if (typeof m.default !== 'function') throw new Error('missing default socket export'); console.log('baileys-runtime-ok') })"
```

Expected: `baileys-runtime-ok`.

- [x] **Step 7: Mark the approved design**

Change the design document header from `Status: Proposed` to
`Status: Approved`.

- [x] **Step 8: Commit Task 1**

Stage only the five Task 1 files and commit:

```powershell
git add -- baileysRuntime.js test/baileysRuntime.test.js package.json package-lock.json docs/superpowers/specs/2026-07-28-baileys-v7-lid-routing-design.md
git commit -m "build: migrate Baileys runtime to v7"
```

---

### Task 2: Supabase Auth-State Compatibility and Error Propagation

**Files:**
- Modify: `useSupabaseAuth.js`
- Create: `test/useSupabaseAuth.test.js`

**Interfaces:**
- Consumes: `loadBaileys()` returning `initAuthCreds`, `BufferJSON`, `makeCacheableSignalKeyStore`, and `proto`.
- Produces: `useSupabaseAuthState(supabase, options?)`, where `options.loadRuntime` is an optional test seam; returned `state.keys` supports arbitrary v7 key categories.

- [x] **Step 1: Write failing auth-store tests**

Create a controlled in-memory Supabase double whose query builder mirrors the
used `upsert`, `select().eq().single()`, and `delete().eq()/neq()` operations.
Inject this v7-shaped runtime:

```js
const runtime = {
    initAuthCreds: () => ({ registered: false }),
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    makeCacheableSignalKeyStore: (store) => store,
    proto: {
        Message: {
            AppStateSyncKeyData: {
                create: (value) => ({ ...value, converted: true }),
            },
        },
    },
};
```

Add these observable tests:

```js
test('persists and reads v7 signal-key categories', async () => {
    const { supabase, rows } = createSupabaseFake();
    const auth = await useSupabaseAuthState(supabase, {
        loadRuntime: async () => runtime,
    });

    await auth.state.keys.set({
        'lid-mapping': { '123@lid': { pn: '6281@s.whatsapp.net' } },
        'device-list': { device: { devices: ['0'] } },
        tctoken: { token: { token: 'abc' } },
    });

    assert.deepEqual(rows.get('lid-mapping-123@lid'), {
        pn: '6281@s.whatsapp.net',
    });
    assert.deepEqual(
        await auth.state.keys.get('lid-mapping', ['123@lid']),
        { '123@lid': { pn: '6281@s.whatsapp.net' } }
    );
});

test('converts app-state keys with the v7 create API', async () => {
    const { supabase } = createSupabaseFake({
        'app-state-sync-key-critical': { keyData: 'value' },
    });
    const auth = await useSupabaseAuthState(supabase, {
        loadRuntime: async () => runtime,
    });

    const result = await auth.state.keys.get('app-state-sync-key', ['critical']);

    assert.deepEqual(result.critical, {
        keyData: 'value',
        converted: true,
    });
});

test('propagates Supabase upsert failures with the auth key', async () => {
    const { supabase } = createSupabaseFake({}, {
        upsert: new Error('database unavailable'),
    });
    const auth = await useSupabaseAuthState(supabase, {
        loadRuntime: async () => runtime,
    });

    await assert.rejects(
        auth.state.keys.set({ 'lid-mapping': { broken: { pn: '6281' } } }),
        /lid-mapping-broken.*database unavailable/i
    );
});

test('propagates Supabase delete and explicit clear failures', async () => {
    const { supabase } = createSupabaseFake({}, {
        delete: new Error('delete denied'),
    });
    const auth = await useSupabaseAuthState(supabase, {
        loadRuntime: async () => runtime,
    });

    await assert.rejects(
        auth.state.keys.set({ 'device-list': { broken: null } }),
        /device-list-broken.*delete denied/i
    );
    await assert.rejects(auth.clearSession(), /clear.*delete denied/i);
});
```

- [x] **Step 2: Run auth tests and verify RED**

Run:

```powershell
node --test test/useSupabaseAuth.test.js
```

Expected: FAIL because the current adapter requires scoped Baileys at module
load time and does not accept `loadRuntime`.

- [x] **Step 3: Implement v7 auth loading and checked operations**

In `useSupabaseAuth.js`:

- replace the scoped top-level import with
  `const { loadBaileys } = require('./baileysRuntime')`;
- load runtime exports inside the async function;
- after every awaited Supabase mutation, inspect `{ error }`;
- throw an error containing the operation and key, preserving the original as
  `cause`;
- treat only the expected no-row read result as absent; propagate other read
  errors;
- use `proto.Message.AppStateSyncKeyData.create(value)`;
- keep the generic category loop so v7 categories require no allowlist;
- keep `clearSession()` available only as an explicit operation and make it
  throw when the database rejects the delete.

The function signature is:

```js
module.exports = async function useSupabaseAuthState(
    supabase,
    { loadRuntime = loadBaileys } = {}
) {
    const {
        initAuthCreds,
        BufferJSON,
        makeCacheableSignalKeyStore,
        proto,
    } = await loadRuntime();
    // checked repository operations and existing cacheable store
};
```

- [x] **Step 4: Run auth tests and verify GREEN**

Run:

```powershell
node --test test/useSupabaseAuth.test.js
```

Expected: all auth-store tests pass.

- [x] **Step 5: Run the full suite for regression coverage**

Run:

```powershell
npm.cmd test
```

Expected: loader, auth-store, and existing delivery tests pass.

- [x] **Step 6: Commit Task 2**

```powershell
git add -- useSupabaseAuth.js test/useSupabaseAuth.test.js
git commit -m "fix: persist Baileys v7 auth state safely"
```

---

### Task 3: Persist Inbound LID Mapping Before Reply

**Files:**
- Modify: `waReplyDelivery.js`
- Modify: `test/waReplyDelivery.test.js`

**Interfaces:**
- Consumes: `sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn }])`.
- Produces: existing `sendReplyToInboundChat({ sock, msg, text })`, extended with `mappingStored` and `mappingError` in its result.

- [x] **Step 1: Add failing mapping-contract tests**

Add a test that records operations and proves mapping storage precedes the exact
LID send:

```js
test('stores the inbound LID and phone mapping before sending', async () => {
    const operations = [];
    const sock = {
        signalRepository: {
            lidMapping: {
                async storeLIDPNMappings(mappings) {
                    operations.push({ type: 'mapping', mappings });
                },
            },
        },
        async sendMessage(jid) {
            operations.push({ type: 'send', jid });
            return { key: { id: 'mapped-message-id' } };
        },
    };

    const result = await sendReplyToInboundChat({
        sock,
        msg: createMessage(),
        text: 'Daftar menu',
    });

    assert.deepEqual(operations, [
        {
            type: 'mapping',
            mappings: [{ lid: LID_JID, pn: PHONE_JID }],
        },
        { type: 'send', jid: LID_JID },
    ]);
    assert.equal(result.mappingStored, true);
assert.equal(result.mappingError, null);
});
```

Add separate tests before changing production code that prove:

- missing `senderPn` skips mapping and still sends the exact LID;
- a mapping persistence exception is returned as `mappingError` and the exact
  send is still attempted;
- phone-JID inbound messages do not invoke the mapping repository;
- existing primary/fallback and dual-error behavior remains unchanged.

The mapping-error assertion must inspect the real returned state:

```js
assert.equal(result.mappingStored, false);
assert.match(result.mappingError.message, /mapping write failed/);
assert.deepEqual(calls, [LID_JID]);
```

- [x] **Step 2: Run the mapping tests and verify RED**

Run:

```powershell
node --test test/waReplyDelivery.test.js
```

Expected: the new mapping-contract tests fail because no mapping operation or
mapping result fields exist; the four pre-existing routing tests still pass.

- [x] **Step 3: Implement minimal mapping storage**

Before the primary send:

```js
async function storeInboundLidMapping(sock, key) {
    const lid = key?.remoteJid;
    const pn = normalizePhoneJid(key?.senderPn);
    const storeMappings =
        sock?.signalRepository?.lidMapping?.storeLIDPNMappings;

    if (!lid?.endsWith('@lid') || !pn || typeof storeMappings !== 'function') {
        return { mappingStored: false, mappingError: null };
    }

    try {
        await storeMappings.call(
            sock.signalRepository.lidMapping,
            [{ lid, pn }]
        );
        return { mappingStored: true, mappingError: null };
    } catch (mappingError) {
        return { mappingStored: false, mappingError };
    }
}
```

Merge the returned fields into every successful primary or fallback result.
Mapping failure must not skip the send or change the exact-LID-first fallback
rule.

- [x] **Step 4: Run the mapping tests and verify GREEN**

Run:

```powershell
node --test test/waReplyDelivery.test.js
npm.cmd test
```

Expected: all delivery tests and the full suite pass.

- [x] **Step 5: Commit Task 3**

```powershell
git add -- waReplyDelivery.js test/waReplyDelivery.test.js
git commit -m "fix: seed LID mapping before WhatsApp reply"
```

---

### Task 4: Integrate Baileys v7 and Honest Delivery Logging

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: shared `loadBaileys()`, v7 auth state, and the extended delivery result.
- Produces: a v7 WhatsApp socket configured with `Browsers.macOS('Desktop')`, non-destructive logout handling, and submission/status logs.

- [x] **Step 1: Re-read all affected `index.js` ranges**

Read the imports, `safeSendReply`, final outbound audit logging,
`connectToWhatsApp`, logout branch, and `messages.update` listener immediately
before editing.

- [x] **Step 2: Replace the synchronous v6 import**

At module scope:

```js
const { loadBaileys } = require('./baileysRuntime');
```

Inside `connectToWhatsApp()`:

```js
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    WAMessageStatus,
} = await loadBaileys();
```

Keep the status listener inside `connectToWhatsApp()` so it uses the loaded
`WAMessageStatus`.

- [x] **Step 3: Use the supported browser descriptor**

Change the socket option to:

```js
browser: Browsers.macOS('Desktop'),
```

- [x] **Step 4: Remove automatic destructive logout recovery**

Do not call `clearSession()` when Baileys reports `DisconnectReason.loggedOut`.
Log that the stored session is preserved and explicit relinking/reset is
required. Do not reconnect in a loop for the logged-out state.

- [x] **Step 5: Surface mapping outcome and honest delivery semantics**

In `safeSendReply`:

- log a successful mapping store when `delivery.mappingStored` is true;
- log `delivery.mappingError.message` when mapping persistence failed;
- keep primary/fallback submission logs.

When recording the outbound audit, combine a send failure or mapping failure
into `errorInfo`. Replace:

```text
menunggu delivery receipt
```

with wording equivalent to:

```text
status delivery akan dicatat jika tersedia
```

This preserves the message ID as correlation evidence without calling it proof
of delivery.

- [x] **Step 6: Run static and regression verification**

Run:

```powershell
node --check index.js
node --check useSupabaseAuth.js
node --check waReplyDelivery.js
node --check baileysRuntime.js
npm.cmd test
```

Expected: all syntax checks and the full test suite pass.

- [x] **Step 7: Run a non-connecting v7 API smoke check**

Run:

```powershell
node -e "require('./baileysRuntime').loadBaileys().then(m => { const required=['default','DisconnectReason','fetchLatestBaileysVersion','Browsers','WAMessageStatus','initAuthCreds','BufferJSON','makeCacheableSignalKeyStore','proto']; const missing=required.filter(k => m[k] == null); if (missing.length) throw new Error('missing exports: '+missing.join(',')); if (!m.proto.Message.AppStateSyncKeyData.create) throw new Error('missing AppStateSyncKeyData.create'); console.log('baileys-v7-api-ok') })"
```

Expected: `baileys-v7-api-ok`.

- [x] **Step 8: Commit Task 4**

```powershell
git add -- index.js
git commit -m "fix: integrate Baileys v7 reply lifecycle"
```

---

### Task 5: Final Verification, Compliance, and Push

**Files:**
- Modify: `docs/superpowers/plans/2026-07-28-baileys-v7-lid-routing.md`
- Modify outside repository: `D:/POS/.agents/skills/lunomi_agent/scripts/.last_run.txt`

**Interfaces:**
- Consumes: all prior task commits.
- Produces: verified `main` pushed to `origin/main`.

- [x] **Step 1: Mark completed plan checkboxes**

Update each executed checkbox from `[ ]` to `[x]`. If any command differs from
the plan, record the actual command and result beside that step.

- [x] **Step 2: Run fresh full verification**

Run:

```powershell
npm.cmd test
node --check index.js
node --check useSupabaseAuth.js
node --check waReplyDelivery.js
node --check baileysRuntime.js
node -e "require('./baileysRuntime').loadBaileys().then(m => console.log(m.default && m.proto.Message.AppStateSyncKeyData.create ? 'baileys-v7-api-ok' : 'invalid'))"
npm.cmd ls baileys --depth=0
git diff --check
```

Expected:

- full Node test suite exits 0 with zero failures;
- all syntax checks exit 0;
- smoke output is `baileys-v7-api-ok`;
- dependency tree shows only `baileys@7.0.0-rc13`;
- diff check is clean.

- [x] **Step 3: Review scope and artifacts**

Run:

```powershell
git status --short --branch
git log --oneline origin/main..HEAD
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- package.json index.js useSupabaseAuth.js waReplyDelivery.js
rg -n "console\\.debug|@whiskeysockets/baileys" baileysRuntime.js useSupabaseAuth.js waReplyDelivery.js index.js package.json test
```

Confirm only planned files are tracked, no secret values or debug code were
introduced, and the three diagnostic files remain untracked.

Execution review:

- Independent reviewer reported two Important findings and no Critical or
  Minor findings.
- Commit `4524625` adds the rc13 `remoteJidAlt` regression fix and aligns the
  root runtime floor with Supabase's Node 22 requirement.
- The accidental empty `20.0.0` redirection artifact was inspected and removed.
- The three pre-existing diagnostic files remain untracked and untouched.

- [x] **Step 4: Run the Lunomi compliance validator**

Update `.last_run.txt` with mode, scope, mutation boundary, completion criteria,
evidence, and risks. Run:

```powershell
powershell -ExecutionPolicy Bypass -File "D:\POS\.agents\skills\lunomi_agent\scripts\validate_compliance.ps1" -OutputFile "D:\POS\.agents\skills\lunomi_agent\scripts\.last_run.txt"
```

Expected: 7/7 checks pass.

Execution result: 7/7 checks passed.

- [x] **Step 5: Commit the completed plan**

```powershell
git add -- docs/superpowers/plans/2026-07-28-baileys-v7-lid-routing.md
git commit -m "docs: record Baileys v7 migration execution"
```

- [ ] **Step 6: Re-run the minimal post-commit gate**

Run:

```powershell
npm.cmd test
git status --short --branch
git log -1 --oneline
```

Expected: tests remain green; only the three known diagnostic files are
untracked; `main` is ahead of `origin/main`.

- [ ] **Step 7: Push `main`**

Run:

```powershell
git push origin main
```

Expected: Git reports `main -> main`.

- [ ] **Step 8: Verify remote receipt**

Run:

```powershell
git fetch origin main
git rev-parse HEAD
git rev-parse origin/main
```

Expected: both commit hashes are identical.

## Runtime Handoff After Push

The local task cannot prove visible WhatsApp delivery without deploying the new
commit and using the authenticated device. After Render deploys `main`:

1. confirm Node.js 22+ and service boot without import errors;
2. send one inbound test from the affected LID account;
3. confirm logs show stored LID/PN mapping before submission;
4. confirm the reply is visible in WhatsApp;
5. confirm at least the corresponding `lid-mapping-*` row exists in
   `wa_sessions`;
6. if the preserved v6 session is logged out or incompatible, perform an
   explicit QR relink instead of deleting session rows automatically.
