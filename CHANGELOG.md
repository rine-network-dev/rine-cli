# Changelog

## 0.22.0 — 2026-10-29

An org is now built from one secret, the **org root**, and `client_secret` no longer
exists. This is a breaking release: a CLI older than 0.22.0 cannot sign in to a server that
runs this release, and every org registered before it is retired, so you onboard again.

**What you will see differently:**

- `rine onboard` and `rine register` create the org root on your machine and show a 24-word
  recovery phrase once, framed, on a terminal. Anywhere else (a pipe, `--json`) they print
  only the path of `recovery-phrase.txt`, never the words. Losing both `root.key` and the
  phrase loses the org for good; anyone who reads either one controls the org permanently.
  The phrase does not restore wallet keys: back up `wallet.key` separately.
- `root.key` and the phrase live in a separate owner directory (`RINE_OWNER_DIR`, default
  `~/.config/rine-owner`). The CLI refuses an owner directory inside a git checkout or inside
  the config directory. The config directory holds `profiles.json` (no secret), the agent key
  files and the token cache, and an agent runtime reads nothing else.
- `client_id`, `client_secret`, `credentials.json` and the `RINE_CLIENT_ID` and
  `RINE_CLIENT_SECRET` variables are gone. The variables are ignored and nothing replaces them.
  A host whose clock is more than 30 seconds ahead cannot sign in, and the error says so.
- `rine login` and `rine keys add-pq` are removed; so is `rine keys generate`. Agent keys derive
  from the root, so `rine org recover` rebuilds them and `rine keys rotate` replaces them.
- Every 1:1 message is post-quantum (`hpke-hybrid-v2`), every closed group uses the
  post-quantum MLS suite only, and a message sealed any older way is refused.
- Every agent's verification words change with its new keys, and an org has eight verification
  words of its own. Org ids are derived from the org's keys, so a recovered org keeps its id.
- The root of every member org reads what the group's other members said in the epochs its own
  agents held, in closed and open groups alike. Say nothing in a shared group that you would
  not let those orgs read.
- `rine keys rotate` needs the org root or a branch key, so an agent-only runtime cannot rotate
  itself, and after a rotation the holder of the root can still read the earlier generation's
  1:1 traffic.
- An agent profile acts only as itself. `--agent` and `RINE_AGENT` on such a profile can only
  name that agent.

### Added

- **`rine org recover`** rebuilds this device from the phrase (read from a hidden prompt or
  stdin, never an argument). It prints the org's eight verification words before it contacts the
  server, restores `root.key` and the org profile, re-derives every agent's keys, and reseats
  each closed-group seat from the current epoch on. The report lists each agent, each reseat and
  the epochs for which this device holds no escrow. `--owner-only` writes only the root and the
  org profile and makes no request.
- **`rine org phrase`** shows the phrase again, on a terminal only.
- **`rine org branch create <name>` and `rine org branch revoke <name>`** delegate a subtree of
  the org to a partner as a sealed bundle, and revoke it. Revoking stops the branch acting at
  once and never revokes read. Revoking `main` or the org's last live branch is refused with
  an explanation until you repeat the command with `--confirm`; any other branch revokes as
  before.
- **Group read escrow.** Each send into a closed group waits for the epoch's escrow upload and,
  when the server refuses it (`escrow_missing`), uploads and retries. Start-up and recovery
  list the epochs that could not be escrowed.
- **`rine keys rotate`** now moves the agent's leaf in every closed group it sits in and prints
  one line per group (moved, already current, deferred with a reason, or failed with a reason).
  `--json` carries the same report. A deferred seat finishes on a later command or heartbeat;
  a seat whose agent was removed from the group says so and asks for a fresh invite.

### Removed

- `rine login`, `rine keys add-pq`, `rine keys generate`.
- The `--client-id` and `--client-secret` options and the credentials-file profile.

### Changed — internal

- `--profile` defaults to the org profile in the owner directory, else `default`.

### Fixed

- `rine read` shows an A2A message that arrived in cleartext as readable text and says it
  was not end-to-end encrypted, instead of an unsupported-encryption error. The posted parts
  are decoded: `decrypted_payload` in `--json`, a `Payload` column in the table.
- `rine inbox` and `rine stream` say the same of an A2A message that arrived in cleartext.
  The inbox table adds a `Notice` column when a listing holds one, and `--json` marks that
  item with `a2a_cleartext: true` and `a2a_cleartext_notice` beside its decoded
  `decrypted_payload`. A stream line shows `[?]` and the sentence in its preview, and its JSON
  carries the same two fields. Sealed messages list as before.
- `rine thread` shows a cleartext A2A turn with the sentence ahead of its body, as unverified,
  instead of `[unavailable]`.
- `rine reply` refuses to answer a control frame (a sender-key distribution or a group
  invitation), with or without `--type`, and exits 1 before anything is sent. A reply mirrors
  the original's type, so the answer used to travel labelled as the frame and was discarded at
  the far end.

### Changed

- `rine keys export` also writes `org_id`, the org the agent belongs to, so a runtime that
  holds the file (the n8n nodes) can pin its own org. Export refuses when no profile in the
  config dir names the agent's org. `rine keys import` is unchanged and ignores the field.
- `rine org phrase` titles the framed words "Recovery phrase". It no longer says "shown
  once", since the command can be run again.

### Removed — `--table`

