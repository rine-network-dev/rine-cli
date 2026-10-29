import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOrgBranch } from "../src/commands/org-branch.js";
import * as outputModule from "../src/output.js";
import * as promptModule from "../src/prompt.js";
import { derivedAgentKeys } from "./derived-keys.js";

const ORG_ID = "11111111-2222-3333-4444-555555555555";

let dir: string;
let posts: { path: string; body: unknown }[];
let deletes: { path: string; params?: Record<string, string | number | boolean> }[];

function recipientKeyText(): string {
	const peer = derivedAgentKeys(ORG_ID);
	const raw = new Uint8Array(core.RECIPIENT_KEY_BYTES);
	raw.set(peer.encryption.publicKey, 0);
	raw.set(peer.pqEncryption.publicKey, 32);
	return core.toBase64Url(raw);
}

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerOrgBranch(program.command("org"), program);
	return program;
}

beforeEach(() => {
	dir = fs.mkdtempSync(join(tmpdir(), "rine-cli-branch-"));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(join(dir, "config"));
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue(join(dir, "owner"));
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "loadOrgFromOwner").mockReturnValue(
		core.deriveOrg(new Uint8Array(32).fill(3)),
	);

	posts = [];
	deletes = [];
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		(path: string, body?: unknown) => {
			posts.push({ path, body });
			return Promise.resolve({});
		},
	);
	vi.spyOn(core.HttpClient.prototype, "delete").mockImplementation(
		(
			path: string,
			_headers?: Record<string, string>,
			params?: Record<string, string | number | boolean>,
		) => {
			deletes.push({ path, params });
			return Promise.resolve(undefined);
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("rine org branch create", () => {
	it("posts the exact body fields and writes a 0600 sealed file", async () => {
		const out = join(dir, "bundle.sealed");
		const args = [
			"node",
			"rine",
			"org",
			"branch",
			"create",
			"partner",
			"--to",
			recipientKeyText(),
			"--out",
			out,
			"--words-confirmed",
		];

		await makeProgram({}).parseAsync(args);

		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe("/orgs/me/branches");
		const body = posts[0]?.body as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			[
				"certificate",
				"escrow_pq_public_key",
				"escrow_public_key",
				"name",
				"pq_signing_public_key",
				"reader_public_key",
				"signing_public_key",
			].sort(),
		);
		expect(body.name).toBe("partner");
		expect(typeof body.certificate).toBe("string");

		const mode = fs.statSync(out).mode & 0o777;
		expect(mode).toBe(0o600);
		expect(fs.readFileSync(out, "utf-8").trim().length).toBeGreaterThan(0);
	});

	it("creates nothing and sets exitCode 2 without --words-confirmed and no TTY", async () => {
		const out = join(dir, "bundle.sealed");
		const stdin = process.stdin;
		Object.defineProperty(process, "stdin", {
			value: { isTTY: false },
			configurable: true,
		});
		const printErrorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		const promptSpy = vi.spyOn(promptModule, "promptConfirm");

		try {
			await makeProgram({}).parseAsync([
				"node",
				"rine",
				"org",
				"branch",
				"create",
				"partner",
				"--to",
				recipientKeyText(),
				"--out",
				out,
			]);
		} finally {
			Object.defineProperty(process, "stdin", {
				value: stdin,
				configurable: true,
			});
		}

		expect(promptSpy).not.toHaveBeenCalled();
		expect(posts).toHaveLength(0);
		expect(fs.existsSync(out)).toBe(false);
		expect(process.exitCode).toBe(2);
		expect(printErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("--words-confirmed"),
		);
	});

	it("aborts with exitCode 1 and creates nothing when the words do not match", async () => {
		const out = join(dir, "bundle.sealed");
		const stdin = process.stdin;
		Object.defineProperty(process, "stdin", {
			value: { isTTY: true },
			configurable: true,
		});
		vi.spyOn(promptModule, "promptConfirm").mockResolvedValue(false);
		const printErrorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});

		try {
			await makeProgram({}).parseAsync([
				"node",
				"rine",
				"org",
				"branch",
				"create",
				"partner",
				"--to",
				recipientKeyText(),
				"--out",
				out,
			]);
		} finally {
			Object.defineProperty(process, "stdin", {
				value: stdin,
				configurable: true,
			});
		}

		expect(posts).toHaveLength(0);
		expect(fs.existsSync(out)).toBe(false);
		expect(process.exitCode).toBe(1);
		expect(printErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("words did not match"),
		);
	});

	it("removes the bundle file when the POST fails", async () => {
		const out = join(dir, "bundle.sealed");
		vi.spyOn(core.HttpClient.prototype, "post").mockRejectedValue(
			new Error("boom"),
		);

		await makeProgram({}).parseAsync([
			"node",
			"rine",
			"org",
			"branch",
			"create",
			"partner",
			"--to",
			recipientKeyText(),
			"--out",
			out,
			"--words-confirmed",
		]);

		expect(fs.existsSync(out)).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

describe("rine org branch revoke", () => {
	it("issues DELETE and prints the three facts", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await makeProgram({}).parseAsync([
			"node",
			"rine",
			"org",
			"branch",
			"revoke",
			"partner",
		]);

		expect(deletes).toEqual([
			{ path: "/orgs/me/branches/partner", params: { confirm: false } },
		]);
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Branch 'partner' revoked.");
		expect(printed).toContain(
			"Its agents can no longer authenticate or be sealed to.",
		);
		expect(printed).toContain(
			"Closed-group seats are not removed: a group admin must Remove its agents.",
		);
		expect(printed).toContain(
			"Revocation never revokes read: the branch holder still reads what it already saw.",
		);
	});
});

describe("rine org branch revoke --confirm", () => {
	it("sends the confirm field for main", async () => {
		await makeProgram({}).parseAsync([
			"node",
			"rine",
			"org",
			"branch",
			"revoke",
			"main",
			"--confirm",
		]);

		expect(deletes).toEqual([
			{ path: "/orgs/me/branches/main", params: { confirm: true } },
		]);
	});
});

describe("rine org branch revoke name check", () => {
	it("refuses a name that would escape the branch path, sending nothing", async () => {
		await makeProgram({}).parseAsync([
			"node",
			"rine",
			"org",
			"branch",
			"revoke",
			"../../agents/x",
		]);

		expect(deletes).toEqual([]);
		expect(process.exitCode).toBe(1);
	});
});
