import type { EscrowReport } from "@rine-network/core";

/** The escrow report of a group operation that had no escrow work to do. */
export const NO_ESCROW: EscrowReport = {
	gaps: [],
	queued: 0,
	dropped: 0,
	backlogged: 0,
};
