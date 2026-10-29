import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ActivityQuery,
	type OrgPage,
	type OrgSummary,
	type ReadFinding,
	ReadGapReason,
	type ReadKey,
	type ReadMessage,
	ReaderNetworkError,
	RineApiError,
	TokenBucket,
} from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTui } from "../src/commands/tui.js";
import { FeedErrorCode, FeedExit, TuiExit } from "../src/tui/feed-schema.js";
import { HEARTBEAT_MS, PARENT_CHECK_MS } from "../src/tui/feed-lifecycle.js";
import { type FeedOptions, runFeed } from "../src/tui/feed.js";
import { IdentityKind, type IdentityResult } from "../src/tui/identity.js";
import {
	BILLING,
	PARTNER,
	SALES,
	SECRET,
	messageOf,
	textBody,
} from "./tui-fixture.js";

const CONTRACT = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"feed-contract.ndjson",
);
/** Regenerate with this set, then run scripts/gen-feed-contract.mjs so the plugin's copy follows. */
const REGEN = process.env.RINE_FEED_CONTRACT_REGEN === "1";

const NOW = Date.UTC(2026, 9, 24, 14, 0, 0);
const ORG: OrgSummary = { name: "Acme GmbH", slug: "acme" };
const isControl = (char: string): boolean =>
	(char.codePointAt(0) ?? 32) < 32 && char !== "\n" && char !== "\t";

const message = (
	id: string,
	over: Partial<ReadMessage> = {},
	row: Partial<ReadMessage["row"]> = {},
): ReadMessage =>
	messageOf(
		id,
		{ text: textBody(SECRET), ...over },
		{ createdAtMicros: NOW * 1000, conversationId: "c-1", ...row },
	);

const page = (
	items: ReadMessage[],
	nextCursor: string | null = null,
	findings: ReadFinding[] = [],
): OrgPage => ({
	items,
	nextCursor,
	dropped: 0,
	findings,
});

class FakeProc extends EventEmitter {
	ppid = 100;
}

