/** The `rine relay` reconnect loop: cert, tunnel, listener, per-request handler. */

import {
	type AcmeOptions,
	type HttpClient,
	IdempotencyStore,
	type WebhookRequest,
	connectTunnel,
	handleWebhookRequest,
	jitteredRefreshMargin,
} from "@rine-network/core";
import type { CreatedClient } from "../action.js";
import { printError } from "../output.js";
import type { GlobalOpts } from "../types.js";
import { relayCert } from "./relay-cert.js";
import {
	type RelayOpts,
	UnsupportedTierError,
	parsePort,
	resolveHook,
	resolveSecret,
} from "./relay-hook.js";
import { emitLifecycle } from "./relay-lifecycle.js";
import {
	isRevoked,
	reconnectAfterError,
	waitForClose,
} from "./relay-reconnect.js";
import { prepareTier } from "./relay-tier.js";

export interface RelayCtx {
	opts: RelayOpts;
	gOpts: GlobalOpts;
	configDir: string;
	agentId: string;
	client: HttpClient;
	token: CreatedClient["token"];
}

export async function runRelayLoop(ctx: RelayCtx): Promise<void> {
	const { opts, gOpts, configDir, agentId, client, token: mintToken } = ctx;
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
	const cert = relayCert({
		configDir,
		agentId,
		client,
		options,
		json,
		isStopped: () => stopped,
	});
	// One replay-de-dup store for the whole relay process — persists across
	// reconnects so a tunnel flap can't re-admit a captured signed delivery.
	// Bounded + TTL-evicting; HMAC verify stays the authenticator, this only
	// drops a post-verify duplicate so it can't mint a second rine.v1.webhook.
	const idempotency = new IdempotencyStore();
	// One SIGINT listener for the whole relay, not one per connection: it stops
	// the loop and closes whichever tunnel is open.
	let stopConnection: (() => void) | undefined;
	process.on("SIGINT", () => {
		stopped = true;
		process.exitCode = 0;
		cert.stop();
		stopConnection?.();
	});

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
			// HMAC-verify the RAW body → fetch keys → encrypt `hpke-hybrid-v2` → self-send
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
				);

			const tier = await prepareTier(hook, onRequest, cert, json);

			// Mint the BIND Bearer HERE — AFTER any cold cert issuance, immediately
			// before the upgrade. A cold/renewal issuance can block for the grace
			// delay + poll (~3 min); a token fetched before it could expire (cache
			// floor is 60s) and the broker would NAK the BIND — or worse, revoke.
			const token = await mintToken({ refreshMargin });

			// (2) Control WS + mux tunnel. Bearer at the upgrade; the
			// backend validates the full org→agent→hostname chain.
			const tunnel = await connectTunnel({
				controlWsUrl,
				token,
				agentId,
				hostname,
				openLocalPipe: tier.openLocalPipe,
			});
			emitLifecycle(json, { state: "tunnel_connected" });

			await tier.listen(port, (live) => {
				listener = live;
			});
			backoff = 1; // a clean re-establish resets the backoff

			const close = await waitForClose(tunnel, () => stopped, (stop) => {
				stopConnection = stop;
			});
			stopConnection = undefined;
			tunnel.close();
			listener?.close();
			if (stopped) break;

			// WS dropped with no stop signal → reconnect. An orderly
			// broker close (1000/1001/bare drop) reconnects IMMEDIATELY with backoff
			// reset to 1 (as stream.ts does); an abnormal close gets the jittered
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
				backoff = await reconnectAfterError(json, attempt, backoff);
			}
		} catch (err) {
			listener?.close();
			if (stopped) break;
			if (err instanceof UnsupportedTierError) {
				// An unknown tier from a newer backend: fail LOUD and FATAL — never
				// backoff-retry a tier this build cannot serve.
				cert.stop();
				printError(err.message);
				process.exitCode = 2;
				return;
			}
			if (isRevoked(err)) {
				// Do NOT revoke/wipe the per-agent wildcard on a single
				// hook's BIND-revoked — it is SHARED across every other live hook of the
				// agent, so revoking here would kill all of them. The kill switch is
				// server-side DNS+route teardown; the relay just exits.
				cert.stop();
				emitLifecycle(json, { state: "tunnel_revoked" });
				process.exitCode = 1;
				return;
			}
			backoff = await reconnectAfterError(json, attempt, backoff, () => {
				if (opts.verbose)
					process.stderr.write(
						`Reconnecting (attempt ${attempt + 1}, error): ${
							err instanceof Error ? (err.stack ?? err.message) : String(err)
						}\n`,
					);
			});
		}
	}
	cert.stop();
	emitLifecycle(json, { state: "stopped", reason: "signal" });
}
