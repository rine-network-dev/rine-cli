/**
 * The zero-trust wildcard a relay holds: issued on each (re)connect and
 * re-checked on a standing timer, so a relay that stays connected past the
 * renewal window still renews.
 */

import {
	type AcmeOptions,
	type HttpClient,
	type IssueCertDeps,
	buildIssueCertDeps,
	ensureCert,
	loadMeta,
	renewalDueWithJitter,
} from "@rine-network/core";
import { emitLifecycle } from "./relay-lifecycle.js";

// Cadence of the standing renewal re-check. A long-connected relay's
// reconnect-loop ensureCert never fires past the renewal window, so this timer
// re-evaluates renewalDueWithJitter periodically. 12h is well under the 30-day
// renewal window + the 20-day jitter spread, so the deterministic
// per-agent renewal instant is never missed by more than half a day.
const RENEWAL_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

export type IssuedCert = Awaited<ReturnType<typeof ensureCert>>;

export interface RelayCert {
	/** Issue or renew the per-agent wildcard keyed by `handle`, the agent label. */
	ensure(handle: string): Promise<IssuedCert>;
	/** A shared-edge hook holds no cert, so the renewal re-check has nothing to renew. */
	release(): void;
	/** Arm the standing renewal re-check; a second call is a no-op. */
	startRenewalTimer(): void;
	/** Disarm the standing renewal re-check. */
	stop(): void;
}

export function relayCert(deps: {
	configDir: string;
	agentId: string;
	client: HttpClient;
	options: AcmeOptions;
	json: boolean | undefined;
	isStopped: () => boolean;
}): RelayCert {
	const { configDir, agentId, client, options, json, isStopped } = deps;
	let lastDeps: IssueCertDeps | undefined;
	// The cert-cache handle for the active ZERO-TRUST hook — the per-agent label,
	// so every hook of an agent shares ONE wildcard cert cache. The renewal timer
	// re-checks the SAME entry ensureCert wrote under.
	let certHandle: string | undefined;
	// Single-flight guard over ensureCert: the reconnect loop and the standing
	// renewal timer both issue/renew the SAME per-agent wildcard, so they
	// MUST NOT run concurrently (a double ACME order would burn the LE
	// duplicate-cert budget). Whoever holds it wins; the other defers.
	let certBusy = false;
	let renewalTimer: ReturnType<typeof setInterval> | undefined;

	const issue = async (handle: string, issueDeps: IssueCertDeps) => {
		certBusy = true;
		try {
			return await ensureCert({
				handle,
				agentId,
				delegationId: handle,
				configDir,
				options,
				deps: issueDeps,
			});
		} finally {
			certBusy = false;
		}
	};

	// Renews when due, guarded by certBusy so it never races the reconnect
	// loop's ensureCert.
	const maybeRenewCert = async (): Promise<void> => {
		if (isStopped() || certBusy || !certHandle || !lastDeps) return;
		const meta = loadMeta(configDir, certHandle, options);
		if (!meta || !renewalDueWithJitter(meta, certHandle, Date.now())) return;
		try {
			await issue(certHandle, lastDeps);
			emitLifecycle(json, { state: "cert_renewed", handle: certHandle });
		} catch (err) {
			emitLifecycle(json, {
				state: "cert_renew_error",
				handle: certHandle,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	};

	return {
		async ensure(handle) {
			certHandle = handle;
			// The private key stays local. The propagation poll targets the FQDN the
			// backend returns from dns-challenge `set`, so the relay never needs the
			// server's delegation_id up front. `certBusy` is a best-effort in-process
			// guard that keeps the standing renewal timer from firing an overlapping
			// ensureCert; the HARD duplicate-cert guarantee is ensureCert's own
			// cross-process per-agent issuance lock (a second concurrent caller
			// reuses the sibling's cert instead of firing a second ACME order).
			lastDeps = await buildIssueCertDeps({
				configDir,
				options,
				http: client,
				agentId,
			});
			return issue(handle, lastDeps);
		},
		release() {
			certHandle = undefined;
		},
		startRenewalTimer() {
			if (renewalTimer) return;
			renewalTimer = setInterval(() => {
				void maybeRenewCert();
			}, RENEWAL_CHECK_INTERVAL_MS);
			// Don't keep the process alive for the timer alone — the reconnect loop
			// owns the lifecycle; the timer is a best-effort background re-check.
			renewalTimer.unref?.();
		},
		stop() {
			if (renewalTimer) clearInterval(renewalTimer);
		},
	};
}
