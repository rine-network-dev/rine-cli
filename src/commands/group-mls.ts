import {
	type HttpClient,
	ACTING_AGENT_HEADER,
	MLS_ERR_GROUP_INACTIVE,
	type MlsAdmissionResult,
	addMlsGroupMembers,
	externalJoinMlsGroup,
	isMlsWelcomeRefusedError,
	formatError,
	isEpochConflict,
	loadMlsState,
	mlsErrorCode,
	processMlsWelcomes,
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
 * 🔴 One step does not use this: a Welcome the group substitution guard REFUSED
 * for the group being joined. See {@link installWelcomes}.
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

/**
 * Best-effort: fetch & install pending MLS Welcomes for a freshly-added member.
 *
 * 🔴 With one exception. A Welcome the group substitution guard REFUSED for
 * **this** group is raised, so `rine group join` reports it and exits non-zero
 * instead of printing a warning under a success line. A refusal is a
 * security verdict about who minted the Welcome, not a setup step that will
 * come good on the next read, and `rine.groups.join()` on the Python SDK
 * already raises it — the same failure must not be loud on one stack and a log
 * line on the other. The rine membership stands either way; what the operator
 * has to act on is the refusal's own text.
 *
 * A refusal naming a DIFFERENT group still warns: the batch installs every
 * Welcome it can before raising, and one group's verdict is not this join's.
 *
 * 🔴 `forGroup` is what makes that split the CLIENT's to make. Without it the
 * pass raises "the first refusal whose bytes arrived", ordered by the server's
 * own response array — so a server suppressed this group's refusal by minting
 * one throwaway decoy for another group, {@link welcomeRefusedForGroup}
 * answered false, and the join carried on into
 * {@link selfJoinViaExternalCommit} for the very group whose Welcome this
 * client had just refused (MEASURED: the verb's outcome flips from warn to
 * raise on this argument alone).
 */
export async function installWelcomes(
	client: HttpClient,
	configDir: string,
	agentId: string,
	groupId: string,
	json?: boolean,
): Promise<void> {
	try {
		await processMlsWelcomes(configDir, agentId, client, { forGroup: groupId });
	} catch (err) {
		if (welcomeRefusedForGroup(err, groupId)) throw err;
		warnMls("MLS welcome install failed", err, groupId, json);
	}
}

/**
 * Whether a failure is the Welcome guard refusing a Welcome for this group.
 *
 * Classified by rine-core's exported code check, never by matching the message
 * — that export exists for this. The `groupId` a refusal carries is the rine
 * group UUID the delivery was filed under, compared case-insensitively because
 * the two ids arrive from different reads, as the Python twin compares them.
 */
function welcomeRefusedForGroup(err: unknown, groupId: string): boolean {
	if (!isMlsWelcomeRefusedError(err)) return false;
	const named = (err as { groupId?: unknown }).groupId;
	return (
		typeof named === "string" && named.toLowerCase() === groupId.toLowerCase()
	);
}

/**
 * Best-effort open-enrollment fallback: when the joiner became a rine member
 * with no Welcome (the `open` enrollment case — no admin in the loop) and the
 * group is MLS-active, self-join via an RFC 9420 external commit. No-op if a
 * Welcome already installed local state, or for sender-key groups.
 */
export async function selfJoinViaExternalCommit(
	client: HttpClient,
	configDir: string,
	groupId: string,
	agentId: string,
	mlsGroupId: string | null | undefined,
	json?: boolean,
): Promise<void> {
	if (!mlsGroupId) return;
	// A Welcome may have just installed state — only self-join if none exists.
	if (loadMlsState(configDir, agentId, groupId)) return;
	try {
		await externalJoinMlsGroup(configDir, agentId, groupId, client, {
			[ACTING_AGENT_HEADER]: agentId,
		});
	} catch (err) {
		warnMls("MLS self-join failed", err, groupId, json);
	}
}

/**
 * Give every named agent a leaf in the group's ratchet tree, in batches.
 *
 * One call whether one agent was named or five hundred: the singular add is the
 * plural one over a list of one, and both report per member. A
 * sender-key group has no tree, so it is a no-op rather than a failure.
 *
 * Best-effort by contract, like every MLS step on these paths: the invitations
 * are already minted server-side when this runs, and a Welcome that could not be
 * delivered is recoverable by `group resume-admission`. Returns null when the
 * group has no tree or the admission could not run at all.
 */
export async function admitToMls(
	client: HttpClient,
	configDir: string,
	adminId: string,
	groupId: string,
	mlsGroupId: string | null | undefined,
	memberAgentIds: string[],
	json?: boolean,
): Promise<MlsAdmissionResult | null> {
	if (!mlsGroupId || memberAgentIds.length === 0) return null;
	try {
		return await addMlsGroupMembers(
			configDir,
			adminId,
			groupId,
			memberAgentIds,
			client,
			{ [ACTING_AGENT_HEADER]: adminId },
		);
	} catch (err) {
		warnMls("MLS add-member failed", err, groupId, json);
		return null;
	}
}
