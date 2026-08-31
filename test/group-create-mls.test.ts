/**
 * `rine group create` — what it tells an operator the new group is encrypted
 * with, on the path where the row it holds cannot say.
 *
 * 🔴 `groups.create` mints the group BEFORE its MLS init runs, so the row this
 * command renders is the pre-init one whenever the confirming re-read is
 * refused — no latch, no pending flag, no suite, which is field for field a
 * group whose ratchet tree was never founded. The row-only answer read it as
 * exactly that and printed *"its ratchet tree was never founded… Run `rine
 * group resume-admission` on it"* about a tree this command had founded seconds
 * earlier, with `--json` carrying `mls_never_founded: true` to match. The
 * founding's admission is the only thing that says otherwise, and it was in
 * scope and unread.
 *
 * The same defect was fixed on `rine-mastra`, `rine-eve` and the three Python
 * connectors; this is the one create renderer that was left.
 *
 * Driven through the real command with commander, because what is under test is
 * what the operator sees — the table cells, the line under them and `--json` —
 * and not a helper's return value.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";
import * as outputModule from "../src/output.js";

const CONFIG_DIR = "/tmp/test-rine-group-create-mls";
const API_URL = "https://test.rine.network";
const GROUP_ID = "88888888-8888-8888-8888-888888888888";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";

/** The row `POST /groups` answers with — minted before any MLS init has run. */
function preInitRow(overrides: Record<string, unknown> = {}) {
	return {
		id: GROUP_ID,
		name: "ops",
		handle: "#ops@acme.rine.network",
		description: null,
		enrollment_policy: "closed",
		visibility: "private",
		isolated: false,
		vote_duration_hours: 24,
		member_count: 1,
		conversation_id: null,
		member_agent_ids: [AGENT_ID],
		created_at: "2026-08-21T00:00:00Z",
		mls_enabled: true,
		mls_group_id: null,
		mls_pending: false,
		mls_cipher_suite: null,
		...overrides,
	};
}

/** What a founding that LANDED returns: one commit, the creator's own leaf. */
const ADMISSION = {
	epoch: 1,
	commits: 1,
	added: 1,
	outcomes: [{ agentId: AGENT_ID, status: "added" as const }],
};

let printed: string[];
let errors: string[];
let tables: Record<string, unknown>[][];
let jsons: unknown[];

/** The first row of the most recently rendered table. Fails loudly, with a
 * useful message, if a rendering path stopped producing a table — the
 * narrowing `noUncheckedIndexedAccess` asks every reader for. */
function firstRow(rows: Record<string, unknown>[][]): Record<string, unknown> {
	const table = rows[0];
	expect(table).toBeDefined();
	const row = table?.[0];
	expect(row).toBeDefined();
	if (!row) throw new Error("expected a rendered table row");
	return row;
}

beforeEach(() => {
	printed = [];
	errors = [];
	tables = [];
	jsons = [];
	process.env.RINE_AGENT = AGENT_ID;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(outputModule, "printText").mockImplementation((s) => {
		printed.push(s);
	});
	vi.spyOn(outputModule, "printError").mockImplementation((s) => {
		errors.push(s);
	});
	vi.spyOn(outputModule, "printTable").mockImplementation((rows) => {
		tables.push(rows);
	});
	vi.spyOn(outputModule, "printJson").mockImplementation((v) => {
		jsons.push(v);
	});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(preInitRow());
	// The confirming re-read is refused. `refresh` swallows that deliberately —
	// the group exists and the create succeeded — and returns the pre-init row.
	vi.spyOn(core.HttpClient.prototype, "get").mockRejectedValue(
		new Error("503 Service Unavailable"),
	);
	vi.spyOn(core, "initMlsGroup").mockResolvedValue(ADMISSION);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.env.RINE_AGENT = undefined;
	process.exitCode = undefined;
});

function run(args: string[], gOpts: Record<string, unknown> = {}) {
	const program = new Command();
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue(gOpts);
	registerGroup(program);
	return program.parseAsync(["node", "rine", "group", ...args]);
}

const CREATE = ["create", "--name", "ops", "--visibility", "private"];

