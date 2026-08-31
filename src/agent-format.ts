import type {
	AgentRead,
	VerificationWordsComparison,
} from "@rine-network/core";

export type AgentTableRow = {
	ID: string;
	Name: string;
	Handle: string;
	"Human Oversight": string;
	Created: string;
	Card?: string;
	Revoked?: string;
	"Verification Words"?: string;
	"Verification Words (server)"?: string;
};

/**
 * One agent as a table row.
 *
 * `verification` is the comparison between the words this client derives from
 * the key it holds and the words the server asserts — never the server's string
 * on its own. When the two disagree the row carries **both**, in two columns,
 * because a mismatch is a state to read rather than an error to swallow. When
 * this client holds no key for the agent, only the server's column appears, so
 * the header says whose statement it is.
 */
export function toAgentRow(
	a: AgentRead,
	opts: {
		includeCard?: boolean;
		includeRevoked?: boolean;
		verification?: VerificationWordsComparison;
	} = {},
): AgentTableRow {
	const row: AgentTableRow = {
		ID: a.id,
		Name: a.name,
		// An agent with no handle (its org has no slug) is named by the other
		// value the wire accepts, not by an empty cell.
		Handle: a.handle ?? a.id,
		"Human Oversight": String(a.human_oversight),
		Created: a.created_at,
	};
	const v = opts.verification;
	if (v) {
		if (v.computed !== null) row["Verification Words"] = v.computed;
		if (v.asserted !== null && v.status !== "match") {
			row["Verification Words (server)"] = v.asserted;
		}
	}
	if (opts.includeCard) row.Card = a.unlisted ? "unlisted" : "public";
	if (opts.includeRevoked)
		row.Revoked = a.revoked_at ? String(a.revoked_at) : "\u2014";
	return row;
}
