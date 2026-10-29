import type {
	ActivityQuery,
	OrgPage,
	ReadKey,
	ReadMessage,
} from "@rine-network/core";
import { RineApiError, TokenBucket } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESCAPE_MS } from "../src/tui/app-input.js";
import type { AppDeps } from "../src/tui/app-deps.js";
import { runApp } from "../src/tui/app.js";
import { DUMB_TERMINAL } from "../src/tui/copy.js";
import { FeedErrorCode, TuiExit } from "../src/tui/feed-schema.js";
import { IdentityKind, type IdentityResult } from "../src/tui/identity.js";
import type { Term } from "../src/tui/term.js";
import { BILLING, SALES, SECRET, messageOf, textBody } from "./tui-fixture.js";

const CLEAR_ALL = "\x1b[2J";

const ORG = { name: "Acme", slug: "acme" };

const message = (id: string): ReadMessage =>
	messageOf(
		id,
		{ text: textBody(SECRET) },
		{ createdAtMicros: Date.now() * 1000, conversationId: "c-1" },
	);

function setup(
	read: (q: ActivityQuery) => Promise<OrgPage> = async () => ({
		items: [],
		nextCursor: null,
		dropped: 0,
		findings: [],
	}),
	org: () => Promise<{ name: string; slug: string }> = async () => ORG,
) {
	const writes: string[] = [];
	let onData: (chunk: string) => void = () => undefined;
	let hooks = { onResize: () => undefined, onResume: () => undefined } as {
		onResize(): void;
		onResume(): void;
	};
	const term: Term = {
		enter: vi.fn(),
		restore: vi.fn(),
		suspend: vi.fn(),
		size: () => ({ cols: 120, rows: 30 }),
		write: (data) => {
			writes.push(data);
		},
		onData: (cb) => {
			onData = cb;
		},
		setTitle: vi.fn(),
	};
	const reads = vi.fn(read);
	const orgReads = vi.fn(org);
	const close = vi.fn(async () => undefined);
	const identity = {
		kind: IdentityKind.Reader,
		key: { orgId: "org-1" } as ReadKey,
		reader: {
			read: reads,
			close,
			org: orgReads,
		},
		bucket: new TokenBucket(),
	} as IdentityResult;
	const errors: string[] = [];
	const deps = (over: Partial<AppDeps> = {}): AppDeps => ({
		identity,
		host: "api.rine.network",
		pollS: 5,
		ascii: true,
		env: { TERM: "xterm" },
		stdin: {} as AppDeps["stdin"],
		stdout: {} as AppDeps["stdout"],
		writeError: (text) => errors.push(text),
		makeTerm: (given) => {
			hooks = given;
			return term;
		},
		...over,
	});
	return {
		term,
		writes,
		reads,
		orgReads,
		close,
		errors,
		identity,
		deps,
		send: (keys: string) => onData(keys),
		hooks: () => hooks,
		screen: () => writes.join(""),
	};
}

