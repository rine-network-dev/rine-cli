import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPollToken } from "../src/commands/poll-token.js";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const POLL_URL = "https://rine.network/poll/tok-new";
const PROFILE = {
	org_id: "org-uuid",
	principal: `agent:${AGENT_ID}`,
	branch: "main",
	agent_id: AGENT_ID,
};

let configDir: string;
let posts: string[];
let deletes: string[];

function makeProgram(): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue({});
	registerPollToken(program);
	return program;
}

const run = (...args: string[]) =>
	makeProgram().parseAsync(["node", "rine", "poll-token", "--agent", AGENT_ID, ...args]);

beforeEach(() => {
	configDir = fs.mkdtempSync(join(tmpdir(), "rine-cli-poll-"));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(configDir);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue(join(configDir, "owner"));
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	posts = [];
	deletes = [];
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		async (path: string) => {
			posts.push(path);
			return { poll_url: POLL_URL };
		},
	);
	vi.spyOn(core.HttpClient.prototype, "delete").mockImplementation(
		async (path: string) => {
			deletes.push(path);
			return undefined;
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(configDir, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("poll-token", () => {
	it("mints a token for the acting agent and records the URL in the profile", async () => {
		core.saveProfiles(configDir, { default: { ...PROFILE } });

		await run();

		expect(posts).toEqual([`/agents/${AGENT_ID}/poll-token`]);
		expect(core.loadProfiles(configDir).default?.poll_url).toBe(POLL_URL);
	});

	it("prints the poll URL", async () => {
		core.saveProfiles(configDir, { default: { ...PROFILE } });
		const log = vi.spyOn(console, "log");

		await run();

		expect(log).toHaveBeenCalledWith(`Poll URL: ${POLL_URL}`);
	});

	it("--revoke deletes the token and drops poll_url from the profile", async () => {
		core.saveProfiles(configDir, {
			default: { ...PROFILE, poll_url: POLL_URL },
		});

		await run("--revoke");

		expect(deletes).toEqual([`/agents/${AGENT_ID}/poll-token`]);
		expect(posts).toEqual([]);
		expect(core.loadProfiles(configDir).default).not.toHaveProperty("poll_url");
		expect(core.loadProfiles(configDir).default?.agent_id).toBe(AGENT_ID);
	});

	it("leaves the profile file alone when a revoke finds no poll_url to drop", async () => {
		core.saveProfiles(configDir, { default: { ...PROFILE } });

		await run("--revoke");

		expect(deletes).toEqual([`/agents/${AGENT_ID}/poll-token`]);
		expect(core.loadProfiles(configDir).default).toEqual(PROFILE);
	});
});
