/** The findings the view has seen: kept newest first, one per group and gap, and bounded like the rows. */
import { type ReadFinding, findingKey } from "@rine-network/core";
import type { Action } from "./keymap-table.js";
import { MAX_LOADED_ROWS } from "./state-data.js";
import type { Model } from "./state-model.js";
import { scrollTarget } from "./state-motion.js";

/** `finding` in front of `held`, or `held` itself when the group already has that gap. */
export function addFinding(
	held: readonly ReadFinding[],
	finding: ReadFinding,
): readonly ReadFinding[] {
	const key = findingKey(finding);
	// The group test spares keying every held finding: a key starts with its group.
	const seen = held.some(
		(one) => one.groupId === finding.groupId && findingKey(one) === key,
	);
	return seen ? held : [finding, ...held].slice(0, MAX_LOADED_ROWS);
}

/** The first finding the overlay shows, after a motion key. */
export function scrollFindings(
	model: Model,
	action: Extract<Action, { kind: "move" | "jump" }>,
): Model {
	const to = scrollTarget(action, model.findingsTop, model.viewport.listHeight);
	const last = Math.max(0, model.findings.length - 1);
	return { ...model, findingsTop: Math.max(0, Math.min(last, to)) };
}
