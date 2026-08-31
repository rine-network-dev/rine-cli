// The `rine hook` CRUD command group (client-side HMAC secret).
//
// FROZEN-CONTRACT invariants asserted here (a violation is a build defect):
//  - The HMAC secret is generated CLIENT-SIDE (randomBytes(32) hex, 64 chars)
//    and is NEVER sent to rine — the create POST body carries ONLY {hook_name}.
//    (We spy the HttpClient.post body and assert no secret key is ever present.)
//  - The secret is persisted to {configDir}/funnel/{agentId}/{name}.secret with
//    mode 0600 (dir 0700) BEFORE anything is printed, and deleted if the POST
//    fails (no orphan secret for an unallocated hook).
//  - The secret is printed EXACTLY ONCE on create and NEVER appears in `list`.
//  - HOOK_DNS_API_TOKEN never appears in this surface (server-side only).
//
// These tests drive the REAL `rine hook` commands via Commander.parseAsync and
// mock the externals: the @rine-network/core module boundary (config/agent
// resolution/token) and node:fs (a per-test temp dir). They MUST fail now — the
// command module `../src/commands/hook.js` does not exist yet (Track E builds
// it) — and fail for the right reason: a missing module / missing export.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Module under test — does NOT exist yet (Track E creates it).
import { registerHook } from "../src/commands/hook.js";

const API_URL = "https://test.rine.network";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const HOSTNAME = "github--bot.hook.rine.network";

let CONFIG_DIR: string;

function hookCreated(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	// Mirrors the backend HookCreated response (funnel_schemas.py): NO secret,
	// NO delegation_id. The relay uses the server-returned `hostname` verbatim.
	return {
		hook_name: "github",
		hostname: HOSTNAME,
		termination: "zero_trust",
		active: true,
		created_at: "2026-06-13T00:00:00Z",
		agent_id: AGENT_ID,
		control_ws_url: "wss://funnel.rine.network/_funnel/v1",
		...overrides,
	};
}

beforeEach(() => {
	CONFIG_DIR = fs.mkdtempSync(join(tmpdir(), "rine-hook-test-"));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, name: "bot" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	program.option("--as <handle>", "Act as agent");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerHook(program);
	return program;
}

function secretPath(name: string): string {
	return join(CONFIG_DIR, "funnel", AGENT_ID, `${name}.secret`);
}

function captureStdout(): { lines: string[] } {
	const lines: string[] = [];
	(console.log as ReturnType<typeof vi.fn>).mockImplementation(
		(...args: unknown[]) => lines.push(args.map(String).join(" ")),
	);
	return { lines };
}

// ── command group shape ─────────────────────────────────────────────────────

describe("rine hook — command group", () => {
	it("registers exactly create, list and delete subcommands", () => {
		const program = makeProgram();
		const hook = program.commands.find((c) => c.name() === "hook");
		expect(hook).toBeDefined();
		const names = hook?.commands.map((c) => c.name()).sort();
		expect(names).toEqual(["create", "delete", "list"]);
	});

	it("the group is described as managing inbound webhook funnel hooks", () => {
		const program = makeProgram();
		const hook = program.commands.find((c) => c.name() === "hook");
		expect(hook?.description().toLowerCase()).toContain("funnel");
	});
});

// ── client-side secret, body-has-no-secret ──────────────────────────────────

describe("rine hook create — client-side secret never sent to rine", () => {
	it("POST body is exactly {hook_name} — no secret key is ever present", async () => {
		let postBody: Record<string, unknown> | undefined;
		const post = vi
			.spyOn(core.HttpClient.prototype, "post")
			.mockImplementation((_path: string, body?: unknown) => {
				postBody = body as Record<string, unknown>;
				return Promise.resolve(hookCreated());
			});

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		expect(post).toHaveBeenCalledTimes(1);
		// The body carries the name + the termination tier (null = "backend default",
		// resolved by _default_tier_for_trust — the CLI never recomputes it),
		// and NOTHING that looks like a secret.
		expect(postBody).toBeDefined();
		expect(postBody).toEqual({ hook_name: "github", tier: null });
		expect(Object.keys(postBody as object)).not.toContain("secret");
		// Belt-and-suspenders: no value in the body equals the generated secret.
		expect(JSON.stringify(postBody)).not.toMatch(/[0-9a-f]{64}/);
	});

	it("generates a 64-hex-char secret and persists it (not server-supplied)", async () => {
		vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(
			hookCreated(),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		const stored = fs.readFileSync(secretPath("github"), "utf-8").trim();
		expect(stored).toMatch(/^[0-9a-f]{64}$/);
	});

	it("defaults --name to 'default' when omitted", async () => {
		let postBody: Record<string, unknown> | undefined;
		vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
			(_path: string, body?: unknown) => {
				postBody = body as Record<string, unknown>;
				return Promise.resolve(hookCreated({ hook_name: "default" }));
			},
		);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
		]);

		expect(postBody).toEqual({ hook_name: "default", tier: null });
		expect(fs.existsSync(secretPath("default"))).toBe(true);
	});

	it("rejects an invalid name with exit code 2 and writes no secret / makes no POST", async () => {
		const post = vi
			.spyOn(core.HttpClient.prototype, "post")
			.mockResolvedValue(hookCreated());

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"Bad_Name!",
		]);

		expect(process.exitCode).toBe(2);
		expect(post).not.toHaveBeenCalled();
		expect(fs.existsSync(secretPath("Bad_Name!"))).toBe(false);
	});
});

