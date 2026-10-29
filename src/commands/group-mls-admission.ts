import {
	ACTING_AGENT_HEADER,
	type HttpClient,
	type MlsAdmissionResult,
	addMlsGroupMembers,
} from "@rine-network/core";
import { mlsFailureText, warnMls } from "./group-mls-failure.js";

/** An admission that could not run: the text `warnMls` prints, as data. */
export interface MlsAdmissionFailure {
	error: string;
}

/**
 * `--json` output with the admission beside it: the seated result, or the failure's
 * text. Nothing is added when no admission ran, so a group with no ratchet tree and
 * a call that only nominated read as they always did.
 */
export function withAdmission<T extends object>(
	data: T,
	admission: MlsAdmissionResult | MlsAdmissionFailure | null,
): T | (T & { admission: MlsAdmissionResult | MlsAdmissionFailure }) {
	return admission ? { ...data, admission } : data;
}

/** Warn that the add failed (text mode only) and return the failure as data. */
export function failedAdmission(
	err: unknown,
	groupId: string,
	json?: boolean,
): MlsAdmissionFailure {
	warnMls("MLS add-member failed", err, groupId, json);
	return { error: mlsFailureText(err, groupId) };
}

/** Whether an admission seated anyone, as opposed to failing or having nothing to do. */
export function admissionRan(
	admission: MlsAdmissionResult | MlsAdmissionFailure | null,
): admission is MlsAdmissionResult {
	return admission !== null && !("error" in admission);
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
 * group has no tree, and the failure's text when the admission could not run, so
 * a caller that prints JSON (where the warning is silent) can still report it.
 */
export async function admitToMls(
	client: HttpClient,
	configDir: string,
	adminId: string,
	groupId: string,
	mlsGroupId: string | null | undefined,
	memberAgentIds: string[],
	json?: boolean,
): Promise<MlsAdmissionResult | MlsAdmissionFailure | null> {
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
		return failedAdmission(err, groupId, json);
	}
}
