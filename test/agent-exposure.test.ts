import * as core from "@rine-network/core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { announceExposure, exposurePreset } from "../src/commands/agent-exposure-create.js";
import { registerAgentExposure } from "../src/commands/agent-exposure.js";
import { registerOrgExposure } from "../src/commands/org-exposure.js";
import * as promptModule from "../src/prompt.js";
import { h, run, useGovernanceHarness } from "./governance-harness.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LISTED = core.PRESETS.listed;
const FINDABLE = core.PRESETS.findable;

useGovernanceHarness();

function program(json = false): Command {
	const p = new Command();
	p.option("--json").option("--profile <p>");
	vi.spyOn(p, "opts").mockReturnValue(json ? { json: true } : {});
	registerAgentExposure(p.command("agent"), p);
	registerOrgExposure(p.command("org"), p);
	return p;
}

const view = (exposure: core.ExposureSet, extra = {}) => ({
	exposure,
	preset: core.presetOf(exposure, true),
	a2a_available: true,
	always_on: ["keys", "webfinger"],
	ceiling: null,
	above_ceiling: [],
	...extra,
});

const plan = (over = {}) => ({
	current: LISTED,
	target: FINDABLE,
	turned_on: [],
	turned_off: ["directory", "a2a"],
	hides_did: false,
	invalid: [],
	refused: [],
	...over,
});

function server(state: { view: object; plan?: object }) {
	h.reply = (method, path) => {
		if (path === `/agents/${ID}`) return { id: ID, name: "bot" };
		if (path.endsWith("/preview")) return state.plan;
		if (path.endsWith("/exposure") && method === "put") return view(FINDABLE);
		return state.view;
	};
}

describe("rine agent exposure", () => {
	it("test_exposure_when_shown_then_summary_switches_ceiling_and_above_lines_print", async () => {
		server({ view: view(LISTED, { ceiling: FINDABLE, above_ceiling: ["directory", "a2a"] }) });
		await run(program(), "agent", "exposure", ID);
		const out = h.out.join("\n");
		expect(out).toContain("bot is listed in the rine directory.");
		expect(out).toContain("Handle lookup (always on)");
		expect(out).toContain("Public keys (always on)");
		expect(out).toContain("not by these settings.");
		expect(out).toContain("Your organisation allows at most: findable by handle.");
		expect(out).toContain("bot shows more than your organisation now allows (directory listing, A2A discovery).");
	});

	it("test_exposure_set_when_confirmed_then_previews_before_it_writes", async () => {
		server({ view: view(LISTED), plan: plan() });
		vi.spyOn(promptModule, "promptConfirm").mockResolvedValue(true);
		await run(program(), "agent", "exposure", "set", ID, "findable");
		expect(h.calls.map((c) => `${c.method} ${c.path}`).filter((c) => c.includes("exposure"))).toEqual([
			`get /agents/${ID}/exposure`,
			`post /agents/${ID}/exposure/preview`,
			`put /agents/${ID}/exposure`,
		]);
		expect(h.calls.at(-1)?.body).toEqual({ exposure: FINDABLE });
		expect(h.out.join("\n")).toContain("Turns off: directory listing, A2A discovery.");
	});

	it("test_exposure_set_when_declined_then_nothing_is_written", async () => {
		server({ view: view(LISTED), plan: plan() });
		vi.spyOn(promptModule, "promptConfirm").mockResolvedValue(false);
		await run(program(), "agent", "exposure", "set", ID, "findable");
		expect(h.calls.some((c) => c.method === "put")).toBe(false);
		expect(h.out.join("\n")).toContain("Nothing changed.");
	});

	it("test_exposure_set_when_yes_and_did_hidden_then_warns_and_does_not_ask", async () => {
		server({ view: view(LISTED), plan: plan({ turned_off: ["did"], hides_did: true }) });
		const ask = vi.spyOn(promptModule, "promptConfirm");
		await run(program(), "agent", "exposure", "set", ID, "--did", "off", "--yes");
		expect(ask).not.toHaveBeenCalled();
		expect(h.out.join("\n")).toContain("Others can no longer check bot's did:web signatures.");
		expect(h.calls.find((c) => c.method === "put")?.body).toEqual({
			exposure: { ...LISTED, did: false },
		});
	});

	it("test_exposure_set_when_no_change_then_says_so_and_writes_nothing", async () => {
		server({ view: view(LISTED), plan: plan({ turned_off: [] }) });
		await run(program(), "agent", "exposure", "set", ID, "listed", "--yes");
		expect(h.out.join("\n")).toContain("No change.");
		expect(h.calls.some((c) => c.method === "put")).toBe(false);
	});

	it("test_exposure_set_when_above_the_ceiling_then_refuses_with_the_rule_sentence", async () => {
		server({ view: view(FINDABLE), plan: plan({ refused: ["directory"] }) });
		await run(program(), "agent", "exposure", "set", ID, "listed", "--yes");
		expect(h.out.join("\n")).toContain("does not allow its agents to turn on: directory listing.");
		expect(h.calls.some((c) => c.method === "put")).toBe(false);
	});

	it("test_exposure_set_when_card_off_but_directory_on_then_refuses_before_any_preview", async () => {
		server({ view: view(LISTED) });
		await run(program(), "agent", "exposure", "set", ID, "--card", "off", "--yes");
		expect(h.out.join("\n")).toContain("need the profile card on.");
		expect(h.calls.some((c) => c.path.endsWith("/preview"))).toBe(false);
	});

	it("test_exposure_set_when_no_preset_and_no_flag_then_asks_for_one", async () => {
		server({ view: view(LISTED) });
		await run(program(), "agent", "exposure", "set", ID);
		expect(h.out.join("\n")).toContain("Give a preset");
	});

	it("test_exposure_help_when_asked_then_says_lookup_always_works", () => {
		const exposure = program().commands.find((c) => c.name() === "agent")?.commands.find((c) => c.name() === "exposure");
		let text = "";
		exposure?.configureOutput({ writeOut: (s) => void (text += s) });
		exposure?.outputHelp();
		expect(text).toContain("A handle lookup always works and returns the agent's id and links.");
	});
});

