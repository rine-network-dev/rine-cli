import {
	MLS_ERR_GROUP_INACTIVE,
	formatError,
	isEpochConflict,
	mlsErrorCode,
} from "@rine-network/core";
import { printText } from "../output.js";
import { evictedMessage } from "./group-eviction.js";

/**
 * Why an MLS commit the server refused for its epoch check did not land, and
 * what puts it right.
 *
 * The server states this as `MLS epoch conflict: group at epoch 5, commit
 * targets 5`, and both numbers are correct: the first is the group's stored
 * epoch, the second is the epoch the client's commit would have produced. An
 * equal pair is the honest signature of a commit built one epoch behind — but
 * it reads as a contradiction, and it arrives behind `RineApiError`'s
 * `409: ` with no remedy attached. So the fact is stated instead of the
 * arithmetic. 🔴 Do not "fix" the server's numbers to make them differ.
 *
 * `groupRef` is whatever the caller addressed the group by, so the command it
 * names back is one the operator can paste.
 */
function epochConflictMessage(groupRef: string): string {
	return (
		"Another member's commit landed first, so this one was built one epoch " +
		"behind and the server's epoch check refused it. Nothing was committed " +
		"and the group is exactly where it was. Run " +
		`\`rine group sync ${groupRef}\` to catch this agent's state up, then ` +
		"run the command again."
	);
}

/**
 * A failure's message, in rine's words wherever rine has any.
 *
 * Two things reach an operator through here that should not, and both are
 * recognised by a machine-readable CODE rather than by matching words: the MLS
 * core's own vocabulary for an invariant rine states as a membership fact, and
 * `RineApiError`'s `${status}: ${detail}` — a bare `409: ` in front of a
 * sentence about epochs is the one place these commands drop to a status code.
 * `formatError` is what every other CLI failure path already renders through.
 */
export function mlsFailureText(err: unknown, groupId: string): string {
	if (mlsErrorCode(err) === MLS_ERR_GROUP_INACTIVE)
		return evictedMessage(groupId);
	if (isEpochConflict(err)) return epochConflictMessage(groupId);
	return formatError(err);
}

/**
 * Report a best-effort MLS step that failed without failing the command.
 *
 * Every MLS step in the group commands is a second operation *about* the group,
 * running after the one the operator asked for has already succeeded on the
 * server. Failing the command would misreport what happened; going quiet would
 * hide it. So it warns, in rine's vocabulary.
 *
 * 🔴 One step does not use this: a refusal for the group being joined. See
 * `establishJoinedMls` (group-mls.ts).
 */
export function warnMls(
	what: string,
	err: unknown,
	groupId: string,
	json?: boolean,
): void {
	if (json) return;
	printText(`Warning: ${what}: ${mlsFailureText(err, groupId)}`);
}
