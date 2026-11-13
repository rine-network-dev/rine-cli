/** The text `rine org rules` prints in one place. */
import {
	EXPOSURE_COPY,
	type ExistingCounts,
	type ExposureSet,
	type GroupsPreview,
	PRESETS,
	PolicyRule,
	type PolicyView,
	RuleMode,
	type StopExistingResult,
	Surface,
} from "@rine-network/core";

export const NOT_COVERING_OUTBOUND =
	"Does not cover groups: members from any organisation can still join and post. In sender-key groups, members from organisations this rule refuses cannot read your posts once your key changes, and get no notice of invitations. MLS groups are not affected.";
export const NOT_COVERING_INBOUND =
	"Does not cover groups: members from any organisation can still join and post. In sender-key groups, you cannot read posts from members of organisations this rule refuses once their key changes. MLS groups are not affected.";
export const EXPOSURE_INVALID = EXPOSURE_COPY.invalid;

const OPEN_GROUP_ADVICE =
	"In a foreign open group, allowing does not restore posting: leave, or ask the owner to close it.";
const GROUPS_PREVIEW_ADVICE =
	"Two organisations that both turn this rule on cannot share an open group. Use a closed group; an existing sender-key group does not convert.";

const groupsHold = (g: number) =>
	g === 1 ? "1 group holds" : `${g} groups hold`;

/** The preset a ceiling equals, else "custom" with its switches. */
export function ceilingSummary(max: ExposureSet): string {
	for (const [name, set] of Object.entries(PRESETS))
		if (Object.values(Surface).every((s) => set[s] === max[s])) return name;
	const on = Object.values(Surface).filter((s) => max[s]);
	return `custom (${on.length === 0 ? "nothing" : on.map((s) => EXPOSURE_COPY.surfaceNames[s]).join(", ")})`;
}

/** The one-line summary of how many rules are on or reporting. */
export function summaryLine(policy: PolicyView): string {
	const modes = Object.values(PolicyRule).flatMap((r) => policy.rules[r]?.mode ?? []);
	const on = modes.filter((m) => m === RuleMode.Enforce).length;
	const reporting = modes.filter((m) => m === RuleMode.Report).length;
	const messageRuleOn = [PolicyRule.ExternalOutbound, PolicyRule.ExternalInbound].some(
		(r) => policy.rules[r]?.mode === RuleMode.Enforce,
	);
	const uncovered = messageRuleOn && !policy.groups_covered;
	return `${on} of ${modes.length} rules on, ${reporting} reporting.${uncovered ? " Groups are not covered." : ""}`;
}

/** What `external_groups` found standing, under the rule in `rules show`. */
function groupsNote(policy: PolicyView): string[] {
	const g = policy.existing.groups_unpostable ?? 0;
	if (g === 0)
		return ["No group your agents are in holds members outside your list."];
	const held = `${groupsHold(g)} members outside your list. Your agents cannot post there`;
	if (policy.rules.external_inbound.mode === RuleMode.Enforce)
		return [
			`${held}. Keys you already hold still open their posts; new keys arrive only from organisations your incoming message rule allows, and posts sealed with a key that never arrived stay unreadable. ${OPEN_GROUP_ADVICE}`,
		];
	return [`${held}, and they keep reading. ${OPEN_GROUP_ADVICE}`];
}

/** The line printed when `external_groups` is set to enforce over groups it leaves unpostable. */
export function groupsSetLine(policy: PolicyView): string | undefined {
	const g = policy.existing.groups_unpostable ?? 0;
	if (g === 0) return undefined;
	const are = g === 1 ? "1 group your agents are in holds" : `${g} groups your agents are in hold`;
	return `${are} members outside this rule. Your agents keep their seats and cannot post there.`;
}

