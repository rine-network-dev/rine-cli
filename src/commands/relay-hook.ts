/**
 * The relay's view of its hook: the options that name it, the server row it
 * resolves to, the secret that verifies it and the DNS it must be delivered on.
 */

import { resolve4 } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { type HookRead, type HttpClient, loadHookSecret } from "@rine-network/core";
import { emitLifecycle } from "./relay-lifecycle.js";

export interface RelayOpts {
	agent?: string;
	hook: string;
	port: string;
	secretFile?: string;
	secretEnv?: string;
	staging?: boolean;
	verbose?: boolean;
}

/**
 * Resolve the HMAC secret: --secret-env > --secret-file > the persisted file.
 * Returns "" (after a stderr warning naming the three sources tried) when none is
 * found. An empty secret is NOT safe to run with: an attacker who controls the
 * body can compute `HMAC("", body)` and forge a "verified" self-send, so the
 * caller (runRelayLoop) HARD-REFUSES to start on an empty result — the relay never
 * enters the reconnect loop or opens the listener without a secret.
 */
export function resolveSecret(
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
export async function resolveHook(
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
export class UnsupportedTierError extends Error {
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
export async function assertAgentARecord(
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

/**
 * Parse --port into a valid TCP port. `0` is accepted as "OS-assign an ephemeral
 * port", never coerced to the default; a non-integer or out-of-range value
 * throws a clear error rather than silently falling back. The default flag
 * value "8443" parses straight through.
 */
export function parsePort(raw: string): number {
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid --port '${raw}': expected an integer 0-65535.`);
	}
	return port;
}
