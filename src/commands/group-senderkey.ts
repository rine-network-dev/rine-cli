import { loadSenderKeyStates } from "@rine-network/core";

/** Who can, and cannot, read what this agent sends to an open group. */
export interface SenderKeyCoverage {
	senderKeyId: string;
	/** Members this agent's current sender key reached. */
	reached: string[];
	/** Members it did not reach. They cannot read this agent's traffic. */
	unreached: string[];
}

const lower = (id: string): string => id.toLowerCase();

/**
 * Which members hold this agent's current sender key, and which do not.
 *
 * `distributeSenderKey` reports a per-recipient `DistributeResult` and **every
 * caller discards the failures**: a distribution that reached four of five
 * members looks exactly like one that reached all five, and the fifth member
 * silently cannot read anything this agent sends until some later send happens
 * to reach them. The information is on disk — `distributedTo` records only the
 * recipients that were actually reached — and nothing has ever read it back.
 * This is that read.
 *
 * Returns null when this agent holds no sender key for the group, which is the
 * normal state of an MLS group and of one nobody has sent to yet. That is not
 * the same answer as "everybody has it", so it is a different value.
 *
 * ⚠️ The current state is the **last** one this agent owns, which is the same
 * rule `getOrCreateSenderKey` applies when it decides which key to send under
 * (`rine-core/src/sender-key-ops.ts`): a rotation appends and drops the key it
 * superseded, so reading the first match would report a retired key's audience.
 * The rule is stated in both places because rine-core exports no reader for it;
 * one exported accessor would be the better home.
 */
export function senderKeyCoverage(
	configDir: string,
	agentId: string,
	groupId: string,
	memberIds: string[],
): SenderKeyCoverage | null {
	const own = loadSenderKeyStates(configDir, agentId, groupId).filter(
		(state) => lower(state.senderAgentId) === lower(agentId),
	);
	const current = own[own.length - 1];
	if (!current) return null;

	const held = new Set((current.distributedTo ?? []).map(lower));
	const recipients = memberIds.filter((id) => lower(id) !== lower(agentId));
	return {
		senderKeyId: current.senderKeyId,
		reached: recipients.filter((id) => held.has(lower(id))),
		unreached: recipients.filter((id) => !held.has(lower(id))),
	};
}

/**
 * What an operator is told when a distribution reached only part of the group.
 *
 * Empty when everybody has the key — there is nothing to report, and a line
 * that appears every time stops being read.
 */
export function coverageWarning(coverage: SenderKeyCoverage): string {
	if (coverage.unreached.length === 0) return "";
	const total = coverage.reached.length + coverage.unreached.length;
	return (
		`Your sender key has reached ${coverage.reached.length} of ${total} other` +
		` members. These ${coverage.unreached.length} cannot read what you send` +
		` until a later send reaches them: ${coverage.unreached.join(", ")}`
	);
}
