import * as fs from "node:fs";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import * as views from "./governance-views.js";
import { ORG, h, program, run, useGovernanceHarness } from "./governance-harness.js";

const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

useGovernanceHarness();

describe("agent suspend, resume, suspension", () => {
	const roster = {
		items: [
			{ id: ALPHA, name: "alpha", handle: "alpha@acme.rine.network" },
			{ id: BETA, name: "beta", handle: "beta@acme.rine.network" },
		],
	};

	it("test_agent_suspend_when_handle_then_posts_to_that_agent_only", async () => {
		h.reply = (_m, path) => (path === "/agents" ? roster : views.agentHold(BETA));
		await run(program(), "agent", "suspend", "beta@acme.rine.network");
		expect(h.calls.at(-1)).toMatchObject({
			method: "post",
			path: `/agents/${BETA}/suspend`,
		});
		expect(h.out.join("\n")).toContain(`Agent ${BETA} suspended.`);
	});

	it("test_agent_resume_when_repeat_then_says_already_resumed", async () => {
		h.reply = () => views.agentHold(ALPHA, false);
		await run(program(), "agent", "resume", ALPHA);
		expect(h.calls.map((c) => c.path)).toEqual([`/agents/${ALPHA}/resume`]);
		expect(h.out.join("\n")).toContain("was already resumed");
	});

	it("test_agent_suspend_when_name_matches_nobody_then_refuses_without_posting", async () => {
		h.reply = () => roster;
		await run(program(), "agent", "suspend", "gamma");
		expect(h.calls.some((c) => c.method === "post")).toBe(false);
		expect(process.exitCode).toBe(1);
		expect(h.out.join("\n")).toContain("No agent matches 'gamma'");
	});

	it("test_agent_suspension_when_json_then_prints_the_view", async () => {
		h.reply = () => views.suspension;
		await run(program(true), "agent", "suspension", ALPHA);
		expect(JSON.parse(h.out[0] as string)).toEqual(views.suspension);
	});

	it("test_agent_suspend_when_delegate_profile_then_handle_resolves_through_states", async () => {
		h.principal = { kind: core.PrincipalKind.Delegate, delegateId: DEL };
		h.reply = (_m, path) =>
			path === "/org/agents/states"
				? views.agentStates(ALPHA, "alpha@acme.rine.network")
				: views.agentHold(ALPHA);
		await run(program(), "agent", "suspend", "alpha@acme.rine.network");
		expect(h.calls.map((c) => c.path)).toEqual([
			"/org/agents/states",
			`/agents/${ALPHA}/suspend`,
		]);
	});
});

describe("branch and org holds", () => {
	it("test_branch_suspend_and_resume_when_named_then_post_branch_routes", async () => {
		h.reply = () => views.branchHold("partner-a");
		await run(program(), "org", "branch", "suspend", "partner-a");
		await run(program(), "org", "branch", "resume", "partner-a");
		expect(h.calls.map((c) => c.path)).toEqual([
			"/orgs/me/branches/partner-a/suspend",
			"/orgs/me/branches/partner-a/resume",
		]);
	});

	it("test_org_freeze_and_unfreeze_when_called_then_post_org_routes", async () => {
		await run(program(), "org", "freeze");
		await run(program(), "org", "unfreeze");
		expect(h.calls.map((c) => c.path)).toEqual(["/org/freeze", "/org/unfreeze"]);
	});

	it("test_org_unfreeze_when_rine_holds_the_freeze_then_exit_one_with_the_server_text", async () => {
		const text = "rine froze this organisation under reference 4471.";
		vi.spyOn(core.HttpClient.prototype, "post").mockRejectedValue(
			new core.RineApiError(403, text, undefined, "operator_frozen"),
		);
		await run(program(), "org", "unfreeze");
		expect(process.exitCode).toBe(1);
		expect(h.out.join("\n")).toContain(text);
	});
});