describe("rine hook create — local secret persistence", () => {
	it("writes {configDir}/funnel/{agentId}/{name}.secret with mode 0600 in a 0700 dir", async () => {
		vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(
			hookCreated(),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		const p = secretPath("github");
		expect(fs.existsSync(p)).toBe(true);
		// POSIX perms: file 0600, parent dir 0700 (sibling of keys/{agentId}).
		expect(fs.statSync(p).mode & 0o777).toBe(0o600);
		expect(fs.statSync(join(CONFIG_DIR, "funnel", AGENT_ID)).mode & 0o777).toBe(
			0o700,
		);
	});

	it("persists the secret BEFORE printing the create output", async () => {
		// If the secret file does not exist at the moment of the first console.log,
		// the ordering invariant (persist-then-print) is violated.
		let existedAtFirstPrint: boolean | undefined;
		(console.log as ReturnType<typeof vi.fn>).mockImplementation(() => {
			if (existedAtFirstPrint === undefined) {
				existedAtFirstPrint = fs.existsSync(secretPath("github"));
			}
		});
		vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(
			hookCreated(),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		expect(existedAtFirstPrint).toBe(true);
	});

	it("deletes the just-written secret if the allocation POST fails (no orphan)", async () => {
		vi.spyOn(core.HttpClient.prototype, "post").mockRejectedValue(
			new core.RineApiError(500, "boom"),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		expect(fs.existsSync(secretPath("github"))).toBe(false);
		expect(process.exitCode).not.toBe(0);
	});
});

// ── print-once GitHub block + JSON shape ────────────────────────────────────

describe("rine hook create — print-once setup", () => {
	it("--json emits the secret, the server hostname verbatim, the public URL and signature header", async () => {
		const out = captureStdout();
		vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(
			hookCreated(),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		const obj = out.lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((o) => o && typeof o === "object" && "secret" in o);
		expect(obj).toBeTruthy();
		expect(obj.secret).toMatch(/^[0-9a-f]{64}$/);
		// Payload URL is the bare host root — the hook is SNI-routed by hostname and the
		// relay ignores the request path, so there is no redundant /{hook_name} segment.
		expect(obj.public_url).toBe(`https://${HOSTNAME}/`);
		expect(obj.signature_header).toBe("X-Hub-Signature-256");
		expect(obj.content_type).toBe("application/json");
		expect(obj.hook?.hostname ?? obj.hostname).toBe(HOSTNAME);
	});

	it("table mode prints the once-only warning and the persisted secret", async () => {
		const out = captureStdout();
		vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(
			hookCreated(),
		);

		const program = makeProgram({}); // table mode (no --json)
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		const all = out.lines.join("\n");
		const stored = fs.readFileSync(secretPath("github"), "utf-8").trim();
		expect(all).toContain(stored);
		expect(all.toLowerCase()).toMatch(
			/not stored on rine|shown (only )?once|cannot be retrieved/,
		);
		expect(all).toContain("X-Hub-Signature-256");
	});

	it("prints the secret exactly once across all output", async () => {
		const out = captureStdout();
		vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(
			hookCreated(),
		);

		const program = makeProgram({});
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		const stored = fs.readFileSync(secretPath("github"), "utf-8").trim();
		const occurrences = out.lines.join("\n").split(stored).length - 1;
		expect(occurrences).toBe(1);
	});
});

// ── edge cases: 409 / 403 ───────────────────────────────────────────────────

describe("rine hook create — server rejections (edge cases)", () => {
	it("on 409 (name exists) exits non-zero and writes no local secret", async () => {
		vi.spyOn(core.HttpClient.prototype, "post").mockRejectedValue(
			new core.RineApiError(409, "Funnel hook already exists"),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		expect(process.exitCode).not.toBe(0);
		expect(fs.existsSync(secretPath("github"))).toBe(false);
	});

	it("on 403 (tier floor / quota) surfaces the server message and writes no secret", async () => {
		const out = captureStdout();
		(console.error as ReturnType<typeof vi.fn>).mockImplementation(
			(...args: unknown[]) => out.lines.push(args.map(String).join(" ")),
		);
		vi.spyOn(core.HttpClient.prototype, "post").mockRejectedValue(
			new core.RineApiError(
				403,
				"Funnel quota exceeded: Tier 2 orgs may have at most 2 funnels per agent.",
			),
		);

		const program = makeProgram({});
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"create",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		expect(out.lines.join("\n")).toContain("quota exceeded");
		expect(fs.existsSync(secretPath("github"))).toBe(false);
	});
});

// ── list / delete ───────────────────────────────────────────────────────────

describe("rine hook list", () => {
	it("calls GET /agents/{agentId}/funnel/hooks and never emits a secret", async () => {
		const out = captureStdout();
		// Pre-seed a local secret to prove `list` never reads or prints it.
		fs.mkdirSync(join(CONFIG_DIR, "funnel", AGENT_ID), {
			recursive: true,
			mode: 0o700,
		});
		const sentinel = "a".repeat(64);
		fs.writeFileSync(secretPath("github"), sentinel, { mode: 0o600 });

		const get = vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue({
			items: [
				{
					hook_name: "github",
					hostname: HOSTNAME,
					termination: "zero_trust",
					active: true,
					created_at: "2026-06-13T00:00:00Z",
				},
			],
			total: 1,
		});

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"list",
			"--agent",
			AGENT_ID,
		]);

		expect(get).toHaveBeenCalledWith(
			`/agents/${AGENT_ID}/funnel/hooks`,
			expect.anything(),
		);
		const all = out.lines.join("\n");
		expect(all).not.toContain(sentinel);
		expect(all.toLowerCase()).not.toContain("secret");
	});
});

describe("rine hook delete", () => {
	beforeEach(() => {
		fs.mkdirSync(join(CONFIG_DIR, "funnel", AGENT_ID), {
			recursive: true,
			mode: 0o700,
		});
		fs.writeFileSync(secretPath("github"), "b".repeat(64), { mode: 0o600 });
	});

	it("calls DELETE .../funnel/hooks/{name} and purges the local secret with --yes", async () => {
		const del = vi
			.spyOn(core.HttpClient.prototype, "delete")
			.mockResolvedValue(undefined);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"delete",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
			"--yes",
		]);

		expect(del).toHaveBeenCalledWith(`/agents/${AGENT_ID}/funnel/hooks/github`);
		expect(fs.existsSync(secretPath("github"))).toBe(false);
	});

	it("without --yes and without --json prompts and aborts (no server call) when declined", async () => {
		const prompt = await import("../src/prompt.js");
		vi.spyOn(prompt, "promptConfirm").mockResolvedValue(false);
		const del = vi
			.spyOn(core.HttpClient.prototype, "delete")
			.mockResolvedValue(undefined);

		const program = makeProgram({});
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"delete",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		expect(del).not.toHaveBeenCalled();
		// Declining leaves the local secret untouched (no server-side delete happened).
		expect(fs.existsSync(secretPath("github"))).toBe(true);
	});

	it("treats a 404 as success-idempotent under --yes (purges the local secret, no error)", async () => {
		vi.spyOn(core.HttpClient.prototype, "delete").mockRejectedValue(
			new core.RineApiError(404, "Funnel hook not found"),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"delete",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
			"--yes",
		]);

		// Idempotent: clean exit + the stale local secret is purged.
		expect(process.exitCode).not.toBe(1);
		expect(fs.existsSync(secretPath("github"))).toBe(false);
	});

	it("surfaces a 404 (does NOT swallow it) without --yes, leaving the local secret", async () => {
		vi.spyOn(core.HttpClient.prototype, "delete").mockRejectedValue(
			new core.RineApiError(404, "Funnel hook not found"),
		);
		const prompt = await import("../src/prompt.js");
		vi.spyOn(prompt, "promptConfirm").mockResolvedValue(true);

		const program = makeProgram({});
		await program.parseAsync([
			"node",
			"rine",
			"hook",
			"delete",
			"--agent",
			AGENT_ID,
			"--name",
			"github",
		]);

		// The 404 propagates through withClient's error path (non-zero exit); the
		// local secret is NOT purged on an un-acknowledged failure.
		expect(process.exitCode).toBe(1);
		expect(fs.existsSync(secretPath("github"))).toBe(true);
	});
});
