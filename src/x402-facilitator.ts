// Shared x402 payee-settle helper (REQ-M04). Resolves a facilitator spec
// (preset name or explicit URL) into a `FacilitatorConfig`, and runs the pure
// verify → settle → receipt-body ladder. All verify/settle HTTP is rine-core's
// `verifyPayment`/`settlePayment` (plain external HTTP, never a rine endpoint) —
// this module owns no crypto or policy. Kept separate from the `fulfill` command
// so the command layer only does argument parsing + result rendering.

import {
	FACILITATOR_PRESET,
	type FacilitatorConfig,
	type PaymentPayload,
	type SettlementResponse,
	settlePayment,
	verifyPayment,
} from "@rine-network/core";

/** Terminal outcome of the verify→settle ladder (a receipt is sent in all three). */
export type FulfillSettleStatus =
	| "settled"
	| "settlement-failed"
	| "verification-failed";

export interface FulfillReceipt {
	status: FulfillSettleStatus;
	receiptBody: SettlementResponse;
}

/**
 * Resolve a facilitator spec into a config. `spec` is either a preset key
 * (`cdp` / `payai` / `x402-rs`) or an explicit `http(s)://` base URL. Optional
 * auth headers (`"Key: Value"` strings) and verify/settle path overrides are
 * merged in. Throws on an unrecognised spec so the caller fails loudly.
 */
export function resolveFacilitator(
	spec: string,
	opts: {
		headers?: string[];
		verifyPath?: string;
		settlePath?: string;
	} = {},
): FacilitatorConfig {
	const preset = (FACILITATOR_PRESET as Record<string, FacilitatorConfig>)[
		spec
	];
	const base =
		preset ?? (/^https?:\/\//.test(spec) ? { url: spec } : undefined);
	if (!base) {
		throw new Error(
			`Unknown facilitator '${spec}'. Use a preset (${Object.keys(
				FACILITATOR_PRESET,
			).join(" | ")}) or an http(s):// base URL.`,
		);
	}
	const cfg: FacilitatorConfig = { url: base.url };
	const headers = parseHeaders(opts.headers);
	if (headers) cfg.headers = headers;
	if (opts.verifyPath) cfg.verifyPath = opts.verifyPath;
	if (opts.settlePath) cfg.settlePath = opts.settlePath;
	return cfg;
}

function parseHeaders(raw?: string[]): Record<string, string> | undefined {
	if (!raw || raw.length === 0) return undefined;
	const headers: Record<string, string> = {};
	for (const entry of raw) {
		const idx = entry.indexOf(":");
		if (idx === -1)
			throw new Error(
				`Malformed facilitator header '${entry}' (expected 'Key: Value').`,
			);
		headers[entry.slice(0, idx).trim()] = entry.slice(idx + 1).trim();
	}
	return headers;
}

/**
 * The settle-first ladder: verify the signed payment, and — only when valid —
 * settle it. On an invalid verification, settlement is skipped and a
 * `success:false` receipt body is synthesised so the payer still reaches a
 * terminal `payment-failed`. A facilitator HTTP failure throws
 * `X402FacilitatorError` (the caller surfaces it as a typed outcome).
 */
export async function settleToReceipt(
	pp: PaymentPayload,
	facilitator: FacilitatorConfig,
	signal?: AbortSignal,
): Promise<FulfillReceipt> {
	const verification = await verifyPayment(pp, { facilitator, signal });
	if (verification.isValid) {
		const settlement = await settlePayment(pp, { facilitator, signal });
		return {
			status: settlement.success ? "settled" : "settlement-failed",
			receiptBody: settlement,
		};
	}
	return {
		status: "verification-failed",
		receiptBody: {
			success: false,
			transaction: "",
			network: pp.accepted.network,
			payer: pp.payload.authorization.from,
			errorReason: verification.invalidReason ?? "verification_failed",
		},
	};
}
