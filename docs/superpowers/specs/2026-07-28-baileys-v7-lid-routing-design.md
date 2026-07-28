# Baileys v7 LID Routing Migration Design

Date: 2026-07-28
Status: Proposed
Repository: `lunomi-wa-gateway`

## Problem

The gateway receives WhatsApp messages and records AI responses in the audit
feed, but the response is not visible in the sender's WhatsApp conversation.
The affected inbound event has:

- `remoteJid` in LID form, for example `193720876068899@lid`;
- `senderPn` in phone-number form, for example
  `6285353726052@s.whatsapp.net`;
- a successful `sendMessage()` return value and message ID;
- no subsequent delivery status that proves the message reached the device.

The application currently resolves
`@whiskeysockets/baileys@6.7.23`. That version can parse LID addresses but does
not expose the LID-to-phone-number mapping repository available in Baileys v7.
Sending directly to an unmapped LID can therefore produce an apparently
successful submission without a visible message.

The Supabase `wa_sessions` table currently has no `lid-mapping-*`,
`device-list-*`, or `tctoken-*` records. Its generic `id` and `data` columns can
store those v7 key types without a schema migration.

## Goals

- Make replies to inbound `@lid` conversations visible in WhatsApp.
- Preserve the exact inbound JID as the primary reply destination.
- Persist the known LID/phone-number pair before sending a reply.
- Support Baileys v7 auth key categories through the existing Supabase store.
- Surface Supabase persistence failures instead of silently continuing.
- Keep the project CommonJS and limit the ESM migration boundary.
- Preserve existing sessions and avoid automatic destructive recovery.

## Non-goals

- Rewriting the whole application as ESM.
- Changing the audit dashboard or AI response generation.
- Changing the Supabase schema.
- Clearing or recreating WhatsApp sessions automatically.
- Treating a returned message ID as proof of delivery.

## Selected Approach

Upgrade to the exact dependency `baileys@7.0.0-rc13` and load it through a
cached dynamic import. This is preferred over a full ESM conversion because it
limits unrelated changes, and over manually recreating v7 mapping behavior on
Baileys v6 because the latter would depend on unsupported internal protocol
details.

### Runtime loader

Add a small CommonJS-compatible runtime loader that:

1. calls `import('baileys')`;
2. caches the resulting promise so all consumers share one module instance;
3. returns the v7 exports needed by the gateway and auth store;
4. propagates import errors with actionable context.

The package manifest and lockfile will replace
`@whiskeysockets/baileys` with the exact version `baileys@7.0.0-rc13`.
The deployment runtime must use Node.js 20 or newer.

### WhatsApp connection

`connectToWhatsApp()` will await the runtime loader before creating the socket.
It will continue to use the existing Supabase auth state and use
`Browsers.macOS('Desktop')`.

The existing connection lifecycle, retry handling, audit logging, and message
deduplication remain in place unless a v7 API incompatibility requires a
targeted adaptation.

### Supabase auth state

The auth adapter will obtain `initAuthCreds`, `BufferJSON`,
`makeCacheableSignalKeyStore`, and `proto` from the runtime loader.

Its generic key loop will continue accepting arbitrary categories, including:

- `lid-mapping`;
- `device-list`;
- `tctoken`.

App-state keys will use
`proto.Message.AppStateSyncKeyData.create(value)`, because v7 removes
`fromObject()`.

Every Supabase `upsert`, `delete`, and session-clear operation will inspect the
returned `error` and throw a contextual error when persistence fails. This
prevents a successful-looking connection from running with incomplete auth
state.

### Inbound LID mapping and reply delivery

Before replying, the gateway will inspect the inbound key:

1. read the exact inbound `remoteJid`;
2. read `senderPn` when present;
3. when `remoteJid` ends with `@lid` and `senderPn` identifies a phone-number
   JID, call
   `sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn }])`;
4. send the reply to the exact inbound LID;
5. use the phone-number JID only if sending to the primary LID throws.

The mapping operation is idempotent. Missing `senderPn` is not fatal: the
gateway logs that it could not seed the mapping and still attempts the exact
inbound JID.

Mapping persistence errors are logged with the LID and failure context. They do
not get mislabeled as successful delivery. The existing fallback remains
available when a usable phone-number JID is known.

### Delivery semantics and logging

Logs will distinguish these states:

- response generated;
- LID mapping stored or unavailable;
- message submitted to the Baileys socket;
- delivery status received, when Baileys emits one;
- send or persistence error.

