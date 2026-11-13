import type {
	ExistingCounts,
	RuleMode,
	RuleSet,
	AgentHoldView,
	AgentStateView,
	BranchHoldView,
	DelegateView,
	OrgFreezeView,
	PolicyView,
	SuspensionView,
} from "@rine-network/core";

/**
 * What the governance routes answer, member for member: each constant is a response model of
 * `src/rine/api/schemas_governance.py` as the server serialises it (the same dump as
 * `rine-core/test/fixtures/governance-shapes.json`). The command tests reply with these and
 * never with a hand-trimmed body, so a client that reads a shape the server does not send fails.
 */
const T = "2026-11-06T09:00:00Z";

export const agentHold = (agentId: string, changed = true): AgentHoldView => ({
	agent_id: agentId,
	suspended: true,
	suspended_by_org_at: T,
	suspended_by_branch_at: null,
	resumed_at: null,
	changed,
});

export const suspension: SuspensionView = {
	hold: "agent_suspended",
	suspended_by_org_at: T,
	suspended_by_branch_at: null,
	branch_suspended_at: null,
	org_frozen_at: null,
	operator_frozen: false,
	queue_depth: 3,
	oldest_queued_at: T,
	webhook_jobs_held: 0,
	rotated_since_suspension: false,
	poll_token_set: true,
	webhooks: 1,
};

export const branchHold = (name: string): BranchHoldView => ({
	name,
	suspended_at: T,
	resumed_at: null,
	changed: true,
});

export const orgFreeze: OrgFreezeView = {
	org_frozen_at: T,
	operator_frozen: false,
	unfrozen_at: null,
	changed: true,
};

export const policy = (
	version: number,
	mode: RuleMode,
	rules: Partial<RuleSet> = {},
	existing: Partial<ExistingCounts> = {},
): PolicyView => ({
	version,
	updated_at: T,
	rules: {
		new_agents: { mode },
		external_outbound: { mode: "off", default: "deny" },
		external_inbound: { mode: "off", default: "deny" },
		directory_listing: {
			mode: "off",
			max: { directory: false, card: true, a2a: false, did: true },
		},
		webhook_hosts: { mode: "off", allow: [] },
		funnel: { mode: "off" },
		acting_as: { mode: "off", agents: [] },
		external_groups: { mode: "off" },
		...rules,
	},
	groups_covered: rules.external_groups?.mode === "enforce",
	existing: {
		agents_above_ceiling: 0,
		webhooks_outside: 0,
		funnel_hooks: 0,
		groups_unpostable: 0,
		...existing,
	},
});

export const delegate = (id: string, name = "ops"): DelegateView => ({
	id,
	name,
	scopes: ["suspend"],
	signing_public_key: "k".repeat(43),
	key_id: "kid",
	created_at: T,
	revoked_at: null,
});

/** `GET /org/delegates` answers an object holding the list. */
export const delegateList = (...delegates: DelegateView[]) => ({ delegates });

export const agentStates = (id: string, handle: string): AgentStateView[] => [
	{ id, handle, branch: "main", hold: null },
	{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", handle: null, branch: null, hold: "org_frozen" },
];
