/** The parties of a list row, fitted into the parties column by the shared handle-fitting rules. */
import { displayWidth, fitFromTo, fitGroupSender } from "@rine-network/core";
import { type Run, fitRuns } from "./runs.js";

export enum PartiesShape {
	/** `#group · sender`: the group takes at most 60 % of the room unless the sender needs less. */
	GroupSender,
	/** `sender → recipient`: the recipient gets what it needs, or half. */
	FromTo,
}

export interface ListParties {
	readonly shape: PartiesShape;
	readonly lead: Run;
	readonly joint: Run;
	readonly tail: Run;
}

/**
 * The parties as runs of exactly `width` columns: each label fitted (a `local@domain` keeps its name before its domain
 * and always its `@`; a bare name clips from the right), the joint kept whole, the rest padded.
 */
export function partiesRuns(parties: ListParties, width: number, ellipsis: string): Run[] {
	const { shape, lead, joint, tail } = parties;
	const fit = shape === PartiesShape.GroupSender ? fitGroupSender : fitFromTo;
	const [leadText, tailText] = fit(lead.text, tail.text, width - displayWidth(joint.text), ellipsis);
	return fitRuns([{ ...lead, text: leadText }, joint, { ...tail, text: tailText }], width, ellipsis);
}

/** The reader header's parties: the two names, each with the short agent id that follows it (none for a group). */
export interface ReaderParties {
	readonly lead: Run;
	readonly leadId: Run;
	readonly joint: Run;
	readonly tail: Run;
	readonly tailId: Run | null;
}

/** `from id → to id` in exactly `width` columns: the names are fitted to what the joint and the ids leave, the ids kept whole. */
export function readerPartiesRuns(parties: ReaderParties, width: number, ellipsis: string): Run[] {
	const { lead, leadId, joint, tail, tailId } = parties;
	const fixed = displayWidth(joint.text) + displayWidth(leadId.text) + (tailId === null ? 0 : displayWidth(tailId.text));
	const [leadText, tailText] = fitFromTo(lead.text, tail.text, width - fixed, ellipsis);
	const runs = [{ ...lead, text: leadText }, leadId, joint, { ...tail, text: tailText }, ...(tailId === null ? [] : [tailId])];
	return fitRuns(runs, width, ellipsis);
}