/** The lines of `rules preview external_groups`. */
export function groupsPreviewLines(p: GroupsPreview): string[] {
	const [i, a] = [
		`${p.invitations} ${p.invitations === 1 ? "invitation" : "invitations"}`,
		`${p.applications} ${p.applications === 1 ? "application" : "applications"}`,
	];
	const open = p.foreign_open_groups === 1 ? "1 of them is an open group" : `${p.foreign_open_groups} of them are open groups`;
	const hidden = `${i} would be hidden and ${a} would lose ${p.applications === 1 ? "its" : "their"} message`;
	return [
		`${groupsHold(p.groups)} members outside your list; your agents could not post there. ${open} owned by other organisations, where allowing does not restore posting. ${hidden}.`,
		GROUPS_PREVIEW_ADVICE,
	];
}

/** The check `counterparties allow --groups` prints: the join, and whether the rule is on. */
export function groupsAllowLine(open: number | undefined, covered: boolean): string {
	const n = open === undefined ? "open groups" : `${open} open groups`;
	return `With groups allowed, this organisation can join your ${n}${covered ? "" : " once the group rule is on"}, and your agents will send it the current group key.`;
}

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/** The lines under one rule in `rules show`. */
export function ruleNotes(policy: PolicyView, rule: PolicyRule): string[] {
	const { rules, existing } = policy;
	if (rules[rule] === undefined || rules[rule].mode === RuleMode.Off) return [];
	switch (rule) {
		case PolicyRule.ExternalOutbound:
			return policy.groups_covered ? [] : [NOT_COVERING_OUTBOUND];
		case PolicyRule.ExternalInbound:
			return policy.groups_covered ? [] : [NOT_COVERING_INBOUND];
		case PolicyRule.ExternalGroups:
			return policy.groups_covered ? groupsNote(policy) : [];
		case PolicyRule.DirectoryListing: {
			const n = existing.agents_above_ceiling;
			const shown = `Agents may show at most: ${ceilingSummary(rules.directory_listing.max)}.`;
			return [
				n > 0
					? `${shown} ${plural(n, "agent shows", "agents show")} more than that, and keep doing so until you stop them.`
					: shown,
			];
		}
		case PolicyRule.WebhookHosts:
			return existing.webhooks_outside > 0
				? [
						`${plural(existing.webhooks_outside, "webhook", "webhooks")} outside the list. They deliver nothing while this rule is on.`,
					]
				: [];
		case PolicyRule.Funnel:
			return existing.funnel_hooks > 0
				? [
						`A hook opens the agent to anyone on the internet. ${plural(existing.funnel_hooks, "hook", "hooks")} still open.`,
					]
				: [];
		case PolicyRule.ActingAs:
			return [
				"Named agents act only with their own key. Your organisation key can still suspend, delete or rotate them; a branch key can suspend or delete them.",
			];
		default:
			return [];
	}
}

const STANDING: Partial<
	Record<PolicyRule, [keyof ExistingCounts, string, string]>
> = {
	webhook_hosts: ["webhooks_outside", "webhook", "webhooks"],
	funnel: ["funnel_hooks", "funnel hook", "funnel hooks"],
	directory_listing: ["agents_above_ceiling", "agent", "agents"],
};

/** What stands outside a rule that was just set, or `undefined` when nothing does. */
export function existingLine(
	policy: PolicyView,
	rule: PolicyRule,
): string | undefined {
	const standing = STANDING[rule];
	if (standing === undefined) return undefined;
	const n = policy.existing[standing[0]];
	if (n === 0) return undefined;
	const word = n === 1 ? standing[1] : standing[2];
	return `${n} existing ${word} ${n === 1 ? "is" : "are"} outside this rule. To stop them: rine org rules stop-existing ${rule}`;
}

/** The lines reporting what a stop-existing action stopped. */
export function stoppedLines(r: StopExistingResult): string[] {
	if (r.rule === PolicyRule.WebhookHosts) return [`Stopped ${r.stopped} webhooks.`];
	if (r.rule === PolicyRule.Funnel) {
		const lines = [`Removed ${r.stopped} funnel hooks.`];
		if (r.remaining > 0)
			lines.push(
				`${r.remaining} funnel hooks remain. Run the command again to remove them.`,
			);
		return lines;
	}
	return [`Lowered ${r.stopped} agents to the rule's limit.`];
}
