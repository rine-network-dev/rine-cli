import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiUrl, mint } = vi.hoisted(() => ({
	apiUrl: { value: "" },
	mint: vi.fn(async (_opts?: { force?: boolean }) => "fake-token"),
}));

// The real `eventsource-client` runs against a real local server: a mocked event source cannot
// tell a refused request from a clean close, which is the whole defect.
vi.mock("@rine-network/core", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	resolveConfigDir: vi.fn(() => "/fake/config"),
	resolveApiUrl: vi.fn(() => apiUrl.value),
	fetchAgents: vi.fn(async () => [{ id: "agent-1", name: "bot" }]),
	resolveAgent: vi.fn(async () => ({ agentId: "agent-1" })),
	jitteredRefreshMargin: vi.fn(() => 60),
	// No jitter: the gaps between attempts are the backoff itself, so a test can tell 1 s from 4 s.
	jitteredDelayMs: vi.fn((seconds: number) => seconds * 1000),
	agentKeysExist: vi.fn(() => false),
}));

vi.mock("../src/action.js", () => ({
	createClient: vi.fn(async () => ({
		client: { get: vi.fn(), post: vi.fn(), markDelivered: vi.fn() },
		profileName: "default",
		dirs: { configDir: "/fake/config", ownerDir: "/fake/owner" },
		auth: undefined,
		token: mint,
	})),
}));

vi.mock("../src/commands/stream-cursor.js", () => ({
	loadStreamCursor: vi.fn(() => undefined),
	saveStreamCursor: vi.fn(),
}));

import { Command } from "commander";
import { registerStream } from "../src/commands/stream.js";

const WINDOW_MS = 2500;

describe("rine stream reconnecting against a local server", () => {
	let server: Server;
	let requests: number;
	let status: number;
	let arrivals: number[];
	let clockSkewMs: number;
	let stopListeners: (() => void)[];

	beforeEach(async () => {
		requests = 0;
		arrivals = [];
		clockSkewMs = 0;
		stopListeners = [];
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockSkewMs);
		mint.mockClear();
		const capture = (event: string, listener: () => void) => {
			if (event === "SIGINT" || event === "SIGTERM") stopListeners.push(listener);
			return process;
		};
		vi.spyOn(process, "on").mockImplementation(capture as typeof process.on);
		vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		vi.spyOn(process.stderr, "write").mockImplementation(((...args: unknown[]) => {
			const done = args.at(-1);
			if (typeof done === "function") done();
			return true;
		}) as never);
		server = createServer((_req, res) => {
			requests++;
			arrivals.push(realNow());
			if (status === 200) {
				// A stream that answers 200 and ends; the third request outlives the healthy
				// threshold (the skewed clock stands in for a minute of connection).
				if (requests === 3) clockSkewMs = 60_000;
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end();
				return;
			}
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ detail: "refused" }));
		});
		await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
		apiUrl.value = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise((ok) => server.close(ok));
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	/** Milliseconds between the arrivals of two requests. */
	const gap = (from: number, to: number): number =>
		(arrivals[to] ?? Number.NaN) - (arrivals[from] ?? Number.NaN);

	async function streamFor(ms: number): Promise<void> {
		const program = new Command().option("--json").option("--profile <name>").option("--as <handle>");
		registerStream(program);
		const run = program.parseAsync(["node", "rine", "stream"]);
		await new Promise((ok) => setTimeout(ok, ms));
		for (const stop of stopListeners) stop();
		await run;
	}

	it.each([
		[401, "mints a fresh token for the next attempt"],
		[403, "keeps the cached token"],
	])(
		"test_stream_when_http_%i_then_attempts_are_bounded_and_it_%s",
		async (code) => {
			status = code;
			await streamFor(WINDOW_MS);
			// Backoff starts at one second (jittered 0.5-1.5 s), so a 2.5 s window holds a handful of
			// attempts; the hot loop made thousands in one second.
			expect(requests).toBeGreaterThanOrEqual(2);
			expect(requests).toBeLessThanOrEqual(6);
			const forced = mint.mock.calls.map(([opts]) => opts?.force);
			expect(forced[0]).toBe(false);
			if (code === 401) expect(forced[1]).toBe(true);
			else expect(forced.every((f) => f === false)).toBe(true);
		},
	);

	it("test_stream_when_a_200_stream_closes_at_once_then_attempts_are_bounded", async () => {
		status = 200;
		await streamFor(WINDOW_MS);
		expect(requests).toBeGreaterThanOrEqual(2);
		expect(requests).toBeLessThanOrEqual(4);
	});

	it("test_stream_when_a_connection_stayed_healthy_then_the_backoff_starts_over", async () => {
		status = 200;
		await streamFor(5500);
		// Attempts 1-3 fail fast: waits of 1 s and 2 s. Attempt 3 outlives the healthy threshold,
		// so the wait before attempt 4 is 1 s, not the 4 s the grown backoff would give.
		expect(requests).toBeGreaterThanOrEqual(4);
		expect(gap(0, 1)).toBeGreaterThanOrEqual(900);
		expect(gap(1, 2)).toBeGreaterThanOrEqual(1900);
		expect(gap(2, 3)).toBeLessThan(2000);
	}, 10_000);
});
