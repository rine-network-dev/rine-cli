/** How a hook's request bytes reach the relay, decided once per connect by its tier. */

import {
	type Frame,
	type HookRead,
	type LocalPipe,
	type RelayResult,
	type WebhookRequest,
	agentLabel,
	makeEdgePipeFactory,
	startTlsListener,
} from "@rine-network/core";
import type { RelayCert } from "./relay-cert.js";
import { UnsupportedTierError, assertAgentARecord } from "./relay-hook.js";
import { emitLifecycle } from "./relay-lifecycle.js";

export interface TierSetup {
	/** The factory the tunnel calls for each OPEN frame. */
	readonly openLocalPipe: (frame: Frame) => LocalPipe;
	/**
	 * Start the local listener once the tunnel is up; shared-edge has none. The
	 * handle reaches `onListening` as soon as the port is bound, before the
	 * steps that follow, so a later failure leaves the caller able to close it.
	 */
	listen(
		port: number,
		onListening: (listener: { close(): void }) => void,
	): Promise<void>;
}

/**
 * Branch ONCE on the tier, BEFORE any label/FQDN derivation: the zero-trust
 * agentLabel deriver hard-codes `.hook.rine.network`, so a shared-edge `.edge`
 * host must never reach it. Zero-trust defers its TLS listener to AFTER the
 * tunnel connects (the lazy `ref` holder — orchestration order:
 * cert→tunnel→listener, safe because no OPEN arrives before the holder is
 * populated); shared-edge has no listener, so its `openLocalPipe` factory is
 * ready immediately.
 */
export async function prepareTier(
	hook: HookRead,
	onRequest: (req: WebhookRequest) => Promise<RelayResult>,
	cert: RelayCert,
	json: boolean | undefined,
): Promise<TierSetup> {
	const { hostname } = hook;
	if (hook.termination === "shared_edge") {
		// Shared-edge: the BROKER terminates the external TLS and forwards the
		// DECRYPTED request down the mux. The relay runs NO local TLS listener
		// and issues NO cert — it just parses the forwarded plaintext, runs the
		// SAME adapter, and synthesizes the 204/400/500 (edge-pipe). The trust
		// boundary at REST is unchanged (HMAC + `hpke-hybrid-v2` stay relay-side).
		cert.release();
		const openLocalPipe = makeEdgePipeFactory({ onRequest });
		emitLifecycle(json, { state: "shared_edge_ready", hostname });
		return { openLocalPipe, listen: async () => {} };
	}
	if (hook.termination !== "zero_trust") {
		// An unknown tier from a newer backend — fail LOUD + FATAL rather than
		// wire a path this build cannot serve.
		throw new UnsupportedTierError(hook.termination);
	}
	// Zero-trust: the cert handle is the per-agent label — the second-to-last
	// DNS label before `.hook.rine.network`. One shared `*.{agentLabel}.hook`
	// wildcard covers every hook of the agent, so every hook-relay of that agent
	// keys the SAME cert cache. (1) Cert provision/renew.
	const ztCert = await cert.ensure(agentLabel(hostname));
	emitLifecycle(json, { state: "cert_ready", hostname });
	const ref: { live?: { openLocalPipe(frame: Frame): LocalPipe } } = {};
	return {
		openLocalPipe: (frame: Frame) => {
			if (!ref.live) throw new Error("listener not ready");
			return ref.live.openLocalPipe(frame);
		},
		async listen(port, onListening) {
			// (3) Local TLS-terminating listener — terminates the GitHub TLS that
			// was shoveled raw down the mux; (4) per-request verify→encrypt→post.
			const live = await startTlsListener({
				port,
				certPem: ztCert.certPem,
				keyPem: ztCert.keyPem,
				onRequest,
			});
			ref.live = live;
			onListening(live);
			// The per-agent `*.{agentLabel}.hook` A record is a DELIVERY
			// prerequisite, NOT a cert-validation one (DNS-01 validates the
			// independent challenge TXT), so a healthy cert can still be
			// undeliverable if the backend's best-effort A write failed. Surface it
			// LOUDLY (non-fatal: the backend self-heals the A on the next ZT-hook
			// create). The shared-edge `.edge` host resolves via the server-managed
			// static `*.edge` A, so there is no per-agent A to assert there.
			await assertAgentARecord(hostname, json);
			emitLifecycle(json, { state: "listener_ready", port: live.port });
			// Arm the standing renewal re-check so a long-connected relay actually
			// renews. Shared-edge holds no cert, so it skips this.
			cert.startRenewalTimer();
		},
	};
}