The wording will not say that a response was delivered solely because
`sendMessage()` returned a message ID. Baileys v7 may not emit all successful
ACK transitions, so the status listener remains diagnostic rather than a
required success signal.

## Data Flow

```text
Inbound WhatsApp event
        |
        v
remoteJid @lid + senderPn @s.whatsapp.net
        |
        v
Persist LID <-> PN mapping in signal repository/Supabase
        |
        v
Generate and audit AI response
        |
        v
sendMessage(exact inbound LID)
        |
        +-- throws --> sendMessage(phone-number fallback), if available
        |
        v
Log submission and any later status event
```

## Error Handling

- Dynamic import failure stops socket initialization with a clear dependency or
  runtime error.
- Supabase write/delete failures throw and include the affected auth key.
- A mapping failure is recorded before the reply attempt and preserves the
  phone-number fallback path.
- A primary send failure is recorded before the fallback attempt.
- If both destinations fail, the audit record retains the error details and the
  gateway does not claim successful delivery.
- Session rows are never deleted as an automatic recovery action.

## Test Strategy

Implementation will follow test-driven development.

### Unit and regression tests

- Add a failing test first for storing an inbound LID/PN pair before send.
- Verify the exact LID remains the primary destination.
- Verify the phone-number JID is only used after a primary send exception.
- Verify missing `senderPn` does not crash the reply path.
- Verify mapping persistence failures are observable and do not produce a false
  delivery claim.
- Test the cached dynamic loader and a Baileys import smoke path.
- Test Supabase auth storage for v7 key categories.
- Test that Supabase operation errors are propagated.
- Test app-state conversion with `.create()`.
- Preserve all existing reply-routing tests.

### Local verification

- `npm test`
- Node syntax checks for modified JavaScript files
- dynamic import smoke check for `baileys`
- `git diff --check`
- dependency inspection confirming only `baileys@7.0.0-rc13` is active

### Runtime acceptance on Render

- The service boots on Node.js 20 or newer without CommonJS/ESM errors.
- A new inbound LID message receives a visible WhatsApp reply.
- Logs show mapping storage and message submission without a send error.
- Supabase contains relevant v7 auth-state records after pairing and traffic;
  at minimum, the observed LID mapping is persisted.
- A phone-number-JID conversation continues to receive replies.

## Rollout

1. Add regression tests and observe the expected failure.
2. Replace the dependency and update the lockfile.
3. Add the cached v7 runtime loader.
4. Adapt the Supabase auth adapter.
5. Add mapping seeding to reply delivery.
6. Run the full verification suite.
7. Commit and push `main`.
8. Deploy `main` to Render and run the runtime acceptance checks.

Existing session records remain intact. A v7 upgrade can require relinking the
device so the new device and token state is fully populated. The application
will not clear the session automatically. If the preserved session cannot
connect cleanly, the operator will explicitly relink by QR after reviewing the
logs.

## Risks and Mitigations

- **Release candidate dependency:** pin the exact version, test its public APIs,
  and avoid floating updates.
- **ESM-only package:** isolate dynamic import behind one cached loader and test
  it on the deployment Node version.
- **Existing auth-state compatibility:** keep all current rows, support the new
  categories generically, and use explicit QR relinking only if required.
- **No success ACK:** use visible WhatsApp delivery as the runtime acceptance
  criterion and keep ACK logs diagnostic.
- **Incomplete LID information:** retain exact-JID sending and the known
  phone-number fallback without inventing mappings.

## Rollback

If v7 causes a deployment regression:

1. revert the migration commit;
2. restore the previous package lock and v6 dependency;
3. redeploy the reverted `main`;
4. retain all Supabase session rows, including any new v7 keys, until their
   cleanup is separately reviewed.

Rollback does not delete sessions or auth data.

## Acceptance Criteria

- All pre-existing and new tests pass.
- The installed Baileys package is exactly `7.0.0-rc13`.
- No scoped Baileys v6 runtime dependency remains.
- v7 LID, device-list, and token key categories can be persisted.
- Supabase persistence errors are no longer silent.
- An inbound LID/PN pair is stored before the reply is sent.
- The exact inbound LID remains the primary reply target.
- Logs distinguish socket submission from confirmed visibility/delivery.
- Render starts successfully on Node.js 20+.
- A test message receives a visible reply in WhatsApp.
- Only intentional project files are committed; diagnostic untracked files
  remain untouched.