describe("org delegate", () => {
	it("test_delegate_create_when_ok_then_writes_key_and_profile_and_sends_only_the_public_key", async () => {
		h.reply = () => views.delegate(DEL);
		await run(
			program(),
			"org",
			"delegate",
			"create",
			"--name",
			"ops",
			"--scope",
			"suspend,freeze",
		);
		const body = h.calls[0]?.body as {
			name: string;
			scopes: string[];
			signing_public_key: string;
		};
		expect(body.scopes).toEqual(["suspend", "freeze"]);
		const config = join(h.dir, "config");
		const file = join(config, "delegates", `${DEL}.json`);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		const seed = JSON.parse(fs.readFileSync(file, "utf-8"))
			.signing_key as string;
		expect(JSON.stringify(h.calls)).not.toContain(seed);
		expect(core.getProfile(config, "ops")).toEqual({
			org_id: ORG,
			principal: `delegate:${DEL}`,
		});
	});

	it("test_delegate_create_when_public_key_given_then_sends_that_key_and_writes_no_seed_or_profile", async () => {
		h.reply = () => views.delegate(DEL);
		const key = "K".repeat(43);
		await run(
			program(),
			"org",
			"delegate",
			"create",
			"--name",
			"fleet",
			"--scope",
			"events:read,metadata:read",
			"--public-key",
			key,
		);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.body).toMatchObject({
			name: "fleet",
			scopes: ["events:read", "metadata:read"],
			signing_public_key: key,
		});
		const config = join(h.dir, "config");
		expect(fs.existsSync(join(config, "delegates"))).toBe(false);
		expect(core.getProfile(config, "fleet")).toBeUndefined();
		expect(h.out.join("\n")).toContain(`(${DEL})`);

		await run(
			program(),
			"org",
			"delegate",
			"create",
			"--name",
			"x",
			"--scope",
			"suspend",
			"--public-key",
			"short",
		);
		expect(h.out.join("\n")).toContain("43 characters");
		expect(h.calls).toHaveLength(1);
	});

	it("test_delegate_create_when_scope_unknown_or_profile_taken_then_refuses_before_any_request", async () => {
		await run(
			program(),
			"org",
			"delegate",
			"create",
			"--name",
			"ops",
			"--scope",
			"root",
		);
		core.addProfileIfAbsent(join(h.dir, "config"), "taken", {
			org_id: ORG,
			principal: `org:${ORG}`,
		});
		await run(
			program(),
			"org",
			"delegate",
			"create",
			"--name",
			"taken",
			"--scope",
			"suspend",
		);
		expect(h.calls).toEqual([]);
		expect(h.out.join("\n")).toContain("Unknown scope 'root'");
		expect(h.out.join("\n")).toContain("already exists");
	});

	it("test_delegate_create_when_key_cannot_be_saved_then_revokes_the_delegate", async () => {
		h.reply = () => views.delegate(DEL);
		fs.mkdirSync(join(h.dir, "config"), { recursive: true });
		fs.writeFileSync(
			join(h.dir, "config", "delegates"),
			"a file where a directory must go",
		);
		await run(
			program(),
			"org",
			"delegate",
			"create",
			"--name",
			"ops",
			"--scope",
			"suspend",
		);
		expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"post /org/delegates",
			`delete /org/delegates/${DEL}`,
		]);
		expect(process.exitCode).toBe(1);
	});

	it("test_delegate_revoke_when_name_then_finds_the_live_key_by_name", async () => {
		h.reply = (m) =>
			m === "get"
				? views.delegateList(
						{ ...views.delegate(ALPHA), revoked_at: "2026-11-05T09:00:00Z" },
						views.delegate(DEL),
					)
				: views.delegate(DEL);
		await run(program(), "org", "delegate", "revoke", "ops");
		expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"get /org/delegates",
			`delete /org/delegates/${DEL}`,
		]);
	});

	it("test_delegate_list_when_json_then_prints_the_list", async () => {
		const list = [views.delegate(DEL)];
		h.reply = () => views.delegateList(...list);
		await run(program(true), "org", "delegate", "list");
		expect(JSON.parse(h.out[0] as string)).toEqual(list);
	});
});

describe("org counterparties and log-settings", () => {
	const week = 7 * 24 * 60 * 60 * 1000;
	const other = (id: string, ago: number) => ({
		counterparty_org_id: id,
		first_seen: new Date(Date.now() - ago).toISOString(),
		last_seen: "2026-11-09T10:00:00Z",
		first_direction: "inbound",
		first_outbound_at: null,
		shares_group: false,
		sent_total: 1,
		received_total: 2,
		sent_30d: 1,
		received_30d: 2,
	});
	const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

	it("test_counterparties_when_listed_then_prints_the_count_header_and_one_line_per_org_with_its_check_code", async () => {
		h.reply = (_m, path) =>
			path === "/org/counterparties"
				? {
						counterparties: [other(A, 60_000), other(B, 2 * week)],
						next_cursor: null,
					}
				: {};
		await run(program(), "org", "counterparties");
		const words = core.orgWords(A);
		expect(h.out).toEqual([
			"2 organisations, 1 new this week",
			`${A}  Check this code with a contact at that organisation: ${words}. Names and slugs are chosen by whoever registers them.`,
			expect.stringContaining(B),
		]);
	});

	it("test_log_settings_when_set_then_puts_the_days_and_prints_the_kept_text", async () => {
		h.reply = () => ({ event_retention_days: 90 });
		await run(program(), "org", "log-settings", "set", "90");
		expect(h.calls[0]).toMatchObject({
			method: "put",
			path: "/org/log-settings",
			body: { event_retention_days: 90 },
		});
		expect(h.out).toEqual([
			"Events are now kept for 90 days. Events already older are removed within a day.",
		]);
		await run(program(), "org", "log-settings", "get");
		expect(h.out.at(-1)).toBe("Event retention: 90 days");
	});
});