const settle = () => vi.advanceTimersByTimeAsync(1);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("rine tui in a terminal", () => {
	it("refuses a dumb terminal with a sentence and releases the key", async () => {
		const t = setup();
		const code = await runApp(t.deps({ env: { TERM: "dumb" } }));
		expect(code).toBe(TuiExit.NeedsTerminal);
		expect(t.errors).toEqual([`${DUMB_TERMINAL}\n`]);
		expect(t.term.enter).not.toHaveBeenCalled();
		expect(t.close).toHaveBeenCalledOnce();
	});

	it("draws the rows it reads and restores the terminal once when q quits", async () => {
		const t = setup(async () => ({
			items: [message("m1")],
			nextCursor: null,
			dropped: 0,
			findings: [],
		}));
		const running = runApp(t.deps());
		await settle();
		expect(t.term.enter).toHaveBeenCalledOnce();
		expect(t.screen()).toContain("SENTINEL-plaintext-4821");
		t.send("q");
		expect(await running).toBe(0);
		expect(t.term.restore).toHaveBeenCalledOnce();
		expect(t.close).toHaveBeenCalledOnce();
	});

	it("quits on ctrl-c", async () => {
		const t = setup();
		const running = runApp(t.deps());
		await settle();
		t.send("\x03");
		expect(await running).toBe(0);
		expect(t.term.restore).toHaveBeenCalledOnce();
	});

	it("repaints the whole screen on ctrl-l and on resize, not just the changes", async () => {
		const t = setup();
		const running = runApp(t.deps());
		await settle();
		const clears = () => t.writes.filter((w) => w.includes(CLEAR_ALL)).length;
		expect(clears()).toBe(1);
		t.send("\x0c");
		await settle();
		expect(clears()).toBe(2);
		t.hooks().onResize();
		await settle();
		expect(clears()).toBe(3);
		t.hooks().onResume();
		await settle();
		expect(clears()).toBe(4);
		t.send("q");
		await running;
	});

	it("hands ctrl-z to the terminal", async () => {
		const t = setup();
		const running = runApp(t.deps());
		await settle();
		t.send("\x1a");
		expect(t.term.suspend).toHaveBeenCalledOnce();
		t.send("q");
		await running;
	});

	it("takes a lone ESC as the Escape key only after the escape timeout", async () => {
		const t = setup();
		const running = runApp(t.deps());
		await settle();
		t.send("?");
		await settle();
		expect(t.screen()).toContain("Keys");
		const before = t.writes.length;
		t.send("\x1b");
		await vi.advanceTimersByTimeAsync(ESCAPE_MS - 5);
		expect(t.writes.length).toBe(before);
		await vi.advanceTimersByTimeAsync(10);
		expect(t.writes.length).toBeGreaterThan(before);
		t.send("q");
		await running;
	});

	it("shows why there is no view when the machine lacks the org key, and reads nothing", async () => {
		const t = setup();
		const running = runApp(
			t.deps({
				identity: {
					kind: IdentityKind.Blocked,
					code: FeedErrorCode.NeedsOrgKey,
				},
			}),
		);
		await settle();
		expect(t.screen()).toContain("This view reads the messages");
		t.send("q");
		expect(await running).toBe(0);
		expect(t.reads).not.toHaveBeenCalled();
	});

	it("restores the terminal before it reports a read it cannot explain, without printing it", async () => {
		const failure = new TypeError(`broke on ${SECRET}`);
		const t = setup(async () => {
			throw failure;
		});
		const running = runApp(t.deps());
		const outcome = running.then(
			() => null,
			(err: unknown) => err,
		);
		await settle();
		expect(await outcome).toBe(failure);
		expect(t.term.restore).toHaveBeenCalledOnce();
		expect(t.close).toHaveBeenCalledOnce();
		expect(t.errors).toEqual([]);
	});
});

const OWN_ROW = (id: string): ReadMessage =>
	messageOf(
		id,
		{ text: textBody(SECRET) },
		{
			createdAtMicros: Date.now() * 1000,
			sender: { ...SALES, handle: "sales@acme.rine.network" },
			recipient: { ...BILLING, handle: "billing@acme.rine.network" },
		},
	);

const page = (items: ReadMessage[]): OrgPage => ({
	items,
	nextCursor: null,
	dropped: 0,
	findings: [],
});

/** What a full repaint draws: everything after the last clear-screen. */
const lastFrame = (writes: readonly string[]): string => {
	const at = writes.map((w) => w.includes(CLEAR_ALL)).lastIndexOf(true);
	return writes.slice(at).join("");
};

