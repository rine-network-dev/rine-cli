import * as fs from "node:fs";
import * as core from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import {
	RUNTIME_MARKERS,
	RUNTIME_WARNING,
	runtimeOf,
} from "../src/commands/runtime-warning.js";
import { promptConfirm } from "../src/prompt.js";
import { h, program, run, useGovernanceHarness } from "./governance-harness.js";
import * as views from "./governance-views.js";

vi.mock("../src/prompt.js", () => ({ promptConfirm: vi.fn() }));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENTRY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const codes = JSON.parse(
	fs.readFileSync(
		new URL("../../rine-core/test/fixtures/governance-codes.json", import.meta.url),
		"utf-8",
	),
) as { rule_refusals: string[] };

useGovernanceHarness();

const patches = () => h.calls.filter((c) => c.method === "patch");
const text = () => h.out.join("\n");

describe("org rules set", () => {
	it("test_rules_set_when_enforce_then_patch_carries_the_read_version_and_the_nested_rule", async () => {
		h.reply = (m) => views.policy(7, m === "get" ? "off" : "enforce");
		await run(program(), "org", "rules", "set", "new_agents", "enforce");
		expect(h.calls.map((c) => c.method)).toEqual(["get", "patch"]);
		expect(h.calls[1]?.body).toEqual({
			version: 7,
			rules: { new_agents: { mode: "enforce" } },
		});
		expect(h.out).toEqual(["new_agents: enforce"]);
	});

	it("test_rules_set_when_unknown_rule_or_mode_then_refuses_before_any_request", async () => {
		await run(program(), "org", "rules", "set", "colour", "off");
		await run(program(), "org", "rules", "set", "new_agents", "report");
		await run(program(), "org", "rules", "set", "funnel", "maybe");
		expect(h.calls).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("test_rules_set_when_message_rule_then_default_is_sent_and_kept_otherwise", async () => {
		h.reply = () => views.policy(2, "off");
		await run(program(), "org", "rules", "set", "external_outbound", "report", "--default", "allow");
		expect(patches()[0]?.body).toEqual({
			version: 2,
			rules: { external_outbound: { mode: "report", default: "allow" } },
		});
		await run(program(), "org", "rules", "set", "external_inbound", "enforce");
		expect(patches()[1]?.body).toMatchObject({
			rules: { external_inbound: { mode: "enforce", default: "deny" } },
		});
	});

	it("test_rules_set_when_ceiling_flags_then_preset_is_the_base_and_switches_override", async () => {
		h.reply = () => views.policy(3, "off");
		await run(program(), "org", "rules", "set", "directory_listing", "enforce", "--max", "findable", "--max-did", "off");
		expect(patches()[0]?.body).toMatchObject({
			rules: {
				directory_listing: {
					mode: "enforce",
					max: { directory: false, card: true, a2a: false, did: false },
				},
			},
		});
	});

	it("test_rules_set_when_ceiling_needs_a_card_it_lacks_then_refuses_without_a_patch", async () => {
		h.reply = () => views.policy(3, "off");
		await run(program(), "org", "rules", "set", "directory_listing", "enforce", "--max", "listed", "--max-card", "off");
		expect(patches()).toEqual([]);
		expect(text()).toContain("need the profile card on");
		expect(process.exitCode).toBe(1);
	});

	it("test_rules_set_when_flag_belongs_to_another_rule_then_refuses_before_any_request", async () => {
		await run(program(), "org", "rules", "set", "funnel", "enforce", "--host", "a.test");
		expect(h.calls).toEqual([]);
		expect(text()).toContain("--host does not apply to funnel");
	});

	it("test_rules_set_when_webhooks_stand_outside_then_prints_the_stop_command", async () => {
		h.reply = (m) =>
			m === "get"
				? views.policy(1, "off")
				: views.policy(2, "off", {}, { webhooks_outside: 2 }),
		await run(program(), "org", "rules", "set", "webhook_hosts", "enforce", "--host", "*.a.test", "--host", "b.test");
		expect(patches()[0]?.body).toMatchObject({
			rules: { webhook_hosts: { mode: "enforce", allow: ["*.a.test", "b.test"] } },
		});
		expect(h.out).toEqual([
			"webhook_hosts: off",
			"2 existing webhooks are outside this rule. To stop them: rine org rules stop-existing webhook_hosts",
		]);
	});

	it("test_rules_set_when_acting_as_then_agents_resolve_to_ids", async () => {
		h.reply = (_m, path) =>
			path === "/agents"
				? { items: [{ id: A, name: "alpha", handle: "alpha@acme.rine.network" }] }
				: views.policy(1, "off");
		await run(program(), "org", "rules", "set", "acting_as", "enforce", "--agent", "alpha");
		expect(patches()[0]?.body).toMatchObject({
			rules: { acting_as: { mode: "enforce", agents: [A] } },
		});
	});

	it.each(codes.rule_refusals)("test_rules_set_when_server_refuses_with_%s_then_its_sentence_is_printed", async (code) => {
		const sentence = `refused: ${code}`;
		h.reply = (m) => {
			if (m === "patch")
				throw new core.RineApiError(code === "domain_unproven" ? 422 : 403, sentence, undefined, code);
			return views.policy(1, "off");
		};
		await run(program(), "org", "rules", "set", "funnel", "enforce");
		expect(text()).toContain(sentence);
		expect(process.exitCode).toBe(1);
	});
});

describe("org rules show, preview and stop-existing", () => {
	it("test_rules_show_when_message_rule_on_then_prints_the_groups_sentence_and_the_summary", async () => {
		h.reply = () =>
			views.policy(1, "enforce", { external_outbound: { mode: "enforce", default: "deny" } });
		await run(program(), "org", "rules", "show");
		expect(text()).toContain("external_outbound: enforce");
		expect(text()).toContain("Does not cover groups: members from any organisation can still join and post. In sender-key groups, members from organisations this rule refuses");
		expect(h.out.at(-1)).toBe("2 of 8 rules on, 0 reporting. Groups are not covered.");
	});

	it("test_rules_show_when_ceiling_on_then_names_the_preset_and_agents_above_it", async () => {
		h.reply = () =>
			views.policy(
				1,
				"off",
				{ directory_listing: { mode: "enforce", max: { directory: false, card: true, a2a: false, did: true } } },
				{ agents_above_ceiling: 3 },
			);
		await run(program(), "org", "rules", "show");
		expect(text()).toContain("Agents may show at most: findable. 3 agents show more than that, and keep doing so until you stop them.");
	});

	it("test_rules_show_when_the_server_reports_no_group_rule_then_the_seven_it_has_are_shown", async () => {
		h.reply = () => {
			const full = views.policy(1, "enforce");
			const { external_groups: _, ...seven } = full.rules;
			const { groups_unpostable: __, ...existing } = full.existing;
			return { ...full, rules: seven, existing };
		};
		await run(program(), "org", "rules", "show");
		expect(process.exitCode).not.toBe(1);
		expect(text()).toContain("acting_as: off");
		expect(text()).not.toContain("external_groups");
		expect(h.out.at(-1)).toBe("1 of 7 rules on, 0 reporting.");
	});

	it("test_rules_show_when_json_then_the_policy_is_printed_unchanged", async () => {
		h.reply = () => views.policy(1, "off");
		await run(program(true), "org", "rules", "show");
		expect(JSON.parse(h.out[0] as string)).toEqual(views.policy(1, "off"));
	});

	it("test_rules_preview_when_message_rule_then_prints_the_counts_and_one_line_per_org", async () => {
		h.reply = () => ({
			kind: "messages",
			rule: "external_outbound",
			refused_messages: 35,
			counterparties: 2,
			top: [{ org_id: B, slug: "acme", messages: 30, last_at: new Date().toISOString() }],
			key_messages: 4,
			window_days: 30,
			since: "2026-10-10T00:00:00Z",
			not_counted: ["welcomes", "beyond_retention"],
		});
		await run(program(), "org", "rules", "preview", "external_outbound");
		expect(h.calls[0]).toMatchObject({ path: "/org/policy/preview" });
		expect(h.out[0]).toBe("About 35 messages to 2 organisations in the last 30 days would have been refused.");
		expect(h.out[1]).toMatch(/^ {2}@acme {2}30 messages {2}last /);
		expect(h.out.at(-2)).toBe("Of these, about 4 were group key messages.");
	});

	it("test_rules_stop_existing_when_funnel_call_stopped_early_then_says_to_run_again", async () => {
		h.reply = () => ({ rule: "funnel", stopped: 20, remaining: 5 });
		await run(program(), "org", "rules", "stop-existing", "funnel");
		expect(h.calls[0]).toMatchObject({ method: "post", path: "/org/policy/stop-existing", body: { rule: "funnel" } });
		expect(h.out).toEqual([
			"Removed 20 funnel hooks.",
			"5 funnel hooks remain. Run the command again to remove them.",
		]);
	});

	it("test_rules_stop_existing_when_rule_has_nothing_to_stop_then_refuses_before_any_request", async () => {
		await run(program(), "org", "rules", "stop-existing", "new_agents");
		expect(h.calls).toEqual([]);
		expect(process.exitCode).toBe(1);
	});
});

describe("the agent-runtime warning", () => {
	it("test_runtime_of_when_each_marker_is_set_then_names_its_runtime_and_a_plain_shell_none", () => {
		for (const { runtime, vars } of RUNTIME_MARKERS)
			for (const v of vars) expect(runtimeOf({ [v]: "1" })).toBe(runtime);
		expect(runtimeOf({ PATH: "/bin" })).toBeUndefined();
		expect(runtimeOf({ CLAUDECODE: "" })).toBeUndefined();
	});

	it("test_rules_set_when_in_a_runtime_then_warns_on_stderr_and_still_runs", async () => {
		vi.stubEnv("CLAUDECODE", "1");
		h.reply = () => views.policy(1, "off");
		await run(program(), "org", "rules", "set", "funnel", "enforce");
		expect(h.out[0]).toBe(RUNTIME_WARNING);
		expect(patches()).toHaveLength(1);
	});

	it("test_rules_set_when_in_a_plain_shell_then_no_warning", async () => {
		h.reply = () => views.policy(1, "off");
		await run(program(), "org", "rules", "set", "funnel", "enforce");
		expect(text()).not.toContain(RUNTIME_WARNING);
	});
});

describe("org counterparties allow, block, remove, entries", () => {
	const lookup = { org_id: B, name: "Acme GmbH", slug: "acme", tier: 1, proven_domains: ["acme.test"] };
	const entry = (direction: string) => ({
		id: ENTRY, direction, scope_kind: "org", scope_agent_id: null, counterparty_org_id: B,
		counterparty_agent_id: null, decision: "allow", groups: true, reason: "partner",
		decided_at: "2026-11-10T00:00:00Z", decided_by: "org",
	});
	const serve = (_m: string, path: string) => {
		if (path === "/org/counterparties/lookup") return lookup;
		if (path === "/groups") return { items: [{ enrollment_policy: "open" }, { enrollment_policy: "closed" }] };
		if (path === "/org/policy") return views.policy(1, "off");
		return entry("outbound");
	};

	it("test_allow_when_confirmed_then_prints_the_lookup_and_writes_one_entry_per_direction", async () => {
		h.reply = serve;
		vi.mocked(promptConfirm).mockResolvedValue(true);
		await run(program(), "org", "counterparties", "allow", "acme", "--groups", "--reason", "partner");
		expect(h.out.slice(0, 4)).toEqual([
			"Acme GmbH  org bbbbbbbb…  tier 1",
			"Proven domain: acme.test.",
			"Check this code with a contact at Acme GmbH:",
			`  ${core.orgWords(B)}`,
		]);
		expect(text()).toContain("this organisation can join your 1 open groups once the group rule is on");
		const puts = h.calls.filter((c) => c.method === "put");
		expect(puts.map((c) => (c.body as { direction: string }).direction)).toEqual(["outbound", "inbound"]);
		expect(puts[0]?.body).toEqual({
			direction: "outbound", counterparty_org_id: B, decision: "allow", groups: true, reason: "partner",
		});
		expect(promptConfirm).toHaveBeenCalledTimes(1);
	});

	it("test_allow_when_not_confirmed_then_nothing_is_written", async () => {
		h.reply = serve;
		vi.mocked(promptConfirm).mockResolvedValue(false);
		await run(program(), "org", "counterparties", "block", "acme", "--outbound", "--reason", "spam");
		expect(h.calls.filter((c) => c.method === "put")).toEqual([]);
	});

	it("test_block_when_yes_then_no_prompt_and_a_single_direction_is_written", async () => {
		h.reply = serve;
		vi.mocked(promptConfirm).mockClear();
		await run(program(), "org", "counterparties", "block", "acme", "--inbound", "--yes", "--reason", "spam");
		expect(promptConfirm).not.toHaveBeenCalled();
		const puts = h.calls.filter((c) => c.method === "put");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toMatchObject({ direction: "inbound", decision: "block", groups: false });
	});

	it("test_allow_when_no_proven_domain_then_says_names_are_chosen_by_whoever_registers", async () => {
		h.reply = (m, p) => (p === "/org/counterparties/lookup" ? { ...lookup, proven_domains: [] } : serve(m, p));
		await run(program(), "org", "counterparties", "allow", "acme", "--yes", "--reason", "x");
		expect(h.out[1]).toBe("No proven domain. Names and slugs are chosen by whoever registers them.");
	});

	it("test_allow_when_json_then_only_the_entries_are_printed", async () => {
		h.reply = serve;
		await run(program(true), "org", "counterparties", "allow", B, "--outbound", "--reason", "x");
		expect(h.out).toHaveLength(1);
		expect(JSON.parse(h.out[0] as string)).toHaveLength(1);
	});

	it("test_allow_when_two_directions_named_then_refuses_before_any_request", async () => {
		await run(program(), "org", "counterparties", "allow", "acme", "--inbound", "--outbound", "--reason", "x");
		expect(h.calls).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("test_remove_and_entries_when_called_then_delete_the_entry_and_export_all", async () => {
		h.reply = (_m, path) => (path === "/org/allow" ? { entries: [entry("outbound")], next_cursor: null } : undefined);
		await run(program(), "org", "counterparties", "remove", ENTRY, "--reason", "ended");
		expect(h.calls[0]).toMatchObject({ method: "delete", path: `/org/allow/${ENTRY}` });
		h.out.length = 0;
		await run(program(true), "org", "counterparties", "entries");
		expect(JSON.parse(h.out[0] as string)).toEqual([entry("outbound")]);
	});
});

describe("org domain", () => {
	const view = (status: string) => ({
		domain: "acme.test", status, txt_name: "_rine.acme.test", txt_value: `rine-org=${A}`,
		created_at: "2026-11-10T00:00:00Z", verified_at: null, last_checked_at: null,
	});

	it("test_domain_add_when_claimed_then_prints_the_record_to_publish", async () => {
		h.reply = () => view("pending");
		await run(program(), "org", "domain", "add", "acme.test");
		expect(h.calls[0]).toMatchObject({ method: "post", path: "/org/domains", body: { domain: "acme.test" } });
		expect(h.out).toEqual([`Add a TXT record named _rine.acme.test with the value rine-org=${A}, then run: rine org domain verify acme.test`]);
	});

	it("test_domain_verify_when_proven_then_says_so_and_when_unproven_prints_the_refusal", async () => {
		h.reply = () => view("proven");
		await run(program(), "org", "domain", "verify", "acme.test");
		expect(h.out).toEqual(["acme.test is proven for this organisation."]);
		h.reply = () => {
			throw new core.RineApiError(422, "No TXT record _rine.acme.test with the value x was found.", undefined, "domain_unproven");
		};
		await run(program(), "org", "domain", "verify", "acme.test");
		expect(text()).toContain("No TXT record _rine.acme.test");
		expect(process.exitCode).toBe(1);
	});

	it("test_domain_list_and_remove_when_called_then_status_words_and_delete_path", async () => {
		h.reply = () => [view("lost")];
		await run(program(), "org", "domain", "list");
		expect(text()).toContain("no longer proven: the record was not found at two checks, or DNS gave no answer at seven");
		h.reply = () => undefined;
		await run(program(), "org", "domain", "remove", "acme.test");
		expect(h.calls.at(-1)).toMatchObject({ method: "delete", path: "/org/domains/acme.test" });
	});
});
