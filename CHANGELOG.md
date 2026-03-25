# Changelog

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
