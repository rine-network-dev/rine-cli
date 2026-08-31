// Item 18 — `rine discover inspect` announces the handle it actually looked up.
//
// `resolveToUuid` applies `normalizeHandle`, so a caller who types `kofi@acme`
// reaches WebFinger as `kofi@acme.rine.network` and — before this — was told
// nothing. The ruling: approve the rewrite, and print the substitution. No
// silent normalisation.
//
// 🔴 The notice goes to STDERR and is deliberately NOT gated on `--json`. A
// machine reader is the caller a silent rewrite harms MOST, and stderr costs it
// nothing: stdout stays exactly the one JSON document it was.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDiscover } from "../src/commands/discover.js";
import * as outputModule from "../src/output.js";

const API_URL = "https://test.rine.network";
const AGENT_ID = "44444444-4444-4444-4444-444444444444";

/** What gets typed: the org half without its domain. */
const TYPED = "kofi@acme";
/** What `normalizeHandle` completes it to, and what WebFinger is actually asked. */
const COMPLETED = "kofi@acme.rine.network";

let errors: string[];
let jsonPayloads: unknown[];
let texts: string[];
let resolveToUuid: MockInstance<typeof core.resolveToUuid>;

beforeEach(() => {
	errors = [];
	jsonPayloads = [];
	texts = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(outputModule, "printError").mockImplementation((s) => {
		errors.push(s);
	});
	vi.spyOn(outputModule, "printText").mockImplementation((s) => {
		texts.push(s);
	});
	vi.spyOn(outputModule, "printJson").mockImplementation((d) => {
		jsonPayloads.push(d);
	});
	vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	resolveToUuid = vi.spyOn(core, "resolveToUuid").mockResolvedValue(AGENT_ID);
	vi.spyOn(core.HttpClient, "publicGet").mockResolvedValue({
		card: { name: "Kofi" },
	} as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function run(args: string[], globalOpts: Record<string, unknown> = {}) {
	const program = new Command();
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerDiscover(program);
	return program.parseAsync(["node", "rine", "discover", ...args]);
}

describe("discover inspect — the substitution is announced", () => {
	it("names both spellings when the handle was completed", async () => {
		await run(["inspect", TYPED]);

		const said = errors.join("\n");
		expect(said).toContain(TYPED);
		expect(said).toContain(COMPLETED);
		// 🔴 Only the caller's own two strings. No third handle, no
		// example, no template org for a model to copy.
		expect(said.match(/@[a-z0-9.-]+/g)).toEqual(["@acme", "@acme.rine.network"]);
		// The resolver is still handed what the caller typed — the announcement
		// reports the rewrite, it does not perform it.
		expect(resolveToUuid).toHaveBeenCalledWith(API_URL, TYPED);
	});

	it("says nothing when the spelling was already normalised", async () => {
		await run(["inspect", COMPLETED]);

		expect(errors).toEqual([]);
	});

	it("says nothing for a UUID, which names no domain to complete", async () => {
		await run(["inspect", AGENT_ID]);

		expect(errors).toEqual([]);
	});

	it("still announces under --json, and leaves stdout one parseable document", async () => {
		await run(["inspect", TYPED], { json: true });

		expect(errors.join("\n")).toContain(COMPLETED);
		// Everything the machine reader consumes: exactly one JSON payload, and
		// nothing else printed to stdout beside it.
		expect(jsonPayloads).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(jsonPayloads[0]))).toEqual({
			card: { name: "Kofi" },
		});
		expect(texts).toEqual([]);
	});
});
