import * as core from "@rine-network/core";
import { Command } from "commander";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDiscover } from "../src/commands/discover.js";
import * as outputModule from "../src/output.js";

// The thirteenth group argument, the one the handle-and-name widening misses.
//
// `rine discover groups inspect` reads the PUBLIC directory, which is not the
// caller's own group list, so the member ladder has no rung that could match a
// handle or a name. Before this it handed the raw string to
// `/directory/groups/{ref}` and got a 200 with a table of empty cells back,
// which is worse than a refusal because it looks like an answer.
//
// A refusal like this has to be gated here: nothing binds a CLI
// refusal cross-stack, so an editor who finds the sentence unhelpful can
// delete it and no suite objects. Mutation: drop the `UUID_RE` guard in
// `discover-groups.ts` and this file goes red on both counts.

const API_URL = "https://test.rine.network";
const GROUP_ID = "88888888-8888-8888-8888-888888888888";

let errors: string[];
let publicGet: MockInstance<typeof core.HttpClient.publicGet>;

beforeEach(() => {
	errors = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(outputModule, "printError").mockImplementation((s) => {
		errors.push(s);
	});
	vi.spyOn(outputModule, "printJson").mockImplementation(() => {});
	vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	publicGet = vi
		.spyOn(core.HttpClient, "publicGet")
		.mockResolvedValue({ id: GROUP_ID } as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function run(args: string[]): Promise<unknown> {
	const program = new Command();
	program.option("--json", "Output JSON");
	registerDiscover(program);
	return program.parseAsync(["node", "rine", "discover", ...args]);
}

describe("discover groups inspect — a directory id, refused on shape", () => {
	it("refuses a handle before any request, and names the two verbs that do take one", async () => {
		await run(["groups", "inspect", "#ops@acme.rine.network"]);

		const said = errors.join("\n");
		expect(publicGet).not.toHaveBeenCalled();
		expect(said).toContain("#ops@acme.rine.network");
		expect(said).toContain("indexes groups by id only");
		expect(said).toContain("rine discover groups");
		expect(said).toContain("rine group get");
		// It was refused on its SHAPE, before any lookup — so it must not open
		// with the six-consumer `Group not found` lead, which says something was
		// looked up and answered nothing.
		expect(said).not.toContain("Group not found");
		expect(process.exitCode).toBe(1);
	});

	it("refuses a bare name the same way", async () => {
		await run(["groups", "inspect", "ops"]);

		expect(publicGet).not.toHaveBeenCalled();
		expect(errors.join("\n")).toContain("is not a group UUID");
		expect(process.exitCode).toBe(1);
	});

	it("lets a UUID through to the directory", async () => {
		await run(["groups", "inspect", GROUP_ID]);

		expect(publicGet).toHaveBeenCalledWith(
			API_URL,
			`/directory/groups/${GROUP_ID}`,
		);
		expect(errors).toEqual([]);
		expect(process.exitCode).toBeUndefined();
	});
});
