/** How a row names its parties: the scrubbed handle (or id) in the short form against the org's own slug. */
import { type ReadMessage, displayHandle } from "@rine-network/core";
import { clean } from "./clean.js";

type Row = ReadMessage["row"];
type Party = Row["sender"];

export interface RowLabels {
	readonly from: string;
	/** Null for a group post. */
	readonly to: string | null;
	/** Null for a 1:1 message. */
	readonly group: string | null;
}

const rawParty = (party: Party): string => clean(party.handle ?? party.agentId);
const rawGroup = (row: Row): string => clean(row.groupHandle ?? row.groupId ?? "");

export const partyLabel = (party: Party, ownSlug: string | null): string =>
	displayHandle(rawParty(party), ownSlug);

/** The handles as the server sent them, scrubbed and not shortened: what a search also matches. */
export const rawHandles = (row: Row): string =>
	[
		rawParty(row.sender),
		row.recipient === null ? "" : rawParty(row.recipient),
		row.groupId === null ? "" : rawGroup(row),
	].join(" ");

export function rowLabels(row: Row, ownSlug: string | null): RowLabels {
	return {
		from: partyLabel(row.sender, ownSlug),
		to: row.recipient === null ? null : partyLabel(row.recipient, ownSlug),
		group:
			row.groupId === null
				? null
				: displayHandle(rawGroup(row), ownSlug),
	};
}
