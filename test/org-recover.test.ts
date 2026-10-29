import { Readable } from "node:stream";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOrgRecover } from "../src/commands/org-recover.js";
import * as outputModule from "../src/output.js";

const PHRASE =
	"abandon ability able about above absent absorb abstract absurd abuse access accident";

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerOrgRecover(program.command("org"), program);
	return program;
}

function report(overrides: Partial<core.RecoveryReport> = {}): core.RecoveryReport {
	return {
		org_id: "11111111-2222-3333-4444-555555555555",
		org_words: "alpha beta gamma delta epsilon zeta eta theta",
		branches: ["main"],
		agents: [
			{
				agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				name: "bot",
				branch: "main",
				key_gen: 0,
				status: "restored",
			},
		],
		closed_groups: [],
		gap_markers: [],
		notes: ["a note"],
		...overrides,
	};
}

/** Feed `text` to stdin as a non-TTY stream. */
function mockStdin(text: string): () => void {
	const original = process.stdin;
	Object.defineProperty(process, "stdin", {
		value: Object.assign(Readable.from([text]), { isTTY: false }),
		configurable: true,
	});
	return () =>
		Object.defineProperty(process, "stdin", {
			value: original,
			configurable: true,
		});
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

describe("rine org recover", () => {
	it("passes the phrase read from stdin to performRecovery and prints org words first", async () => {
		const restore = mockStdin(`${PHRASE}\n`);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recoverSpy = vi
			.spyOn(core, "performRecovery")
			.mockImplementation(async (_api, _dirs, _profile, _phrase, onWords) => {
				onWords?.("alpha beta gamma delta epsilon zeta eta theta");
				return report();
			});

		try {
			await makeProgram({}).parseAsync(["node", "rine", "org", "recover"]);
		} finally {
			restore();
		}

		expect(recoverSpy).toHaveBeenCalledWith(
			"https://test.rine.network",
			{ configDir: "/tmp/test-rine", ownerDir: "/tmp/test-rine-owner" },
			"default",
			PHRASE,
			expect.any(Function),
		);
		const printed = logSpy.mock.calls.map((c) => String(c[0]));
		expect(printed[0]).toBe(
			"Org verification words: alpha beta gamma delta epsilon zeta eta theta",
		);
		expect(printed.join("\n")).toContain("Org 11111111-2222-3333-4444-555555555555");
	});

	it("sets exitCode 1 when an agent mismatches", async () => {
		const restore = mockStdin(PHRASE);
		vi.spyOn(core, "performRecovery").mockResolvedValue(
			report({
				agents: [
					{
						agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						name: "bot",
						branch: "main",
						key_gen: 0,
						status: "mismatch",
						reason: "signing_public_key differs",
					},
				],
			}),
		);

		try {
			await makeProgram({}).parseAsync(["node", "rine", "org", "recover"]);
		} finally {
			restore();
		}

		expect(process.exitCode).toBe(1);
	});

	it("never prints the phrase", async () => {
		const restore = mockStdin(PHRASE);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(core, "performRecovery").mockResolvedValue(report());

		try {
			await makeProgram({}).parseAsync(["node", "rine", "org", "recover"]);
		} finally {
			restore();
		}

		const captured = [...logSpy.mock.calls, ...errorSpy.mock.calls]
			.map((c) => String(c[0]))
			.join("\n");
		expect(captured).not.toContain(PHRASE);
	});

	it("prints the whole report as JSON", async () => {
		const restore = mockStdin(PHRASE);
		const jsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});
		const value = report();
		vi.spyOn(core, "performRecovery").mockResolvedValue(value);

		try {
			await makeProgram({ json: true }).parseAsync([
				"node",
				"rine",
				"org",
				"recover",
			]);
		} finally {
			restore();
		}

		expect(jsonSpy).toHaveBeenCalledWith(value);
	});

	it("names the epochs with no escrow in the reseat table", async () => {
		const restore = mockStdin(PHRASE);
		const tableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});
		const reseat = (groupId: string, gaps: core.DrainGap[]): core.GroupReseat => ({
			agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			group_id: groupId,
			status: core.ReseatStatus.Reseated,
			escrow_pending: false,
			escrow: { gaps, queued: 0, dropped: 0, backlogged: 0 },
		});
		vi.spyOn(core, "performRecovery").mockResolvedValue(
			report({
				closed_groups: [
					reseat("g-lost", [
						{ epoch: 4, reason: core.EscrowLoss.Refused },
						{ epoch: 5, reason: core.EscrowLoss.AgentRevoked },
					]),
					reseat("g-clean", []),
				],
			}),
		);

		try {
			await makeProgram({}).parseAsync(["node", "rine", "org", "recover"]);
		} finally {
			restore();
		}

		const rows = tableSpy.mock.calls[1]?.[0] ?? [];
		expect(rows.map((r) => r["Escrow Gap Epochs"])).toEqual([
			"4 (refused), 5 (agent_revoked)",
			"",
		]);
	});

	it("lists every gap marker on disk in a table of its own", async () => {
		const restore = mockStdin(PHRASE);
		const tableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});
		vi.spyOn(core, "performRecovery").mockResolvedValue(
			report({
				gap_markers: [
					{
						agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						group_id: "g-lost",
						epoch: 4,
						fork: "07070707070707070707070707070707",
						reason: core.EscrowLoss.Refused,
					},
				],
			}),
		);

		try {
			await makeProgram({}).parseAsync(["node", "rine", "org", "recover"]);
		} finally {
			restore();
		}

		expect(tableSpy.mock.calls.at(-1)?.[0]).toEqual([
			{
				"Agent ID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				"Group ID": "g-lost",
				Epoch: 4,
				Fork: "07070707070707070707070707070707",
				Reason: "refused",
			},
		]);
	});

	it("--owner-only restores the owner dir and makes no recovery request", async () => {
		const restore = mockStdin(`${PHRASE}\n`);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recoverSpy = vi.spyOn(core, "performRecovery");
		const ownerSpy = vi
			.spyOn(core, "restoreOwnerFromPhrase")
			.mockReturnValue({ orgId: "11111111-2222-3333-4444-555555555555", orgWords: "alpha beta" });

		try {
			await makeProgram({}).parseAsync(["node", "rine", "org", "recover", "--owner-only"]);
		} finally {
			restore();
		}

		expect(ownerSpy).toHaveBeenCalledWith(
			{ configDir: "/tmp/test-rine", ownerDir: "/tmp/test-rine-owner" },
			"default",
			PHRASE,
		);
		expect(recoverSpy).not.toHaveBeenCalled();
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Org 11111111-2222-3333-4444-555555555555");
		expect(printed).not.toContain(PHRASE);
	});
});
