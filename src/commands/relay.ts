// REQ-CLI-06/07/08/09 — the long-lived `rine relay` daemon. Structured on
// stream.ts (NOT withClient): it builds its own client, installs a SIGINT handler
// that flips stopped=true + exitCode=0, and runs a while(!stopped) reconnect loop
// with jittered backoff capped at 30s and in-loop token refresh. On startup and
// each reconnect it orchestrates the four subsystems IN ORDER:
//   (1) cert provision/renew (REQ-CERT) → (2) control WS + mux tunnel (REQ-TUN) →
//   (3) local TLS-terminating listener → (4) per-request verify/encrypt/post.
// This file is PURE orchestration: no inline ACME, no inline mux framing, no
// inline crypto — it calls the rine-core funnel entry points and the relay
// adapter. Lifecycle events mirror stream.ts emitLifecycle and NEVER carry a body.

import { readFileSync } from "node:fs";
import {
	agentKeysExist,
	buildIssueCertDeps,
	connectTunnel,
	ensureCert,
	type Frame,
	fetchAgents,
	getOrRefreshToken,
	type HookRead,
	type HttpClient,
	handleWebhookRequest,
	type IssueCertDeps,
	type LocalPipe,
	loadHookSecret,
	resolveAgent,
	resolveApiUrl,
	resolveConfigDir,
	revokeAndWipeCache,
	startTlsListener,
	type TunnelClose,
} from "@rine-network/core";
import type { Command } from "commander";
import { createClient } from "../action.js";
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

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse --port into a valid TCP port. `0` is accepted as "OS-assign an ephemeral
 * port" (it is NOT coerced to the default — that was the L3 footgun); a
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
 * Returns "" (and warns, naming the three sources tried) when none is found — an
 * empty secret can never match GitHub's real signature, so every request drops
 * safely rather than relaying an unverified body.
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
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.option("--hook <name>", "Hook name to relay", "default")
		.option("--port <n>", "Local TLS listener port", "8443")
		.option("--secret-file <path>", "Read the HMAC secret from a file")
		.option("--secret-env <VAR>", "Read the HMAC secret from an env var")
		.option("--staging", "Use the Let's Encrypt staging CA (dev)")
		.option("--verbose", "Verbose reconnect logging")
		.action(async (opts: RelayOpts) => {
			try {
				const gOpts = program.opts<GlobalOpts>();
				const configDir = resolveConfigDir();
				const apiUrl = resolveApiUrl();
				const { client, profileName, entry } = await createClient(
					configDir,
					apiUrl,
					gOpts.profile,
				);

				const agents = await fetchAgents(client);
				const agentId = await resolveAgent(
					apiUrl,
					agents,
					opts.agent,
					gOpts.as,
				);

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
	const options = { staging: opts.staging };

	let backoff = 1;
	let attempt = 0;
	let stopped = false;
	let lastDeps: IssueCertDeps | undefined;
	// The cert-cache handle for the active hook (its DNS label) — hoisted so the
	// revoked-teardown path wipes the SAME cache entry ensureCert wrote under.
	let certHandle: string | undefined;
	process.on("SIGINT", () => {
		stopped = true;
		process.exitCode = 0;
	});

	while (!stopped) {
		attempt++;
		let listener: { close(): void } | undefined;
		try {
			// Resolve the SERVER-allocated hook row ONCE — its `hostname` is the
			// source of truth for BOTH the cert CN/SAN and the BIND, and its
			// `control_ws_url` is the broker control-WS endpoint used VERBATIM (never
			// reconstructed from the API base — that resolves to the primary IP /
			// Caddy, which has NO funnel route). The cert handle is the hostname's DNS
			// LABEL (the `{hook}--{slug}` part before `.hook.rine.network`), so the
			// issued leaf's name == the public hostname GitHub does TLS to. A failed
			// lookup throws → backoff-reconnect (never a fabricated, unroutable name).
			const { hostname, control_ws_url: controlWsUrl } = await resolveHook(
				client,
				agentId,
				opts.hook,
			);
			certHandle = hookLabel(hostname);

			// (1) Cert provision/renew (REQ-CERT) — the private key stays local. The
			// propagation poll targets the FQDN the backend returns from dns-challenge
			// `set`, so the relay never needs the server's delegation_id up front.
			lastDeps = await buildIssueCertDeps({
				configDir,
				options,
				http: client,
				agentId,
			});
			const cert = await ensureCert({
				handle: certHandle,
				agentId,
				delegationId: certHandle,
				configDir,
				options,
				deps: lastDeps,
			});
			emitLifecycle(json, { state: "cert_ready", hostname });

			// The listener is stood up just below; the tunnel's openLocalPipe is a
			// lazy factory invoked per mux OPEN, so connecting (2) before standing
			// up (3) is safe — no OPEN can arrive before the holder is populated.
			const ref: { live?: { openLocalPipe(frame: Frame): LocalPipe } } = {};

			// Mint the BIND Bearer HERE — AFTER ensureCert, immediately before the
			// upgrade. A cold/renewal issuance can block for the grace delay + poll
			// (~3 min); a token fetched before it could expire (cache floor is 60s)
			// and the broker would NAK the BIND — or worse, revoke. Fetching now
			// guarantees a fresh token at the upgrade.
			const token = await getOrRefreshToken(
				configDir,
				apiUrl,
				entry,
				profileName,
				{ force: false, envToken: process.env.RINE_TOKEN },
			);

			// (2) Control WS + mux tunnel (REQ-TUN). Bearer at the upgrade; the
			// backend validates the full org→agent→hostname chain.
			const tunnel = await connectTunnel({
				controlWsUrl,
				token,
				agentId,
				hostname,
				openLocalPipe: (frame: Frame) => {
					if (!ref.live) throw new Error("listener not ready");
					return ref.live.openLocalPipe(frame);
				},
			});
			emitLifecycle(json, { state: "tunnel_connected" });

			// (3) Local TLS-terminating listener — terminates the GitHub TLS that
			// was shoveled raw down the mux; (4) per-request verify→encrypt→post.
			const live = await startTlsListener({
				port,
				certPem: cert.certPem,
				keyPem: cert.keyPem,
				onRequest: (req) =>
					handleWebhookRequest(
						{
							configDir,
							agentId,
							hookName: opts.hook,
							secret,
							client,
							emitLifecycle: (ev) => json && console.log(JSON.stringify(ev)),
						},
						req,
					).then(() => undefined),
			});
			listener = live;
			ref.live = live;
			emitLifecycle(json, { state: "listener_ready", port: live.port });
			backoff = 1; // a clean re-establish resets the backoff

			const close = await waitForClose(tunnel, () => stopped);
			tunnel.close();
			live.close();
			if (stopped) break;

			// WS dropped with no stop signal → reconnect (REQ-TUN-14). An orderly
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
			if (isRevoked(err)) {
				emitLifecycle(json, { state: "tunnel_revoked" });
				if (lastDeps && certHandle) {
					await revokeAndWipeCache({
						handle: certHandle,
						configDir,
						options,
						deps: lastDeps,
					}).catch(() => {});
				}
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
 * `hostname` (the `{hook}--{slug}.hook.rine.network` form) goes into the BIND and
 * (via its label) the cert CN/SAN; its `control_ws_url` is the broker control-WS
 * endpoint the relay dials. NEITHER is reconstructed client-side: a fabricated
 * `<uuid>.hook.rine.network` matches no funnel_hook row (BIND would NAK, the cert
 * would never match GitHub's TLS), and the API base resolves to the primary IP /
 * Caddy, which has no funnel route. On a missing row or a transient lookup
 * failure we THROW so the loop backs off and retries.
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
 * The DNS LABEL of a hook hostname — everything before `.hook.rine.network`. The
 * cert is issued for this label via hookFqdn(label), so the leaf's CN/SAN equals
 * the public hostname GitHub connects to (no name mismatch on the TLS handshake).
 */
function hookLabel(hostname: string): string {
	const suffix = ".hook.rine.network";
	return hostname.endsWith(suffix)
		? hostname.slice(0, -suffix.length)
		: hostname;
}
