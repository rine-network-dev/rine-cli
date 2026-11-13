import { RineApiError } from "@rine-network/core";

const MINT_REFUSALS = new Set([
	"invalid_client",
	"unauthorized_client",
	"invalid_grant",
]);

/** A 401, a 403, or a refused token mint: the credential, not the network, is the problem. */
export function isAuthRefusal(err: unknown): boolean {
	if (!(err instanceof RineApiError)) return false;
	if (err.status === 401 || err.status === 403) return true;
	return (
		err.status === 400 && err.code !== undefined && MINT_REFUSALS.has(err.code)
	);
}

/** A network error, a throttle or a server fault: worth waiting out. */
export function isTransient(err: unknown): boolean {
	return (
		!(err instanceof RineApiError) || err.status === 429 || err.status >= 500
	);
}