describe("rine org exposure and the create notices", () => {
	it("test_org_exposure_when_run_then_prints_the_summary", async () => {
		h.reply = () => ({
			presets: { private: 2, findable: 1, listed: 0, custom: 0 },
			switches: { directory: 0, card: 1, a2a: 0, did: 1 },
			ceiling: null,
			above_ceiling: { count: 0, ids: [] },
		});
		await run(program(), "org", "exposure");
		expect(h.out.join("\n")).toBe("2 private, 1 findable by handle, 0 listed, 0 custom. 0 show more than the organisation's limit.");
	});

	it("test_announce_when_created_private_without_the_flag_then_prints_the_notice", () => {
		const agent = { name: "bot", exposure: core.PRESETS.private, preset: "private" } as unknown as core.CreatedAgent;
		announceExposure(agent, undefined);
		expect(h.out.join("\n")).toContain("bot was created private, as your organisation's directory_listing rule asks.");
	});

	it("test_announce_when_the_flag_was_given_then_prints_the_summary_and_otherwise_nothing", () => {
		const agent = { name: "bot", exposure: LISTED, preset: "listed" } as unknown as core.CreatedAgent;
		announceExposure(agent, "listed");
		announceExposure(agent, undefined);
		expect(h.out).toEqual(["bot is listed in the rine directory. Anyone can find it and read its profile."]);
	});

	it("test_announce_when_the_server_reports_a2a_off_then_the_summary_follows_its_preset", () => {
		const agent = { name: "bot", exposure: { ...LISTED, a2a: false }, preset: "listed" } as unknown as core.CreatedAgent;
		announceExposure(agent, "listed");
		expect(h.out).toEqual(["bot is listed in the rine directory. Anyone can find it and read its profile."]);
	});

	it("test_announce_when_the_ceiling_lowered_the_preset_then_prints_the_summary_and_the_capped_notice", () => {
		const agent = { name: "bot", exposure: core.PRESETS.findable, preset: "findable" } as unknown as core.CreatedAgent;
		announceExposure(agent, "listed");
		expect(h.out).toEqual([
			"Anyone who knows bot's handle can look it up and read its profile. It is not in the directory.",
			"Capped to findable by your organisation's directory_listing ceiling (you asked for listed).",
		]);
	});

	it("test_exposure_option_when_unknown_then_names_the_three", () => {
		expect(() => exposurePreset("custom")).toThrow("private, findable or listed");
		expect(exposurePreset(undefined)).toBeUndefined();
	});
});
