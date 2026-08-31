// The long-lived `rine relay` daemon. Structured on
// stream.ts (NOT withClient): it builds its own client, installs a SIGINT handler
// that flips stopped=true + exitCode=0, and runs a while(!stopped) reconnect loop
// with jittered backoff capped at 30s and in-loop token refresh. On startup and
// each reconnect it orchestrates the four subsystems IN ORDER:
//   (1) cert provision/renew → (2) control WS + mux tunnel →
//   (3) local TLS-terminating listener → (4) per-request verify/encrypt/post.
// This file is PURE orchestration: no inline ACME, no inline mux framing, no
// inline crypto — it calls the rine-core funnel entry points and the relay
// adapter. Lifecycle events mirror stream.ts emitLifecycle and NEVER carry a body.

import { resolve4 } from "node:dns/promises";
import { readFileSync } from "node:fs";
import {
	type AcmeOptions,
	type Frame,
	type HookRead,
	type HttpClient,
	IdempotencyStore,
	type IssueCertDeps,
	type LocalPipe,
	type TunnelClose,
	type WebhookRequest,
	agentKeysExist,
	agentLabel,
	buildIssueCertDeps,
	connectTunnel,
	ensureCert,
	getOrRefreshToken,
	handleWebhookRequest,
	jitteredRefreshMargin,
	loadHookSecret,
	loadMeta,
	makeEdgePipeFactory,
	renewalDueWithJitter,
	resolveApiUrl,
	resolveConfigDir,
	startTlsListener,
} from "@rine-network/core";
import type { Command } from "commander";
import { createClient } from "../action.js";
import { actorLadder } from "../acting-agent.js";
import { actorOption, namedActor } from "../actor.js";
import { printError } from "../output.js";
import type { GlobalOpts } from "../types.js";

interface RelayOpts {
	agent?: string;
	hook: string;
	port: string;
	secretFile?: string;
	secretEnv?: string;
	staging?: boolean;
	verbose?: boolean;
}

function emitLifecycle(
	json: boolean | undefined,
	data: Record<string, unknown>,
): void {
	if (json) console.log(JSON.stringify({ event: "lifecycle", data }));
}

function jitteredDelayMs(backoffSeconds: number): number {
	return Math.round(backoffSeconds * (0.5 + Math.random()) * 1000);
}

// Cadence of the standing renewal re-check. A long-connected relay's
// reconnect-loop ensureCert never fires past the renewal window, so this timer
// re-evaluates renewalDueWithJitter periodically. 12h is well under the 30-day
// renewal window + the 20-day jitter spread, so the deterministic
// per-agent renewal instant is never missed by more than half a day.
const RENEWAL_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse --port into a valid TCP port. `0` is accepted as "OS-assign an ephemeral
 * port" (it is NOT coerced to the default — that coercion was the footgun); a
 * non-integer or out-of-range value throws a clear error rather than silently
 * falling back. The default flag value "8443" parses straight through.
 */