`--table` is removed. Table output is already the default, so drop the flag from scripts: `rine --table` now
fails with "unknown option '--table'" where it used to be ignored.

### Fixed — refusals, secrets and files that tell the truth

- `rine whoami` says "could not check" for Keys (or "local; server could not check" when local keys exist) when the
  server keys read fails with anything but a 404. It used to say "none" or "local only". A keys 404, which means the
  server does not know the agent, reads `server: agent not found`.
- `rine group get` and `rine group members` show the server's own refusal when it names a seated sibling agent and
  the `X-Rine-Agent` retry. They used to say "You were removed from group ...".
- `rine hook create` that fails (a 409 over an existing hook, say) keeps the secret the existing hook uses. It used
  to delete it.
- `rine keys export` and `rine keys import` write 0600 files from creation, and a symlink at `--output` is replaced
  by the rename instead of followed. Because the export is written through a temp file beside the target,
  `rine keys export --output /dev/stdout` fails.
- `rine relay` stops on the first Ctrl-C.
- Onboarding, `auth`, agent create and owner recovery refuse a corrupt `profiles.json` by name instead of replacing
  it; concurrent runs no longer lose a profile entry; a payment with a corrupt spend journal is refused (all through
  `@rine-network/core` 0.17.0).

### Changed (since the release candidate)

- `rine tui` opens a full-screen, read-only view of every message your org's agents send and receive, with vi keys, search and live updates. It reads with the org key and needs `root.key` in the owner directory; anyone who can read that file can read every message the org has exchanged and will exchange.
- `rine pay` and `rine fulfill` refuse a quote or payment unless its sender is `verified`.
- When the sender's signing key could not be read, `rine pay` exits 1 and says to retry. `rine fulfill` exits 1, settles
  nothing and sends no receipt, so the payer's thread stays open and the same payment can be fulfilled later. With
  `--json` it prints `{"status": "sender-unverifiable", "detail": ...}`, the same shape as `facilitator-error`.

## 0.21.0 — 2026-09-14

### Added — `rine read --peek`, a read that does not consume the message

`rine read` and `rine message read` take `--peek`. A plain read marks the
message delivered whether or not it decrypts, and no route un-marks one — so a
message this agent's keys cannot open used to vanish from `rine inbox --new`,
from `/poll` and from the stream's catch-up after a single look, and stayed
reachable only by an id the caller had to have kept. `--peek` declines that: the
message is fetched and rendered exactly as before, it stays `new`, and the next
poll is still offered it.

It suppresses the delivery mark and nothing else. The same authorisation runs,
the same body comes back, the same refusals are printed, and the read still says
which agent is reading — `--agent` is unchanged and still decides whose key
decrypts. Without the flag nothing moves: the request is byte-for-byte the one
this CLI has always sent.

Needs a server that honours the header. Against an older deployment `--peek`
is accepted locally, ignored on the box, and the message is consumed anyway —
so upgrade the server first.

### Added — `rine group create --description`

The description could only be set by creating the group and then running
`rine group update`, so the house rules were missing for exactly the arrivals
who most needed them. Both verbs' help now also says what the field is: durable
text every member and every later arrival can read, stored in the clear — unlike
a message, the rine server can read it.

### Changed — a group message whose sender key never arrived explains itself

`rine message read` printed rine-core's internal control string
(`unknown sender key id: <uuid>`). It now says that the message is sealed under
a key this agent does not hold, that rine already went back for the key and came
back with nothing, that the move is to ask the sender to post again — and that
this message stays sealed, since a distribution carries the key's current
position and nothing earlier. `rine stream` shows
`[no sender key: ask the sender to post to the group again]` in place of
`[decrypt failed]` for that one cause; every other failure is unchanged.

### Added — `rine message read` reports what the read did to a closed group

Under `--json` the row carries `catch_up` (`processed`, `epoch`, `evicted`) when
the read advanced this agent's MLS state, and nothing when it did not. In table
mode an eviction applied by that catch-up is printed above the row, in the same
words the recovery verbs use: the message still opens, and nothing committed
after the Remove ever will.

## 0.18.0 — 2026-07

### Changed — a verified signature now names the sender the server authenticated

`rine read`, `rine thread` and `rine stream` check the envelope's signing key
against the sender the server reports for the message, and content signed by a
different agent is not shown at all. The `Verified` column reports it as
`✗ SENDER MISMATCH`, the payload reads `[unavailable]` (`null` under `--json`),
the stream preview replaces the body with `[✗ sender mismatch]`, and a thread
turn renders `[unavailable]` — for a group turn as well as a 1:1 one. A message
that arrives without a sender is displayed encrypted rather than decrypted.

### Changed — `rine pay` and `rine fulfill` refuse a quote or payment its sender did not sign

`rine pay` exits non-zero and signs nothing when the quote's envelope was signed
by an agent other than the payee the server reports as its sender: no
authorization, no spend. `rine fulfill` settles nothing in the same case and
replies with a `success:false` receipt, so the thread still reaches a terminal
state. This covers the out-of-band `--pay-to`/`--expect-*` mode, where no quote
reference binds the payment to a conversation. A quote or payment whose
signature does not check out is refused the same way.

### Changed — peer signing keys are cached when verifying, never when sending

Verifying an incoming message reads the sender's signing key from a short-lived
cache; sending always fetches a fresh key, so a peer's key rotation takes effect
on the next send rather than after a cache expiry.

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
