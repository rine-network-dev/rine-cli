import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";

// Phase 6 — open-enrollment self-join via external commit.
//
// When a joiner gains immediate membership in an MLS-active group but no Welcome
// was minted (the `open` enrollment case — no admin in the loop), the join path
// must fall back to the external-commit self-join orchestrator so the joiner
// becomes a real MLS member. These tests drive the REAL `group join` command and
// assert the observable wiring: core.externalJoinMlsGroup is invoked iff the
// group is MLS-active AND no local MLS state already exists.
//
// The core orchestrator (externalJoinMlsGroup) and state loader (loadMlsState)
// are mocked at the @rine-network/core module boundary — this CLI test owns only
// the surface wiring, not the cryptographic external-commit round-trip (that is
// covered by rine-core/test/mls-external-join.test.ts).

const CONFIG_DIR = "/tmp/test-rine";
const API_URL = "https://test.rine.network";
const GROUP_ID = "group-open-1";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";

const MEMBER_RESPONSE = {
	agent_id: AGENT_ID,
	agent_handle: "bot@org.rine.network",
	role: "member",
	joined_at: "2026-06-03T00:00:00Z",
};

function mlsGroup(overrides: Partial<core.GroupRead> = {}): core.GroupRead {
	return {
		id: GROUP_ID,
		name: "open-group",
		handle: "open-group.rine.network",
		enrollment_policy: "open",
		visibility: "public",
		member_count: 2,
		created_at: "2026-06-01T00:00:00Z",
		mls_enabled: true,
		mls_group_id: "mls-internal-abc",
		mls_pending: false,
		...overrides,
	} as unknown as core.GroupRead;
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");

	// processMlsWelcomes is the Phase 5 step; default to a no-op (no Welcome
	// arrived) so the external-join fallback is the path under test.
	vi.spyOn(core, "processMlsWelcomes").mockResolvedValue(undefined as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerGroup(program);
	return program;
}

function stubJoin(group: core.GroupRead | null): void {
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		(path: string) => {
			if (path === `/groups/${GROUP_ID}/join`) {
				return Promise.resolve(MEMBER_RESPONSE);
			}
			return Promise.reject(new Error(`Unknown POST: ${path}`));
		},
	);
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			if (path === `/groups/${GROUP_ID}`) {
				if (group === null) return Promise.reject(new Error("not found"));
				return Promise.resolve(group);
			}
			return Promise.reject(new Error(`Unknown GET: ${path}`));
		},
	);
}

describe("group join — open-enrollment external-commit self-join (Phase 6)", () => {
	it("self-joins via external commit when MLS-active and no local state exists", async () => {
		stubJoin(mlsGroup());
		vi.spyOn(core, "loadMlsState").mockReturnValue(null);
		const extJoin = vi
			.spyOn(core, "externalJoinMlsGroup")
			.mockResolvedValue({ epoch: 2 });

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "join", GROUP_ID]);

		expect(extJoin).toHaveBeenCalledTimes(1);
		expect(extJoin).toHaveBeenCalledWith(
			CONFIG_DIR,
			AGENT_ID,
			GROUP_ID,
			expect.any(core.HttpClient),
			{ "X-Rine-Agent": AGENT_ID },
		);
	});

	it("does NOT self-join when a Welcome already installed local MLS state", async () => {
		stubJoin(mlsGroup());
		vi.spyOn(core, "loadMlsState").mockReturnValue({
			stateBlob: new Uint8Array([1, 2, 3]),
			metadata: { groupId: GROUP_ID, epoch: 1, cipherSuite: 0x0001 },
		});
		const extJoin = vi
			.spyOn(core, "externalJoinMlsGroup")
			.mockResolvedValue({ epoch: 2 });

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "join", GROUP_ID]);

		expect(extJoin).not.toHaveBeenCalled();
	});

	it("does NOT self-join for a non-MLS (sender-key) group", async () => {
		stubJoin(mlsGroup({ mls_group_id: null, mls_enabled: false }));
		const loadState = vi.spyOn(core, "loadMlsState").mockReturnValue(null);
		const extJoin = vi
			.spyOn(core, "externalJoinMlsGroup")
			.mockResolvedValue({ epoch: 2 });

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "join", GROUP_ID]);

		expect(extJoin).not.toHaveBeenCalled();
		// Bails on the mls_group_id latch before ever inspecting local state.
		expect(loadState).not.toHaveBeenCalled();
	});

	it("self-join failure is non-fatal — the join itself still succeeds", async () => {
		stubJoin(mlsGroup());
		vi.spyOn(core, "loadMlsState").mockReturnValue(null);
		vi.spyOn(core, "externalJoinMlsGroup").mockRejectedValue(
			new Error("no published GroupInfo"),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "join", GROUP_ID]);

		// Best-effort: a failed self-join must not surface as a command error.
		expect(process.exitCode).toBeUndefined();
	});
});