describe("rine group create — the founding landed and the re-read was refused", () => {
	it("test_create_when_the_founding_landed_and_the_re_read_failed_then_it_reports_mls", async () => {
		await run(CREATE);

		const said = printed.join("\n");
		expect(said).toContain(
			"Encryption: MLS (RFC 9420) on rine's post-quantum X-Wing ciphersuite.",
		);
		expect(process.exitCode).toBeUndefined();
	});

	it("test_create_when_the_founding_landed_and_the_re_read_failed_then_it_names_no_repair", async () => {
		// The sentence the operator actually read, and the reason it mattered:
		// they were sent to found a ratchet tree that already existed.
		await run(CREATE);

		const said = printed.join("\n");
		expect(said).not.toContain("never founded");
		expect(said).not.toContain("resume-admission");
		expect(said).not.toContain("Sender Keys");
	});

	it("test_create_when_the_founding_landed_and_the_re_read_failed_then_the_table_agrees", async () => {
		// The cells and the line under them are one answer, not two: a table
		// reading `sender-key-v1` above a line reading MLS is the shape of
		// contradiction this whole round exists to remove.
		await run(CREATE);

		const row = firstRow(tables);
		expect(row.Encryption).toBe("mls-v1");
		expect(row["Post-Quantum"]).toBe(true);
	});

	it("test_create_when_the_founding_landed_and_the_re_read_failed_then_json_agrees", async () => {
		// 🔴 The machine-readable half of the same falsehood: a script keying off
		// `mls_never_founded` would have run a repair against a founded group.
		await run(CREATE, { json: true });

		const body = jsons[0] as {
			encryption: Record<string, unknown>;
			admission?: unknown;
		};
		expect(body.encryption).toMatchObject({
			regime: "mls",
			version: "mls-v1",
			post_quantum: true,
			pending: false,
			mls_never_founded: false,
		});
		// The admission stays its own key. The group object is the wire row.
		expect(body.admission).toBeDefined();
		expect(body).not.toHaveProperty("mlsAdmission");
	});
});

describe("rine group create — the answers this must not have changed", () => {
	it("test_create_when_the_re_read_succeeds_then_it_still_reports_mls", async () => {
		// The ordinary path, where the row carries the latch and the admission
		// changes nothing. It must give the same answer as the refused re-read:
		// the operator's terminal cannot depend on whether one GET succeeded.
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue(
			preInitRow({ mls_group_id: "mls-latch-abc" }),
		);

		await run(CREATE);

		expect(printed.join("\n")).toContain(
			"Encryption: MLS (RFC 9420) on rine's post-quantum X-Wing ciphersuite.",
		);
		expect(firstRow(tables).Encryption).toBe("mls-v1");
	});

	it("test_create_when_the_group_is_open_then_it_still_reports_sender_keys", async () => {
		// 🔴 The regression this most plausibly causes. An open group is exempt
		// from the init — the server refuses MLS there — so no admission exists
		// and the group really does run sender keys. An arm that leaked would
		// have told every open group it was post-quantum MLS.
		vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(
			preInitRow({ enrollment_policy: "open" }),
		);

		await run(["create", "--name", "ops", "--visibility", "public"]);

		const said = printed.join("\n");
		expect(said).toContain("Encryption: Sender Keys — NOT post-quantum.");
		expect(said).not.toContain("MLS (RFC 9420)");
		expect(core.initMlsGroup).not.toHaveBeenCalled();
		expect(firstRow(tables).Encryption).toBe("sender-key-v1");
	});

	it("test_create_when_the_founding_failed_then_it_claims_no_mls", async () => {
		// The other state the create path can be in, and the one this arm must
		// NOT answer for: an init this client watched FAIL. `foundMlsState` warns
		// and returns no admission, so nothing here claims a tree exists.
		//
		// What it prints instead is the never-founded sentence, unchanged by this
		// fix and deliberately so: the honest answer names a fork — the server may
		// refuse every non-MLS send into the group for the next 15 minutes —
		// and `GroupEncryption`'s two-valued `regime` cannot carry it. That is
		// `createdGroupMls`'s second arm, which no CLI renderer reads.
		vi.spyOn(core, "initMlsGroup").mockRejectedValue(new Error("socket hang up"));

		await run(CREATE);

		const said = printed.join("\n");
		expect(said).not.toContain("MLS (RFC 9420)");
		expect(said).toContain("never founded");
		expect(firstRow(tables).Encryption).toBe("sender-key-v1");
	});
});
