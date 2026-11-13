import * as core from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import { promptConfirm } from "../src/prompt.js";
import { h, program, run, useGovernanceHarness } from "./governance-harness.js";
import * as views from "./governance-views.js";

vi.mock("../src/prompt.js", () => ({ promptConfirm: vi.fn() }));

const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const text = () => h.out.join("\n");
const ENFORCE = { mode: "enforce" } as const;
const messageRule = { mode: "enforce", default: "deny" } as const;

useGovernanceHarness();

describe("rules show, with the group rule", () => {
	it("test_rules_show_when_groups_enforce_and_inbound_enforces_then_prints_the_key_sentence", async () => {
		h.reply = () =>
			views.policy(
				1,
				"off",
				{ external_groups: ENFORCE, external_inbound: messageRule },
				{ groups_unpostable: 3 },
			);
		await run(program(), "org", "rules", "show");
		expect(text()).toContain(
			"  3 groups hold members outside your list. Your agents cannot post there. Keys you already hold still open their posts; new keys arrive only from organisations your incoming message rule allows, and posts sealed with a key that never arrived stay unreadable. In a foreign open group, allowing does not restore posting: leave, or ask the owner to close it.",
		);
		expect(text()).not.toContain("Does not cover groups");
	});

	it("test_rules_show_when_groups_enforce_and_inbound_is_off_then_prints_they_keep_reading", async () => {
		h.reply = () =>
			views.policy(1, "off", { external_groups: ENFORCE }, { groups_unpostable: 1 });
		await run(program(), "org", "rules", "show");
		expect(text()).toContain(
			"  1 group holds members outside your list. Your agents cannot post there, and they keep reading. In a foreign open group, allowing does not restore posting: leave, or ask the owner to close it.",
		);
	});

	it("test_rules_show_when_groups_enforce_and_none_is_unpostable_then_prints_the_clear_line", async () => {
		h.reply = () => views.policy(1, "off", { external_groups: ENFORCE });
		await run(program(), "org", "rules", "show");
		expect(text()).toContain("  No group your agents are in holds members outside your list.");
	});

	it("test_rules_show_when_groups_are_not_enforced_then_message_rules_say_so_and_the_summary_too", async () => {
		h.reply = () =>
			views.policy(1, "off", {
				external_groups: { mode: "report" },
				external_outbound: messageRule,
			});
		await run(program(), "org", "rules", "show");
		expect(text()).toContain("Does not cover groups: members from any organisation can still join and post.");
		expect(text()).not.toContain("hold members outside");
		expect(h.out.at(-1)).toBe("1 of 8 rules on, 1 reporting. Groups are not covered.");
	});

	it("test_rules_show_when_no_message_rule_is_on_then_the_summary_does_not_mention_groups", async () => {
		h.reply = () => views.policy(1, "off");
		await run(program(), "org", "rules", "show");
		expect(h.out.at(-1)).toBe("0 of 8 rules on, 0 reporting.");
	});
});

describe("rules set external_groups", () => {
	it.each(["off", "report", "enforce"])("test_rules_set_when_groups_mode_is_%s_then_the_patch_is_sent", async (mode) => {
		h.reply = () => views.policy(4, "off");
		await run(program(), "org", "rules", "set", "external_groups", mode);
		expect(h.calls.find((c) => c.method === "patch")?.body).toEqual({
			version: 4,
			rules: { external_groups: { mode } },
		});
	});

	it("test_rules_set_when_enforce_leaves_groups_unpostable_then_prints_the_seats_kept_line", async () => {
		h.reply = (m) =>
			m === "get"
				? views.policy(1, "off")
				: views.policy(2, "off", { external_groups: ENFORCE }, { groups_unpostable: 2 });
		await run(program(), "org", "rules", "set", "external_groups", "enforce");
		expect(h.out).toEqual([
			"external_groups: enforce",
			"2 groups your agents are in hold members outside this rule. Your agents keep their seats and cannot post there.",
		]);
	});

	it("test_rules_set_when_enforce_leaves_none_unpostable_then_prints_only_the_mode", async () => {
		h.reply = (m) =>
			m === "get"
				? views.policy(1, "off")
				: views.policy(2, "off", { external_groups: ENFORCE });
		await run(program(), "org", "rules", "set", "external_groups", "enforce");
		expect(h.out).toEqual(["external_groups: enforce"]);
	});
});

describe("rules preview external_groups", () => {
	it("test_rules_preview_when_groups_then_prints_the_counts_and_the_closed_group_advice", async () => {
		h.reply = () => ({
			kind: "groups",
			rule: "external_groups",
			groups: 4,
			foreign_open_groups: 2,
			invitations: 1,
			applications: 3,
		});
		await run(program(), "org", "rules", "preview", "external_groups");
		expect(h.calls[0]).toMatchObject({ path: "/org/policy/preview" });
		expect(h.out).toEqual([
			"4 groups hold members outside your list; your agents could not post there. 2 of them are open groups owned by other organisations, where allowing does not restore posting. 1 invitation would be hidden and 3 applications would lose their message.",
			"Two organisations that both turn this rule on cannot share an open group. Use a closed group; an existing sender-key group does not convert.",
		]);
	});
});

describe("counterparties allow --groups", () => {
	const serve = (policy: ReturnType<typeof views.policy>) => (_m: string, path: string) => {
		if (path === "/org/counterparties/lookup")
			return { org_id: B, name: "Acme GmbH", slug: "acme", tier: 1, proven_domains: [] };
		if (path === "/groups") return { items: [{ enrollment_policy: "open" }] };
		if (path === "/org/policy") return policy;
		return {};
	};
	const allow = async () => {
		vi.mocked(promptConfirm).mockResolvedValue(true);
		await run(program(), "org", "counterparties", "allow", "acme", "--groups", "--reason", "partner");
	};

	it("test_allow_groups_when_the_group_rule_enforces_then_prints_the_join_without_the_caveat", async () => {
		h.reply = serve(views.policy(1, "off", { external_groups: ENFORCE }));
		await allow();
		expect(text()).toContain(
			"With groups allowed, this organisation can join your 1 open groups, and your agents will send it the current group key.",
		);
		expect(text()).not.toContain("once the group rule is on");
	});

	it("test_allow_groups_when_the_group_rule_is_not_enforced_then_prints_the_once_it_is_on_line", async () => {
		h.reply = serve(views.policy(1, "off", { external_groups: { mode: "report" } }));
		await allow();
		expect(text()).toContain(
			"this organisation can join your 1 open groups once the group rule is on, and your agents will send it the current group key.",
		);
	});
});

describe("the removed refusal", () => {
	it("test_rule_refusal_codes_when_listed_then_rule_unavailable_is_gone", () => {
		expect(Object.values(core.RuleRefusal)).not.toContain("rule_unavailable");
	});
});
