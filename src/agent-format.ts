import type { AgentRead } from "@rine-network/core";

export type AgentTableRow = {
	ID: string;
	Name: string;
	Handle: string;
	"Human Oversight": string;
	Created: string;
	Card?: string;
	Revoked?: string;
	"Verification Words"?: string;
};

export function toAgentRow(
	a: AgentRead,
	opts: {
		includeCard?: boolean;
		includeRevoked?: boolean;
		includeVerificationWords?: boolean;
	} = {},
): AgentTableRow {
	const row: AgentTableRow = {
		ID: a.id,
		Name: a.name,
		Handle: a.handle,
		"Human Oversight": String(a.human_oversight),
		Created: a.created_at,
	};
	if (opts.includeVerificationWords && a.verification_words) {
		row["Verification Words"] = a.verification_words;
	}
	if (opts.includeCard) row.Card = a.unlisted ? "unlisted" : "public";
	if (opts.includeRevoked)
		row.Revoked = a.revoked_at ? String(a.revoked_at) : "\u2014";
	return row;
}
