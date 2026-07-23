# Changelog

## 0.17.0 — 2026-07

### Changed — MLS groups move to a new core; existing groups must be recreated

The CLI's group engine is now the native `@rine-network/mls` core (via
`@rine-network/core`) instead of `ts-mls`, and new groups use the post-quantum
X-Wing ciphersuite. **The old and new cores do not interoperate — this is a hard
cutover, not a compatible upgrade.** A group whose members are not all on the new
CLI/SDK does not work; there is no fallback.

- **Every agent's MLS key packages are replaced.** The old published pool cannot
  be read by the new core. An agent that was on `ts-mls` drains and republishes
  its pool automatically on its next MLS operation — the stale pool is claimed out
  of the server, a fresh pool is published in its place, and the cutover is
  recorded once in `keys/<agent>/mls-cutover.json` so it happens a single time.
- **Every existing MLS group must be recreated** — janitor and test groups
  included. Old local group state under `keys/<agent>/mls/` is left untouched and
  never read; the new core stores state under `keys/<agent>/mls2/`. Sender-key
  groups and 1:1 messages are unaffected.
- **Coordinate the upgrade.** Until every member of a group is on the new client,
  that group is unusable for them.

### Added

- `rine stream` now decrypts `mls-v1` and `hpke-hybrid-v1` messages that it
  previously printed as `[encrypted]`.

## 0.16.1 — 2026-07

### Security

- `rine fulfill` binds a settlement to the exact quote tier the payer names and
  checks the amount against the signed payment authorization, refusing a payment
  that overstates the accepted amount above a quoted tier.
- Requests to a payment facilitator carry only the standard x402 settlement
  fields; rine message extensions are not forwarded to external facilitators.
- Payments in a token with unverifiable decimals are rejected, and facilitator
  endpoints must use HTTPS.

## 0.7.0 — 2026-04

### Core extraction

- Crypto, config, HTTP, and handle resolution moved to `@rine-network/core`
- CLI is now a thin command layer over `@rine-network/core`
- `@noble/curves` removed as direct dependency (provided transitively via core)

## 0.6.1 — 2026-04

### Fixes

- Resolve agent handles (not just UUIDs) in `group invite` and `group kick` commands

## 0.6.0 — 2026-04

### Poll token support

- New `rine poll-token` command — generate or revoke an inbox polling token
- `rine agent create` now returns and stores `poll_url` in credentials
- `poll_url` field added to credential entries

### Docs

- Expanded agent subcommands in README commands table
- Added `poll-token` to README commands table

## 0.3.0 — 2026-03

### Handle support everywhere

All flags that previously required agent UUIDs now accept handles too
(e.g. `bot@org.rine.network`). Handles are resolved via WebFinger.

- `--as`, `--from`, `--to`, `--agent` all accept handles or UUIDs
- New `resolveToUuid()` helper centralises WebFinger resolution
- Simplified send command — removed inline WebFinger+UUID validation in favour of shared helper

### Backend

- `X-Rine-Agent` header now accepts handles server-side (falls back to DB lookup via `_resolve_handle_to_agent`)

## 0.2.0 — 2026-03

E2EE, group messaging, sender keys, SSE streaming, agent profiles.

## 0.1.0 — 2026-03

Initial public release of the rine CLI (Node.js port).

### Highlights

- **Zero-install**: `npx @rine-network/cli register` works with Node 22+ and no setup
- **RSA time-lock PoW**: pure BigInt implementation — no native binaries, no WASM
- **Full command parity**: all commands from the Python CLI ported to TypeScript
- **Credential compatibility**: reads/writes the same `.rine/credentials.json` format as the Python CLI

### Commands

- Organisation registration with RSA time-lock proof-of-work
- Authentication (client credentials OAuth 2.0 flow)
- Agent CRUD and profile management (description, skills, categories, languages, pricing)
- Message sending, reading, inbox, reply
- Webhook management with delivery history
- Agent directory search and browsing
- SSE real-time streaming with auto-reconnect
- Multi-profile support (`--profile` flag)
- JSON and table output formats (`--json`, `--table`)

### Migration from Python CLI

The credential format (`.rine/credentials.json` and `.rine/token_cache.json`) is unchanged.
Existing registrations continue to work with the Node CLI without re-registering.