function parsePort(raw: string): number {
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid --port '${raw}': expected an integer 0-65535.`);
	}
	return port;
}

function isRevoked(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { revoked?: boolean }).revoked === true
	);
}

/**
 * Resolve the HMAC secret: --secret-env > --secret-file > the persisted file.
 * Returns "" (after a stderr warning naming the three sources tried) when none is
 * found. An empty secret is NOT safe to run with: an attacker who controls the
 * body can compute `HMAC("", body)` and forge a "verified" self-send, so the
 * caller (runRelayLoop) HARD-REFUSES to start on an empty result — the relay never
 * enters the reconnect loop or opens the listener without a secret.
 */
function resolveSecret(
	opts: RelayOpts,
	configDir: string,
	agentId: string,
): string {
	if (opts.secretEnv) {
		const v = process.env[opts.secretEnv];
		if (v) return v.trim();
	}
	if (opts.secretFile) return readFileSync(opts.secretFile, "utf-8").trim();
	const stored = loadHookSecret(configDir, agentId, opts.hook);
	if (stored) return stored;
	process.stderr.write(
		`No hook secret found (tried --secret-env, --secret-file, and ${configDir}/funnel/${agentId}/${opts.hook}.secret) — all inbound requests will fail verification until one is provided.\n`,
	);
	return "";
}

export function registerRelay(program: Command): void {
	program
		.command("relay")
		.description(
			"Run the inbound webhook funnel relay (long-lived foreground daemon)",
		)
		.addOption(actorOption())
		.option("--hook <name>", "Hook name to relay", "default")
		.option("--port <n>", "Local TLS listener port", "8443")
		.option("--secret-file <path>", "Read the HMAC secret from a file")
		.option("--secret-env <VAR>", "Read the HMAC secret from an env var")
		.option("--staging", "Use the Let's Encrypt staging CA (dev)")
		.option("--verbose", "Verbose reconnect logging")
		.action(async (opts: RelayOpts, command: Command) => {
			try {
				const gOpts = program.opts<GlobalOpts>();
				const configDir = resolveConfigDir();
				const apiUrl = resolveApiUrl();
				const { client, profileName, entry } = await createClient(
					configDir,
					apiUrl,
					gOpts.profile,
				);

				const { actingAgent } = actorLadder(namedActor(command, gOpts), client);
				const agentId = await actingAgent();

				if (!agentKeysExist(configDir, agentId)) {
					printError(
						`Agent identity keys not found under ${configDir}/keys/${agentId}/ — register first.`,
					);
					process.exitCode = 2;
					return;
				}

				await runRelayLoop({
					opts,
					gOpts,
					configDir,
					apiUrl,
					agentId,
					client,
					profileName,
					entry,
				});
			} catch (err) {
				printError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		});
}

interface RelayCtx {
	opts: RelayOpts;
	gOpts: GlobalOpts;
	configDir: string;
	apiUrl: string;
	agentId: string;
	client: HttpClient;
	profileName: string;
	entry: Parameters<typeof getOrRefreshToken>[2];
}

async function runRelayLoop(ctx: RelayCtx): Promise<void> {
	const {
		opts,
		gOpts,
		configDir,
		apiUrl,
		agentId,
		client,
		profileName,
		entry,
	} = ctx;
	const json = gOpts.json;
	const port = parsePort(opts.port);
	const secret = resolveSecret(opts, configDir, agentId);
	if (secret.length === 0) {
		// Fail closed: a relay running with an empty HMAC secret is forgeable
		// — an attacker who controls the body computes HMAC("", body) and self-sends
		// a "verified" rine.v1.webhook. Refuse to start; never open the listener.
		printError(
			`No hook secret resolved for '${opts.hook}' — refusing to start. Provide one via --secret-env, --secret-file, or persist it under ${configDir}/funnel/${agentId}/${opts.hook}.secret.`,
		);
		process.exitCode = 2;
		return;
	}
	const options: AcmeOptions = { staging: opts.staging };

	let backoff = 1;
	let attempt = 0;
	let stopped = false;
	// Drawn once for this long-lived relay so co-located agents desynchronize their
	// token refreshes across reconnects.
	const refreshMargin = jitteredRefreshMargin();
	let lastDeps: IssueCertDeps | undefined;
	// The cert-cache handle for the active ZERO-TRUST hook — the per-agent label,
	// so every hook of an agent shares ONE wildcard cert cache.
	// Hoisted so the standing renewal timer re-checks the SAME entry
	// ensureCert wrote under.
	let certHandle: string | undefined;
	// Single-flight guard over ensureCert: the reconnect loop and the standing
	// renewal timer both issue/renew the SAME per-agent wildcard, so they
	// MUST NOT run concurrently (a double ACME order would burn the LE
	// duplicate-cert budget). Whoever holds it wins; the other defers.
	let certBusy = false;
	let renewalTimer: ReturnType<typeof setInterval> | undefined;
	// One replay-de-dup store for the whole relay process — persists across
	// reconnects so a tunnel flap can't re-admit a captured signed delivery.
	// Bounded + TTL-evicting; HMAC verify stays the authenticator, this only
	// drops a post-verify duplicate so it can't mint a second rine.v1.webhook.
	const idempotency = new IdempotencyStore();
	process.on("SIGINT", () => {
		stopped = true;
		process.exitCode = 0;
		if (renewalTimer) clearInterval(renewalTimer);
	});

	// Standing renewal re-check. The reconnect loop's ensureCert only runs
	// on (re)connect, so a relay that stays connected past the 30-day renewal window
	// would NEVER renew its per-agent wildcard until it next reconnects. This timer
	// re-evaluates renewalDueWithJitter (the deterministic per-agent jitter)
	// on a ~12h cadence and renews when due — guarded by certBusy so it never races
	// the reconnect loop's ensureCert (a double order burns the LE duplicate-cert budget).
	const startRenewalTimer = (): void => {
		if (renewalTimer) return;
		renewalTimer = setInterval(() => {
			void maybeRenewCert();
		}, RENEWAL_CHECK_INTERVAL_MS);
		// Don't keep the process alive for the timer alone — the reconnect loop owns
		// the lifecycle; the timer is a best-effort background re-check.
		renewalTimer.unref?.();
	};

	const maybeRenewCert = async (): Promise<void> => {
		if (stopped || certBusy || !certHandle || !lastDeps) return;
		const meta = loadMeta(configDir, certHandle, options);
		if (!meta || !renewalDueWithJitter(meta, certHandle, Date.now())) return;
		certBusy = true;
		try {
			await ensureCert({
				handle: certHandle,
				agentId,
				delegationId: certHandle,
				configDir,
				options,
				deps: lastDeps,
			});
			emitLifecycle(json, { state: "cert_renewed", handle: certHandle });
		} catch (err) {
			emitLifecycle(json, {
				state: "cert_renew_error",
				handle: certHandle,
				reason: err instanceof Error ? err.message : String(err),
			});
		} finally {
			certBusy = false;
		}
	};

	while (!stopped) {
		attempt++;
		let listener: { close(): void } | undefined;
		try {
			// Resolve the SERVER-allocated hook row — its `hostname` is the source of
			// truth for BOTH the cert CN/SAN and the BIND, `control_ws_url` is the
			// broker control-WS endpoint used VERBATIM (never reconstructed from the
			// API base — that resolves to the primary IP / Caddy, which has NO funnel
			// route), and `termination` is the tier. A failed lookup throws →
			// backoff-reconnect (never a fabricated, unroutable name).
			const hook = await resolveHook(client, agentId, opts.hook);
			const { hostname, control_ws_url: controlWsUrl } = hook;

			// (4) The per-request handler is IDENTICAL across tiers:
			// HMAC-verify the RAW body → fetch keys → encrypt `hpke-v1` → self-send
			// `rine.v1.webhook`. Only HOW the request bytes arrive differs (local TLS
			// terminate for zero-trust; broker-forwarded plaintext for shared-edge).
			const onRequest = (req: WebhookRequest) =>
				handleWebhookRequest(
					{
						configDir,
						agentId,
						hookName: opts.hook,
						secret,
						client,
						idempotency,
						emitLifecycle: (ev) => json && console.log(JSON.stringify(ev)),
					},
					req,
				).then(() => undefined);

			// Branch ONCE on the tier, BEFORE any label/FQDN derivation:
			// the zero-trust agentLabel deriver hard-codes
			// `.hook.rine.network`, so a shared-edge `.edge` host must never reach it.
			// Zero-trust defers its TLS listener to AFTER the tunnel connects (the
			// lazy `ref` holder — orchestration order: cert→tunnel→listener,
			// safe because no OPEN arrives before the holder is populated); shared-edge
			// has no listener, so its `openLocalPipe` factory is ready immediately.
			const ref: { live?: { openLocalPipe(frame: Frame): LocalPipe } } = {};
			let ztCert: Awaited<ReturnType<typeof ensureCert>> | undefined;
			let openLocalPipe: (frame: Frame) => LocalPipe;
			if (hook.termination === "shared_edge") {
				// Shared-edge: the BROKER terminates the external TLS and forwards the
				// DECRYPTED request down the mux. The relay runs NO local TLS listener
				// and issues NO cert — it just parses the forwarded plaintext, runs the
				// SAME adapter, and synthesizes the 204/400/500 (edge-pipe). The trust
				// boundary at REST is unchanged (HMAC + `hpke-v1` stay relay-side).
				certHandle = undefined;
				openLocalPipe = makeEdgePipeFactory({ onRequest });
				emitLifecycle(json, { state: "shared_edge_ready", hostname });
			} else if (hook.termination === "zero_trust") {
				// Zero-trust: the cert handle is the per-agent label — the second-to-last
				// DNS label before `.hook.rine.network`. One shared
				// `*.{agentLabel}.hook` wildcard covers every hook of the agent, so every
				// hook-relay of that agent keys the SAME cert cache.
				certHandle = agentLabel(hostname);

				// (1) Cert provision/renew — the private key stays local. The
				// propagation poll targets the FQDN the backend returns from dns-challenge
				// `set`, so the relay never needs the server's delegation_id up front.
				// `certBusy` is a best-effort in-process guard that keeps the standing
				// renewal timer from firing an overlapping ensureCert; the HARD
				// duplicate-cert guarantee is ensureCert's own cross-process per-agent
				// issuance lock (a second concurrent caller reuses the
				// sibling's cert instead of firing a second ACME order).
				lastDeps = await buildIssueCertDeps({
					configDir,
					options,
					http: client,
					agentId,
				});
				certBusy = true;
				try {
					ztCert = await ensureCert({
						handle: certHandle,
						agentId,
						delegationId: certHandle,
						configDir,
						options,
						deps: lastDeps,
					});
				} finally {
					certBusy = false;
				}
				emitLifecycle(json, { state: "cert_ready", hostname });
				openLocalPipe = (frame: Frame) => {
					if (!ref.live) throw new Error("listener not ready");
					return ref.live.openLocalPipe(frame);
				};
			} else {
				// An unknown tier from a newer backend — fail LOUD + FATAL rather than
				// wire a path this build cannot serve (mirrors the old ZT-only gate).
				throw new UnsupportedTierError(hook.termination);
			}

			// Mint the BIND Bearer HERE — AFTER any cold cert issuance, immediately
			// before the upgrade. A cold/renewal issuance can block for the grace
			// delay + poll (~3 min); a token fetched before it could expire (cache
			// floor is 60s) and the broker would NAK the BIND — or worse, revoke.
			const token = await getOrRefreshToken(
				configDir,
				apiUrl,
				entry,
				profileName,
				{ force: false, envToken: process.env.RINE_TOKEN, refreshMargin },
			);

			// (2) Control WS + mux tunnel. Bearer at the upgrade; the
			// backend validates the full org→agent→hostname chain.
			const tunnel = await connectTunnel({
				controlWsUrl,
				token,
				agentId,
				hostname,
				openLocalPipe,
			});
			emitLifecycle(json, { state: "tunnel_connected" });

			if (hook.termination === "zero_trust" && ztCert) {
				// (3) Local TLS-terminating listener — terminates the GitHub TLS that
				// was shoveled raw down the mux; (4) per-request verify→encrypt→post.
				const live = await startTlsListener({
					port,
					certPem: ztCert.certPem,
					keyPem: ztCert.keyPem,
					onRequest,
				});
				listener = live;
				ref.live = live;

				// The per-agent `*.{agentLabel}.hook` A record is a DELIVERY
				// prerequisite, NOT a cert-validation one (DNS-01 validates the independent
				// challenge TXT), so a healthy cert can still be undeliverable if the
				// backend's best-effort A write failed. Surface it LOUDLY (non-fatal: the
				// backend self-heals the A on the next ZT-hook create). The
				// shared-edge `.edge` host resolves via the server-managed static `*.edge`
				// A, so there is no per-agent A to assert there.
				await assertAgentARecord(hostname, json);
				emitLifecycle(json, { state: "listener_ready", port: live.port });
				// Arm the standing renewal re-check so a long-connected relay actually
				// renews. Shared-edge holds no cert, so it skips this.
				startRenewalTimer();
			}
			backoff = 1; // a clean re-establish resets the backoff

			const close = await waitForClose(tunnel, () => stopped);
			tunnel.close();
			listener?.close();
			if (stopped) break;

			// WS dropped with no stop signal → reconnect. An orderly
			// broker close (1000/1001/bare drop) reconnects IMMEDIATELY with backoff
			// reset to 1 (mirrors stream.ts:279); an abnormal close gets the jittered
			// backoff so a flapping broker can't be hammered.
			if (close?.clean !== false) {
				emitLifecycle(json, {
					state: "tunnel_reconnecting",
					attempt: attempt + 1,
					backoff_ms: 0,
					reason: "server_close",
				});
				backoff = 1;
			} else {
				const delay = jitteredDelayMs(backoff);
				emitLifecycle(json, {
					state: "tunnel_reconnecting",
					attempt: attempt + 1,
					backoff_ms: delay,
					reason: "error",
				});
				await sleep(delay);
				backoff = Math.min(backoff * 2, 30);
			}
		} catch (err) {
			listener?.close();
			if (stopped) break;
			if (err instanceof UnsupportedTierError) {
				// An unknown tier from a newer backend: fail LOUD and FATAL — never
				// backoff-retry a tier this build cannot serve.
				if (renewalTimer) clearInterval(renewalTimer);
				printError(err.message);
				process.exitCode = 2;
				return;
			}
			if (isRevoked(err)) {
				// Do NOT revoke/wipe the per-agent wildcard on a single
				// hook's BIND-revoked — it is SHARED across every other live hook of the
				// agent, so revoking here would kill all of them. The kill switch is
				// server-side DNS+route teardown; the relay just exits.
				if (renewalTimer) clearInterval(renewalTimer);
				emitLifecycle(json, { state: "tunnel_revoked" });
				process.exitCode = 1;
				return;
			}
			const delay = jitteredDelayMs(backoff);
			emitLifecycle(json, {
				state: "tunnel_reconnecting",
				attempt: attempt + 1,
				backoff_ms: delay,
				reason: "error",
			});
			if (opts.verbose)
				process.stderr.write(
					`Reconnecting (attempt ${attempt + 1}, error): ${
						err instanceof Error ? (err.stack ?? err.message) : String(err)
					}\n`,
				);
			await sleep(delay);
			backoff = Math.min(backoff * 2, 30);
		}
	}
	if (renewalTimer) clearInterval(renewalTimer);
	emitLifecycle(json, { state: "stopped", reason: "signal" });
}

/**
 * Resolve when the tunnel WS closes (carrying the classified close so the caller
 * can pick clean-vs-error reconnect) OR a SIGINT arrives (resolves `undefined`;
 * the caller's `stopped` flag short-circuits before the reconnect branch).
 */
function waitForClose(
	tunnel: {
		onClose(cb: (close: TunnelClose) => void): void;
		close(): void;
	},
	isStopped: () => boolean,
): Promise<TunnelClose | undefined> {
	return new Promise<TunnelClose | undefined>((resolve) => {
		if (isStopped()) return resolve(undefined);
		tunnel.onClose((close) => resolve(close));
		process.once("SIGINT", () => {
			tunnel.close();
			resolve(undefined);
		});
	});
}

/**
 * The server hook row — the SINGLE source of truth, used VERBATIM. Its
 * `hostname` (the zero-trust `{hook}.{agentLabel}.hook.rine.network` form) goes
 * into the BIND and (via its agent label) the cert CN/SAN; its `control_ws_url`
 * is the broker control-WS endpoint the relay dials; its `termination` is the
 * tier. NEITHER is reconstructed client-side: a fabricated name matches no
 * funnel_hook row (BIND would NAK, the cert would never match GitHub's TLS), and
 * the API base resolves to the primary IP / Caddy, which has no funnel route. On
 * a missing row or a transient lookup failure we THROW so the loop backs off and
 * retries.
 */
async function resolveHook(
	client: HttpClient,
	agentId: string,
	hookName: string,
): Promise<HookRead> {
	const data = (await client.get(`/agents/${agentId}/funnel/hooks`, {})) as
		| { items?: HookRead[] }
		| undefined;
	const hook = data?.items?.find((h) => h.hook_name === hookName);
	if (!hook?.hostname || !hook.control_ws_url) {
		throw new Error(
			`No funnel hook '${hookName}' found for agent ${agentId} — run \`rine hook create --name ${hookName}\` first.`,
		);
	}
	return hook;
}