function setup(
	results: (OrgPage | Error)[],
	org: OrgSummary | Error = ORG,
) {
	const queries: ActivityQuery[] = [];
	const lines: { event: string; data: Record<string, unknown> }[] = [];
	const stderr: string[] = [];
	const queue = [...results];
	const closed = vi.fn(async () => undefined);
	const reader = {
		async read(query: ActivityQuery): Promise<OrgPage> {
			queries.push(query);
			const next = queue.shift();
			if (next instanceof Error) throw next;
			return next ?? page([]);
		},
		async org(): Promise<OrgSummary> {
			if (org instanceof Error) throw org;
			return org;
		},
		close: closed,
	};
	const identity = {
		kind: IdentityKind.Reader,
		key: { orgId: "org-1" } as ReadKey,
		reader,
		bucket: new TokenBucket(),
	} as IdentityResult;
	const proc = new FakeProc();
	const options: FeedOptions = {
		agent: null,
		group: null,
		pollS: 5,
		once: false,
		before: null,
		host: "api.rine.network",
	};
	const run = (
		over: Partial<FeedOptions> = {},
		who: IdentityResult = identity,
	) =>
		runFeed(
			{ ...options, ...over },
			{
				identity: who,
				write: (line) => lines.push(JSON.parse(line)),
				writeError: (text) => stderr.push(text),
				proc: proc as never,
				now: () => NOW,
			},
		);
	return {
		run,
		lines,
		stderr,
		queries,
		proc,
		closed,
		events: () => lines.map((l) => l.event),
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("rine tui --feed", () => {
	it("says hello first, then the page and its rows, every event versioned", async () => {
		const t = setup([page([message("m1"), message("m2")], "older-1")]);
		const code = await t.run({ once: true });
		expect(code).toBe(FeedExit.Clean);
		expect(t.events()).toEqual(["hello", "page", "row", "row"]);
		expect(t.lines.every((l) => l.data.v === 1)).toBe(true);
		expect(t.lines[0]?.data).toEqual({
			v: 1,
			principal: "org",
			org_id: "org-1",
			org: ORG,
			poll_s: 5,
		});
		expect(t.lines[1]?.data).toMatchObject({
			kind: "initial",
			count: 2,
			older_cursor: "older-1",
		});
		expect(
			t.lines.filter((l) => l.event === "row").map((l) => l.data.seq),
		).toEqual([1, 2]);
		expect(t.closed).toHaveBeenCalledOnce();
	});

	it("carries the text only as scrubbed display fields, never as message.text", async () => {
		const t = setup([page([message("m1")])]);
		await t.run({ once: true });
		const row = t.lines.find((l) => l.event === "row")?.data as {
			message: Record<string, unknown>;
			display: Record<string, unknown>;
			hidden_chars: number;
			text_truncated: number;
		};
		expect("text" in row.message).toBe(false);
		expect(row.display).toMatchObject({
			glyph: "verified",
			body: SECRET,
			snippet: SECRET,
			from_short: SALES.agentId.slice(0, 8),
			to_short: BILLING.agentId.slice(0, 8),
		});
		expect(row.hidden_chars).toBe(0);
		expect(row.text_truncated).toBe(0);
		expect(JSON.stringify(row.message)).not.toContain(SECRET);
	});

	it("names the org in hello with a scrubbed name, and null when whoami fails or answers no usable slug", async () => {
		const hello = async (org: OrgSummary | Error) => {
			const t = setup([page([])], org);
			await t.run({ once: true });
			return t.lines[0]?.data.org;
		};
		expect(await hello({ name: "Ac\u001b[31mme\u0007 GmbH", slug: "acme" })).toEqual(
			{ name: "Acme GmbH", slug: "acme" },
		);
		expect(await hello(new ReaderNetworkError("down"))).toBeNull();
		expect(await hello({ name: "Acme", slug: "Not A Slug" })).toBeNull();
		expect(await hello({ name: "\u001b[31m", slug: "acme" })).toBeNull();
	});

	it("labels the parties in the short form against the org's own slug", async () => {
		const handle = (name: string, org: string) => `${name}@${org}.rine.network`;
		const row = {
			sender: { ...SALES, handle: handle("sales", "acme") },
			recipient: { ...PARTNER, handle: handle("buyer", "fjord21735") },
		};
		const t = setup([
			page([
				message("m1", {}, row),
				message("m2", {}, {
					sender: row.sender,
					recipient: null,
					groupId: "g-1",
					groupHandle: handle("#ops", "acme"),
				}),
				message("m3", {}, { ...row, sender: { ...row.recipient } }),
			]),
		]);
		await t.run({ once: true });
		const labels = t.lines
			.filter((l) => l.event === "row")
			.map((l) => l.data.display as Record<string, unknown>)
			.map(({ from_label, to_label, group_label }) => [
				from_label,
				to_label,
				group_label,
			]);
		expect(labels).toEqual([
			["sales", "buyer@fjord21735", null],
			["sales", null, "#ops"],
			["buyer@fjord21735", "buyer@fjord21735", null],
		]);
	});

	it("shows full short forms when whoami fails, since no handle is the org's own", async () => {
		const t = setup([page([message("m1", {}, { sender: { ...SALES, handle: "sales@acme.rine.network" } })])], new Error("down"));
		await t.run({ once: true });
		const display = t.lines.find((l) => l.event === "row")?.data
			.display as Record<string, unknown>;
		expect(display.from_label).toBe("sales@acme");
	});

	it("removes terminal controls that a JSON escape decodes to", async () => {
		const text = JSON.stringify({ text: "a\u001b[31mred\u0007" });
		const t = setup([page([message("m1", { text })])]);
		await t.run({ once: true });
		const body = (
			t.lines.find((l) => l.event === "row")?.data.display as { body: string }
		).body;
		expect([...body].some(isControl)).toBe(false);
		expect(body).toContain("red");
	});

	it("shows a gap row with its sentence and no body", async () => {
		const gap = { reason: ReadGapReason.NoEscrow };
		const t = setup([page([message("m1", { text: null, gap })])]);
		await t.run({ once: true });
		const display = t.lines.find((l) => l.event === "row")?.data
			.display as Record<string, unknown>;
		expect(display.glyph).toBe("gap");
		expect(display.body).toBeNull();
		expect(typeof display.gap_sentence).toBe("string");
	});

	it("tells a finding once, named for the group it was found in", async () => {
		const gap = { reason: ReadGapReason.NoDistribution, epoch: 3 };
		const finding = { groupId: "g-7", gap };
		const t = setup([page([], null, [finding]), page([], null, [finding])]);
		await t.run({ once: true });
		const found = t.lines.filter((l) => l.event === "finding");
		expect(found).toHaveLength(1);
		expect(found[0]?.data).toMatchObject({ group_id: "g-7", gap });
		expect(typeof found[0]?.data.sentence).toBe("string");
	});

	it("tells an equal gap again for another group on an org-wide read", async () => {
		const gap = { reason: ReadGapReason.NoDistribution };
		const t = setup([
			page([], null, [
				{ groupId: "g-1", gap },
				{ groupId: "g-2", gap },
			]),
		]);
		await t.run({ once: true });
		expect(
			t.lines.filter((l) => l.event === "finding").map((l) => l.data.group_id),
		).toEqual(["g-1", "g-2"]);
	});

	it("starts from the cursor with --before and filters by agent and group", async () => {
		const t = setup([page([message("m1")])]);
		await t.run({ once: true, before: "cur-9", agent: "a-1", group: "g-1" });
		expect(t.queries[0]).toMatchObject({
			cursor: "cur-9",
			agent: "a-1",
			groupId: "g-1",
		});
		expect(t.lines.find((l) => l.event === "page")?.data.kind).toBe("older");
	});

	it("exits NoIdentity after an error event, without a hello, when there is no key", async () => {
		for (const code of [FeedErrorCode.NeedsOrgKey, FeedErrorCode.NoIdentity]) {
			const t = setup([]);
			const exit = await t.run({}, { kind: IdentityKind.Blocked, code });
			expect(exit).toBe(FeedExit.NoIdentity);
			expect(t.events()).toEqual(["error"]);
			expect(t.lines[0]?.data).toMatchObject({ code, retry_s: null });
			expect(t.lines[0]?.data.sentence).toEqual(expect.any(String));
		}
	});

	it("exits Refused when the server refuses the key", async () => {
		const t = setup([new RineApiError(401, "no")]);
		expect(await t.run()).toBe(FeedExit.Refused);
		expect(t.events()).toEqual(["hello", "error"]);
		expect(t.lines[1]?.data).toMatchObject({
			code: "auth_refused",
			retry_s: null,
		});
		expect(t.closed).toHaveBeenCalledOnce();
	});

	it("reports a network failure and, with --once, exits Failed", async () => {
		const t = setup([new ReaderNetworkError("down")]);
		expect(await t.run({ once: true })).toBe(FeedExit.Failed);
		expect(t.lines[1]?.data).toMatchObject({ code: "network", retry_s: 5 });
		expect(String(t.lines[1]?.data.sentence)).toContain("api.rine.network");
	});

	it("keeps following after a network failure and reads again", async () => {
		const t = setup([new ReaderNetworkError("down"), page([message("m1")])]);
		const running = t.run();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(t.events()).toEqual(["hello", "error", "page", "row"]);
		t.proc.emit("SIGTERM");
		expect(await running).toBe(FeedExit.Clean);
	});

	it("sends a heartbeat every 15 seconds and counts down a rate-limit pause", async () => {
		const limited = new RineApiError(429, "slow");
		const t = setup([limited]);
		const running = t.run();
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		const beat = t.lines.find((l) => l.event === "heartbeat");
		expect(beat?.data).toMatchObject({ next_poll_s: 5, paused_s: 30 });
		t.proc.emit("SIGINT");
		await running;
	});

	it("exits cleanly on SIGTERM and closes the reader", async () => {
		const t = setup([page([])]);
		const running = t.run();
		await vi.advanceTimersByTimeAsync(0);
		t.proc.emit("SIGTERM");
		expect(await running).toBe(FeedExit.Clean);
		expect(t.closed).toHaveBeenCalledOnce();
	});

	it("exits cleanly when the parent process goes away", async () => {
		const t = setup([page([])]);
		const running = t.run();
		await vi.advanceTimersByTimeAsync(PARENT_CHECK_MS);
		t.proc.ppid = 1;
		await vi.advanceTimersByTimeAsync(PARENT_CHECK_MS);
		expect(await running).toBe(FeedExit.Clean);
	});

	it("stops with a name-and-code line when a read fails in a way it cannot explain", async () => {
		const t = setup([new TypeError(`broke on ${SECRET}`)]);
		expect(await t.run()).toBe(FeedExit.Failed);
		expect(t.stderr.join("")).toMatch(
			/^rine tui stopped: TypeError \(E_UNKNOWN\)\n$/,
		);
		expect(t.stderr.join("")).not.toContain(SECRET);
		expect(JSON.stringify(t.lines)).not.toContain(SECRET);
	});
});

describe("rine tui when it cannot start", () => {
	const exitFor = async (
		args: string[],
	): Promise<number | string | undefined> => {
		const program = new Command("rine");
		registerTui(program);
		await program.parseAsync(["tui", ...args], { from: "user" });
		return process.exitCode;
	};

	afterEach(() => {
		process.exitCode = undefined;
		for (const stream of [process.stdout, process.stdin]) {
			Reflect.deleteProperty(stream, "isTTY");
		}
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("exits with the app's own failure code, not the feed's", async () => {
		vi.stubEnv("RINE_API_URL", "not a url");
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		for (const stream of [process.stdout, process.stdin]) {
			Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
		}
		expect(await exitFor([])).toBe(TuiExit.Failed);
	});

	it("exits with the feed's failure code under --feed", async () => {
		vi.stubEnv("RINE_API_URL", "not a url");
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(await exitFor(["--feed"])).toBe(FeedExit.Failed);
	});
});

describe("rine tui --feed contract stream", () => {
	it("writes every event kind exactly as the recorded stream the plugin parses", async () => {
		const gap = { reason: ReadGapReason.NoEscrow };
		const finding = {
			groupId: "g-7",
			gap: { reason: ReadGapReason.NoDistribution, epoch: 3 },
		};
		const t = setup([
			page([message("m1"), message("m2", { text: null, gap })], "older-1", [
				finding,
			]),
			new RineApiError(429, "slow"),
		]);
		const running = t.run({ group: "g-7" });
		await vi.advanceTimersByTimeAsync(5_000 + HEARTBEAT_MS);
		t.proc.emit("SIGTERM");
		await running;
		expect(new Set(t.events())).toEqual(
			new Set(["hello", "row", "finding", "page", "heartbeat", "error"]),
		);
		const stream = t.lines.map((l) => `${JSON.stringify(l)}\n`).join("");
		if (REGEN) writeFileSync(CONTRACT, stream);
		expect(stream).toBe(readFileSync(CONTRACT, "utf8"));
	});
});

describe("rine tui --help", () => {
	it("lists --ascii and none of the feed options", () => {
		const program = new Command("rine");
		registerTui(program);
		const help =
			program.commands.find((c) => c.name() === "tui")?.helpInformation() ?? "";
		expect(help).toContain("--ascii");
		for (const flag of [
			"--feed",
			"--once",
			"--before",
			"--agent",
			"--group",
			"--poll",
		]) {
			expect(help).not.toContain(flag);
		}
	});
});