describe("rine tui org read", () => {
	it("retries a failed /whoami on each poll tick until it answers, then shortens handles and titles the window", async () => {
		let attempts = 0;
		const t = setup(
			async () => page([OWN_ROW("m1")]),
			async () => {
				if (++attempts < 3) throw new Error("whoami is down");
				return ORG;
			},
		);
		const running = runApp(t.deps());
		await settle();
		expect(t.orgReads).toHaveBeenCalledTimes(1);
		expect(lastFrame(t.writes)).toContain("sales@acme");
		expect(t.term.setTitle).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(5000);
		expect(t.orgReads).toHaveBeenCalledTimes(2);
		expect(t.term.setTitle).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(5000);
		expect(t.orgReads).toHaveBeenCalledTimes(3);
		expect(t.term.setTitle).toHaveBeenCalledExactlyOnceWith("Acme");
		t.hooks().onResize();
		await settle();
		const frame = lastFrame(t.writes);
		expect(frame).toContain("billing");
		expect(frame).not.toContain("sales@acme");

		await vi.advanceTimersByTimeAsync(15000);
		expect(t.orgReads).toHaveBeenCalledTimes(3);
		t.send("q");
		await running;
	});

	it("stops asking /whoami after the server refuses it, but keeps asking through a 503", async () => {
		const refused = setup(async () => page([OWN_ROW("m1")]), async () => {
			throw new RineApiError(403, "forbidden");
		});
		const first = runApp(refused.deps());
		await settle();
		await vi.advanceTimersByTimeAsync(15000);
		expect(refused.orgReads).toHaveBeenCalledTimes(1);
		refused.send("q");
		await first;

		const down = setup(async () => page([OWN_ROW("m1")]), async () => {
			throw new RineApiError(503, "unavailable");
		});
		const second = runApp(down.deps());
		await settle();
		await vi.advanceTimersByTimeAsync(10000);
		expect(down.orgReads).toHaveBeenCalledTimes(3);
		down.send("q");
		await second;
	});

	it("relabels the rows already loaded when /whoami answers late, without reading again", async () => {
		let attempts = 0;
		const t = setup(
			async (query) =>
				page([
					query.since === undefined
						? OWN_ROW("m1")
						: messageOf(
								"m2",
								{ text: textBody("SECOND-LIST-ENTRY") },
								{
									createdAtMicros: Date.now() * 1000,
									sender: { ...SALES, handle: "sales@acme.rine.network" },
									recipient: { ...BILLING, handle: "billing@acme.rine.network" },
								},
							),
				]),
			async () => {
				if (++attempts < 3) throw new Error("whoami is down");
				return ORG;
			},
		);
		const running = runApp(t.deps());
		await settle();
		await vi.advanceTimersByTimeAsync(10000);
		expect(t.orgReads).toHaveBeenCalledTimes(3);
		const firstPages = () =>
			t.reads.mock.calls.filter(([query]) => query.since === undefined).length;
		expect(firstPages()).toBe(1);
		t.hooks().onResize();
		await settle();
		const frame = lastFrame(t.writes);
		expect(frame).toContain("SENTINEL-plaintext-4821");
		expect(frame).toContain("SECOND-LIST-ENTRY");
		expect(frame).not.toContain("sales@acme");
		t.send("q");
		await running;
	});

	it("does not read /whoami again for a poll page that lands while the view closes", async () => {
		const t = setup(
			(query) =>
				query.since === undefined
					? Promise.resolve(page([message("m1")]))
					: new Promise<OrgPage>((resolve) => {
							setTimeout(() => resolve(page([message("late")])), 3000);
						}),
			async () => {
				throw new Error("whoami is down");
			},
		);
		const running = runApp(t.deps());
		await settle();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.orgReads).toHaveBeenCalledTimes(1);
		t.send("q");
		await vi.advanceTimersByTimeAsync(4000);
		await running;
		expect(t.orgReads).toHaveBeenCalledTimes(1);
	});

	it("titles the window once with the org name scrubbed of control characters", async () => {
		const t = setup(undefined, async () => ({
			name: "Ac\x07me\x1b]0;evil\x07",
			slug: "acme",
		}));
		const running = runApp(t.deps());
		await settle();
		expect(t.term.setTitle).toHaveBeenCalledExactlyOnceWith("Acme");
		t.send("q");
		await running;
	});

	it("ends the view, restoring the terminal, when applying the org throws", async () => {
		const failure = new TypeError("title refused");
		const t = setup();
		vi.mocked(t.term.setTitle).mockImplementation(() => {
			throw failure;
		});
		const running = runApp(t.deps());
		const outcome = running.then(
			() => null,
			(err: unknown) => err,
		);
		await settle();
		expect(await outcome).toBe(failure);
		expect(t.term.restore).toHaveBeenCalledOnce();
	});
});

const SPINNER_FRAMES = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

describe("rine tui spinner", () => {
	const animated = {
		ascii: false,
		env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
		stdout: { isTTY: true, getColorDepth: () => 24 } as AppDeps["stdout"],
	};

	it("spins while the first page loads and never again on a background poll", async () => {
		let release: (page: OrgPage) => void = () => undefined;
		let polls = 0;
		const t = setup((query) => {
			if (query.since === undefined)
				return new Promise<OrgPage>((resolve) => {
					release = resolve;
				});
			polls++;
			const arrived = page([message(`poll-${polls}`)]);
			return new Promise<OrgPage>((resolve) => {
				setTimeout(() => resolve(arrived), 3000);
			});
		});
		const running = runApp(t.deps(animated));
		await vi.advanceTimersByTimeAsync(500);
		expect(t.screen()).toMatch(SPINNER_FRAMES);

		release(page([message("m1")]));
		await vi.advanceTimersByTimeAsync(2000);
		const settled = t.writes.length;
		await vi.advanceTimersByTimeAsync(20000);
		expect(polls).toBeGreaterThan(1);
		expect(t.writes.length).toBeGreaterThan(settled);
		expect(t.writes.slice(settled).join("")).not.toMatch(SPINNER_FRAMES);

		await vi.advanceTimersByTimeAsync(3000);
		t.send("q");
		await running;
	});
});