/**
 * Fatal — this build implements the zero-trust and shared-edge tiers; an UNKNOWN
 * `termination` value from a newer backend is thrown (not retried) so the relay
 * never enters a backoff loop it cannot escape. Upgrade the CLI to serve it.
 */
class UnsupportedTierError extends Error {
	constructor(tier: string) {
		super(
			`This hook uses a TLS-termination mode ('${tier}') this relay build does not support. ` +
				"Upgrade the CLI to a newer build, or recreate the hook with a supported --tier.",
		);
		this.name = "UnsupportedTierError";
	}
}

/**
 * Assert the zero-trust hostname resolves to an A record before
 * declaring the listener ready. The per-agent `*.{agentLabel}.hook` A is a
 * DELIVERY prerequisite written best-effort by the backend; a
 * healthy cert does NOT imply a routable name (DNS-01 validates the independent
 * challenge TXT). Non-fatal — emit a loud `dns_a_missing` event and continue (the
 * cert is valid and the backend self-heals the A on the next ZT-hook create), so
 * a missing A is surfaced rather than a silent black hole.
 */
async function assertAgentARecord(
	hostname: string,
	json: boolean | undefined,
): Promise<void> {
	try {
		const addrs = await resolve4(hostname);
		if (addrs.length === 0) {
			emitLifecycle(json, { state: "dns_a_missing", hostname });
		}
	} catch {
		emitLifecycle(json, { state: "dns_a_missing", hostname });
	}
}
