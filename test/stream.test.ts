import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("eventsource-client", () => ({
	createEventSource: vi.fn(),
}));

// Spread the real module so helpers the command uses but does not need stubbed
// (e.g. the authenticity predicate) keep their real behaviour.
vi.mock("@rine-network/core", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	resolveConfigDir: vi.fn(() => "/fake/config"),
	resolveApiUrl: vi.fn(() => "http://localhost:7001"),
	fetchAgents: vi.fn(async () => [{ id: "agent-1", name: "bot" }]),
	resolveAgent: vi.fn(async () => ({ agentId: "agent-1" })),
	jitteredRefreshMargin: vi.fn(() => 60),
	jitteredDelayMs: vi.fn(
		((await importOriginal()) as typeof import("@rine-network/core"))
			.jitteredDelayMs,
	),
	formatError: vi.fn((e: unknown) => String(e)),
	agentKeysExist: vi.fn(() => false),
	ingestSenderKeyDistribution: vi.fn(),
	decryptMessage: vi.fn(),
	// The group seam is the RECOVERY, not the bare decrypt: `stream` reaches the
	// missing-key failure through core's one-shot ingest-and-retry, and stubbing
	// the bare decrypt left the real recovery running underneath — a mock the
	// code no longer calls.
	decryptGroupMessageWithRecovery: vi.fn(),
	// Passes through to the real decoder; one test makes it throw.
	a2aCleartextPlaintext: vi.fn(
		((await importOriginal()) as typeof import("@rine-network/core"))
			.a2aCleartextPlaintext,
	),
}));

const { markDelivered } = vi.hoisted(() => ({ markDelivered: vi.fn() }));

vi.mock("../src/action.js", () => ({
	createClient: vi.fn(async () => ({
		client: { get: vi.fn(), post: vi.fn(), markDelivered },
		profileName: "default",
		dirs: { configDir: "/fake/config", ownerDir: "/fake/owner" },
		auth: undefined,
		token: vi.fn(async () => "fake-token"),
	})),
}));

vi.mock("../src/output.js", () => ({
	printError: vi.fn(),
}));

vi.mock("../src/commands/stream-cursor.js", () => ({
	loadStreamCursor: vi.fn(() => undefined),
	saveStreamCursor: vi.fn(),
}));

const CREATED_AT = "2026-10-01T12:00:00Z";

import { readFileSync } from "node:fs";
import { createEventSource } from "eventsource-client";
import { Command } from "commander";
import { registerStream } from "../src/commands/stream.js";
import {
	ACTING_AGENT_HEADER,
	a2aCleartextPlaintext,
	PEEK_HEADER,
	SENDER_KEY_UNAVAILABLE_PREVIEW,
	UNKNOWN_SENDER_KEY_CLAUSE,
	agentKeysExist,
	GroupAuthenticityError,
	decryptGroupMessageWithRecovery,
	decryptMessage,
	ingestSenderKeyDistribution,
	jitteredDelayMs,
} from "@rine-network/core";
import { loadStreamCursor, saveStreamCursor } from "../src/commands/stream-cursor.js";
import { exitWhenFlushed } from "../src/commands/stream-stop.js";
import { printError } from "../src/output.js";

const mockCreateEventSource = vi.mocked(createEventSource);
const mockLoadCursor = vi.mocked(loadStreamCursor);
const mockSaveCursor = vi.mocked(saveStreamCursor);

function makeProgram(): Command {
	const program = new Command();
	program.option("--json");
	program.option("--profile <name>");
	program.option("--as <handle>");
	registerStream(program);
	return program;
}

function captureStdout(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
	return { lines, restore: () => { console.log = orig; } };
}

function captureStderr(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const mock = vi.spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
		lines.push(String(args[0]));
		const done = args.at(-1);
		if (typeof done === "function") done();
		return true;
	});
	return { lines, restore: () => mock.mockRestore() };
}

type SigintHandler = (...args: unknown[]) => void;
type StopSignal = "SIGINT" | "SIGTERM";

describe("rine stream", () => {
	let signalListeners: Record<StopSignal, SigintHandler[]>;

	function fireSignal(signal: StopSignal): void {
		for (const l of [...signalListeners[signal]]) l();
	}

	function fireSigint(): void {
		fireSignal("SIGINT");
	}

	function installSigintCapture(): void {
		signalListeners = { SIGINT: [], SIGTERM: [] };
		const capture = (event: string, listener: SigintHandler) => {
			if (event === "SIGINT" || event === "SIGTERM") {
				signalListeners[event].push(listener);
			}
			return process;
		};
		vi.spyOn(process, "on").mockImplementation(capture as typeof process.on);
		vi.spyOn(process, "once").mockImplementation(capture as typeof process.once);
	}

	function makeMockEs(onCreated?: (opts: any, es: any) => void): any {
		return (opts: any) => {
			const es = { close: vi.fn() };
			onCreated?.(opts, es);
			return es;
		};
	}

	let exit: MockInstance<typeof process.exit>;

	beforeEach(() => {
		installSigintCapture();
		// A second stop signal exits at once; the tests that signal twice must not end the runner.
		exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		process.exitCode = undefined;
		mockLoadCursor.mockReset();
		mockLoadCursor.mockReturnValue(undefined);
		mockSaveCursor.mockReset();
		mockCreateEventSource.mockImplementation(makeMockEs(() => {
			Promise.resolve().then(() => fireSigint());
		}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		mockCreateEventSource.mockReset();
		process.exitCode = undefined;
	});

	describe("heartbeat timeout", () => {
		async function flushMicrotasks(): Promise<void> {
			for (let i = 0; i < 20; i++) {
				await vi.advanceTimersByTimeAsync(0);
			}
		}

		it("closes connection after heartbeat timeout", async () => {
			vi.useFakeTimers();
			let closeFn: ReturnType<typeof vi.fn> | undefined;

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				closeFn = es.close;
				return es;
			}) as any);

			const program = makeProgram();
			const p = program.parseAsync(["node", "rine", "stream", "--heartbeat-timeout", "10"]);

			await flushMicrotasks();

			await vi.advanceTimersByTimeAsync(11000);
			await flushMicrotasks();
			expect(closeFn).toHaveBeenCalled();

			fireSigint();
			await vi.advanceTimersByTimeAsync(120000);
			await flushMicrotasks();

			vi.useRealTimers();
			await p;
		});

		it("resets timeout on message", async () => {
			vi.useFakeTimers();
			let closeFn: ReturnType<typeof vi.fn> | undefined;
			let onMsg: ((msg: any) => void) | undefined;

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				closeFn = es.close;
				onMsg = opts.onMessage;
				return es;
			}) as any);

			const program = makeProgram();
			const p = program.parseAsync(["node", "rine", "stream", "--heartbeat-timeout", "10"]);

			await flushMicrotasks();

			await vi.advanceTimersByTimeAsync(8000);
			await flushMicrotasks();
			expect(closeFn).not.toHaveBeenCalled();

			onMsg!({ event: "heartbeat", data: "{}", id: null });

			await vi.advanceTimersByTimeAsync(8000);
			await flushMicrotasks();
			expect(closeFn).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(3000);
			await flushMicrotasks();
			expect(closeFn).toHaveBeenCalled();

			fireSigint();
			await vi.advanceTimersByTimeAsync(120000);
			await flushMicrotasks();

			vi.useRealTimers();
			await p;
		});

		it("clamps minimum timeout to 10 seconds", async () => {
			vi.useFakeTimers();
			let closeFn: ReturnType<typeof vi.fn> | undefined;

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				closeFn = es.close;
				return es;
			}) as any);

			const program = makeProgram();
			const p = program.parseAsync(["node", "rine", "stream", "--heartbeat-timeout", "3"]);

			await flushMicrotasks();

			// At 5s (> 3 requested but < 10 clamped) — should NOT have timed out
			await vi.advanceTimersByTimeAsync(5000);
			await flushMicrotasks();
			expect(closeFn).not.toHaveBeenCalled();

			// At 11s (> 10 clamped minimum) — should have timed out
			await vi.advanceTimersByTimeAsync(6000);
			await flushMicrotasks();
			expect(closeFn).toHaveBeenCalled();

			fireSigint();
			await vi.advanceTimersByTimeAsync(120000);
			await flushMicrotasks();

			vi.useRealTimers();
			await p;
		});
	});

	describe("lifecycle events", () => {
		it("emits connecting and connected in JSON mode", async () => {
			const out = captureStdout();

			mockCreateEventSource.mockImplementationOnce(makeMockEs((_opts) => {
				Promise.resolve().then(() => _opts.onDisconnect?.());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json"]);
			out.restore();

			const events = out.lines.filter((l) => l.includes('"lifecycle"')).map((l) => JSON.parse(l));
			const connecting = events.find((e: any) => e.data.state === "connecting");
			expect(connecting).toBeDefined();
			expect(connecting.data.attempt).toBe(1);
			expect(connecting.data.url).toContain("/agents/agent-1/stream");

			const connected = events.find((e: any) => e.data.state === "connected");
			expect(connected).toBeDefined();
			expect(connected.data.attempt).toBe(1);
		});

		it("emits reconnecting with server_close reason", async () => {
			const out = captureStdout();

			mockCreateEventSource.mockImplementationOnce(makeMockEs((_opts) => {
				Promise.resolve().then(() => _opts.onDisconnect?.());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json"]);
			out.restore();

			const events = out.lines.filter((l) => l.includes('"lifecycle"')).map((l) => JSON.parse(l));
			const reconnecting = events.find((e: any) => e.data.state === "reconnecting");
			expect(reconnecting).toBeDefined();
			expect(reconnecting.data.reason).toBe("server_close");
			expect(reconnecting.data.attempt).toBe(2);
			expect(reconnecting.data.backoff_ms).toBeGreaterThan(0);
		});

		it("emits reconnecting with heartbeat_timeout reason", async () => {
			vi.useFakeTimers();
			const out = captureStdout();

			async function flushMicrotasks(): Promise<void> {
				for (let i = 0; i < 20; i++) {
					await vi.advanceTimersByTimeAsync(0);
				}
			}

			// First call: silent (triggers heartbeat timeout)
			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				return es;
			}) as any);

			const program = makeProgram();
			const p = program.parseAsync(["node", "rine", "stream", "--json", "--heartbeat-timeout", "10"]);

			await flushMicrotasks();
			await vi.advanceTimersByTimeAsync(11000);
			await flushMicrotasks();

			// Stop loop
			fireSigint();
			await vi.advanceTimersByTimeAsync(120000);
			await flushMicrotasks();

			vi.useRealTimers();
			await p;
			out.restore();

			const events = out.lines.filter((l) => l.includes('"lifecycle"')).map((l) => JSON.parse(l));
			const reconnecting = events.find((e: any) => e.data.reason === "heartbeat_timeout");
			expect(reconnecting).toBeDefined();
			expect(reconnecting.data.state).toBe("reconnecting");
			expect(reconnecting.data.backoff_ms).toBeGreaterThan(0);
		});

		it("emits stopped on SIGINT", async () => {
			const out = captureStdout();

			mockCreateEventSource.mockImplementationOnce(makeMockEs(() => {
				Promise.resolve().then(() => fireSigint());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json"]);
			out.restore();

			const events = out.lines.filter((l) => l.includes('"lifecycle"')).map((l) => JSON.parse(l));
			const stopped = events.find((e: any) => e.data.state === "stopped");
			expect(stopped).toBeDefined();
			expect(stopped.data.reason).toBe("signal");
		});

		it("attempt counter increments across reconnections", async () => {
			const out = captureStdout();

			for (let i = 0; i < 3; i++) {
				mockCreateEventSource.mockImplementationOnce(makeMockEs((_opts) => {
					Promise.resolve().then(() => _opts.onDisconnect?.());
				}));
			}
			// server_close now waits out a backoff; no wait keeps these tests quick
			for (let i = 0; i < 3; i++) vi.mocked(jitteredDelayMs).mockReturnValueOnce(0);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json"]);
			out.restore();

			const connectingEvents = out.lines
				.filter((l) => l.includes('"lifecycle"'))
				.map((l) => JSON.parse(l))
				.filter((e: any) => e.data.state === "connecting");

			expect(connectingEvents.length).toBeGreaterThanOrEqual(3);
			expect(connectingEvents[0].data.attempt).toBe(1);
			expect(connectingEvents[1].data.attempt).toBe(2);
			expect(connectingEvents[2].data.attempt).toBe(3);
		});

		it("holds one listener per stop signal however many times it reconnects", async () => {
			const out = captureStdout();

			for (let i = 0; i < 3; i++) {
				mockCreateEventSource.mockImplementationOnce(makeMockEs((_opts) => {
					Promise.resolve().then(() => _opts.onDisconnect?.());
				}));
			}
			// server_close now waits out a backoff; no wait keeps these tests quick
			for (let i = 0; i < 3; i++) vi.mocked(jitteredDelayMs).mockReturnValueOnce(0);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json"]);
			out.restore();

			expect(signalListeners.SIGINT).toHaveLength(1);
			expect(signalListeners.SIGTERM).toHaveLength(1);
			const stopped = out.lines
				.filter((l) => l.includes('"lifecycle"'))
				.map((l) => JSON.parse(l))
				.find((e: any) => e.data.state === "stopped");
			expect(stopped?.data.reason).toBe("signal");
		});

		it("human-readable mode writes connect message to stderr", async () => {
			const stderr = captureStderr();

			mockCreateEventSource.mockImplementationOnce(makeMockEs(() => {
				Promise.resolve().then(() => fireSigint());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream"]);
			stderr.restore();

			const connectMsg = stderr.lines.find((l) => l.includes("Connected to stream"));
			expect(connectMsg).toBeDefined();
		});
	});

	describe("persistent mode", () => {
		it("--persistent appends query parameter to URL", async () => {
			let capturedUrl = "";

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				capturedUrl = opts.url;
				const es = { close: vi.fn() };
				Promise.resolve().then(() => fireSigint());
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--persistent"]);

			expect(capturedUrl).toContain("?persistent=true");
		});

		it("--persistent prints mode to stderr", async () => {
			const stderr = captureStderr();

			mockCreateEventSource.mockImplementationOnce(makeMockEs(() => {
				Promise.resolve().then(() => fireSigint());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--persistent"]);
			stderr.restore();

			const persistentMsg = stderr.lines.find((l) => l.includes("Persistent mode"));
			expect(persistentMsg).toBeDefined();
		});

		it("without --persistent URL has no query parameter", async () => {
			let capturedUrl = "";

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				capturedUrl = opts.url;
				const es = { close: vi.fn() };
				Promise.resolve().then(() => fireSigint());
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream"]);

			expect(capturedUrl).not.toContain("persistent");
		});
	});

	describe("backoff jitter", () => {
		it("reconnecting event backoff_ms is within jitter bounds", async () => {
			const out = captureStdout();

			// First call: throw error to trigger catch branch with backoff
			mockCreateEventSource.mockImplementationOnce((() => {
				throw new Error("connection refused");
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json"]);
			out.restore();

			const events = out.lines
				.filter((l) => l.includes('"lifecycle"'))
				.map((l) => JSON.parse(l));

			const reconnecting = events.find((e: any) => e.data.state === "reconnecting" && e.data.reason === "error");
			expect(reconnecting).toBeDefined();
			// First error uses backoff=1, jitter range: [500, 1500] ms
			expect(reconnecting.data.backoff_ms).toBeGreaterThanOrEqual(500);
			expect(reconnecting.data.backoff_ms).toBeLessThanOrEqual(1500);
			expect(reconnecting.data.error).toBe("connection refused");
		});
	});

	describe("--monitor mode", () => {
		it("suppresses lifecycle events from stdout, redirects to stderr", async () => {
			const out = captureStdout();
			const stderr = captureStderr();

			mockCreateEventSource.mockImplementationOnce(makeMockEs((_opts) => {
				Promise.resolve().then(() => _opts.onDisconnect?.());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json", "--monitor"]);
			out.restore();
			stderr.restore();

			const stdoutLifecycle = out.lines.filter((l) => l.includes('"lifecycle"'));
			expect(stdoutLifecycle).toHaveLength(0);

			const stderrLifecycle = stderr.lines.filter((l) => l.includes('"lifecycle"'));
			expect(stderrLifecycle.length).toBeGreaterThanOrEqual(2);
		});

		it("suppresses heartbeat events from stdout", async () => {
			const out = captureStdout();
			let onMsg: ((msg: any) => void) | undefined;

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				onMsg = opts.onMessage;
				Promise.resolve().then(() => {
					onMsg!({ event: "heartbeat", data: "{}", id: null });
					Promise.resolve().then(() => fireSigint());
				});
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json", "--monitor"]);
			out.restore();

			const heartbeatLines = out.lines.filter((l) => l.includes('"heartbeat"'));
			expect(heartbeatLines).toHaveLength(0);
		});

		it("passes message events through to stdout", async () => {
			const out = captureStdout();
			let onMsg: ((msg: any) => void) | undefined;

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				onMsg = opts.onMessage;
				Promise.resolve().then(() => {
					onMsg!({ event: "message", data: '{"type":"rine.v1.dm"}', id: "msg-1" });
					Promise.resolve().then(() => fireSigint());
				});
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json", "--monitor"]);
			out.restore();

			const messageLines = out.lines
				.map((l) => { try { return JSON.parse(l); } catch { return null; } })
				.filter((e): e is any => e?.event === "message");
			expect(messageLines).toHaveLength(1);
			expect(messageLines[0].event).toBe("message");
			expect(messageLines[0].id).toBe("msg-1");
		});

		it("redirects stopped lifecycle to stderr on SIGINT", async () => {
			const out = captureStdout();
			const stderr = captureStderr();

			mockCreateEventSource.mockImplementationOnce(makeMockEs(() => {
				Promise.resolve().then(() => fireSigint());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json", "--monitor"]);
			out.restore();
			stderr.restore();

			const stdoutStopped = out.lines.filter((l) => l.includes('"stopped"'));
			expect(stdoutStopped).toHaveLength(0);

			const stderrStopped = stderr.lines.filter((l) => l.includes('"stopped"'));
			expect(stderrStopped.length).toBeGreaterThanOrEqual(1);
		});

		it("human-readable mode still shows connect on stderr", async () => {
			const stderr = captureStderr();

			mockCreateEventSource.mockImplementationOnce(makeMockEs(() => {
				Promise.resolve().then(() => fireSigint());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--monitor"]);
			stderr.restore();

			const connectMsg = stderr.lines.find((l) => l.includes("Connected to stream"));
			expect(connectMsg).toBeDefined();
		});
	});

	describe("cursor persistence", () => {
		it("loads the persisted cursor for the resolved agent on startup", async () => {
			mockCreateEventSource.mockImplementationOnce(makeMockEs(() => {
				Promise.resolve().then(() => fireSigint());
			}));

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream"]);

			expect(mockLoadCursor).toHaveBeenCalledWith("/fake/config", "agent-1");
		});

		it("sends the persisted Last-Event-ID on a fresh (restarted) connect", async () => {
			mockLoadCursor.mockReturnValueOnce("persisted-evt-9");

			let capturedHeaders: Record<string, string> = {};
			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				capturedHeaders = opts.headers;
				const es = { close: vi.fn() };
				Promise.resolve().then(() => fireSigint());
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream"]);

			expect(capturedHeaders["Last-Event-ID"]).toBe("persisted-evt-9");
		});

		it("persists the cursor when a message with an id arrives", async () => {
			let onMsg: ((msg: any) => void) | undefined;
			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				onMsg = opts.onMessage;
				Promise.resolve().then(() => {
					onMsg!({ event: "message", data: '{"type":"rine.v1.dm"}', id: "evt-77" });
					Promise.resolve().then(() => fireSigint());
				});
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json"]);

			expect(mockSaveCursor).toHaveBeenCalledWith("/fake/config", "agent-1", "evt-77");
		});

		it("does not persist a heartbeat frame (no id)", async () => {
			let onMsg: ((msg: any) => void) | undefined;
			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				onMsg = opts.onMessage;
				Promise.resolve().then(() => {
					onMsg!({ event: "heartbeat", data: "{}", id: null });
					Promise.resolve().then(() => fireSigint());
				});
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", "--json"]);

			expect(mockSaveCursor).not.toHaveBeenCalled();
		});
	});

	describe("message preview decryption", () => {
		const mockAgentKeysExist = vi.mocked(agentKeysExist);
		const mockDecryptGroup = vi.mocked(decryptGroupMessageWithRecovery);
		const mockDecryptDm = vi.mocked(decryptMessage);

		const decrypted = (plaintext: string) =>
			({
				plaintext,
				senderKid: "agent-2:sig",
				verified: true,
				verificationStatus: "verified",
			}) as unknown as Awaited<ReturnType<typeof decryptGroupMessageWithRecovery>>;

		beforeEach(() => {
			mockAgentKeysExist.mockReset();
			mockAgentKeysExist.mockReturnValue(true);
			mockDecryptGroup.mockReset();
			mockDecryptDm.mockReset();
		});

		afterEach(() => {
			mockAgentKeysExist.mockReset();
			mockAgentKeysExist.mockReturnValue(false);
			mockDecryptGroup.mockReset();
			mockDecryptDm.mockReset();
		});

		/** The server-authenticated sender of the streamed events below. */
		const PEER_ID = "22222222-2222-2222-2222-222222222222";

		async function previewOf(
			payload: Record<string, unknown>,
			...flags: string[]
		): Promise<string> {
			const out = captureStdout();
			const stderr = captureStderr();

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				Promise.resolve().then(() => {
					opts.onMessage({
						event: "message",
						data: JSON.stringify(payload),
						id: null,
					});
					Promise.resolve().then(() => fireSigint());
				});
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream", ...flags]);
			// The preview is formatted asynchronously and can settle after the
			// SIGINT-terminated loop returns — drain the queue before asserting.
			for (let i = 0; i < 5; i++) {
				await new Promise((r) => setImmediate(r));
			}
			out.restore();
			stderr.restore();

			return out.lines.join("\n");
		}

		/**
		 * The same stream carrying SEVERAL events, and both channels it writes to:
		 * the message lines on stdout, and the notices `printError` puts beside
		 * them. One `rine stream` invocation is one render, which is exactly what
		 * the explain-once rule is scoped to.
		 */
		async function previewsOf(
			payloads: Array<Record<string, unknown>>,
		): Promise<{ lines: string[]; notices: string[] }> {
			const out = captureStdout();
			const stderr = captureStderr();
			vi.mocked(printError).mockClear();

			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				Promise.resolve().then(async () => {
					for (const payload of payloads) {
						opts.onMessage({
							event: "message",
							data: JSON.stringify(payload),
							id: null,
						});
						// Let each line settle before the next arrives, so the order
						// under test is the order the events arrived in.
						for (let i = 0; i < 5; i++) {
							await new Promise((r) => setImmediate(r));
						}
					}
					Promise.resolve().then(() => fireSigint());
				});
				return es;
			}) as any);

			const program = makeProgram();
			await program.parseAsync(["node", "rine", "stream"]);
			for (let i = 0; i < 5; i++) {
				await new Promise((r) => setImmediate(r));
			}
			out.restore();
			stderr.restore();

			return {
				lines: out.lines.filter((l) => l.trim() !== ""),
				notices: vi
					.mocked(printError)
					.mock.calls.map((c) => String(c[0])),
			};
		}

		const noKeyEvent = (n: number) => ({
			id: `msg-${n}`,
			from_agent_id: PEER_ID,
			type: "rine.v1.group_message",
			group_id: "group-1",
			encryption_version: "sender-key-v1",
			encrypted_payload: `AQID${n}`,
		});

		const CLEARTEXT_EVENT = {
			from_agent_id: PEER_ID,
			type: "rine.v1.a2a_message",
			encryption_version: "none",
			// One text part "plain", as the server serves it: unpadded base64url.
			encrypted_payload: "W3sidGV4dCI6ICJwbGFpbiJ9XQ",
			created_at: CREATED_AT,
		};

		it("test_stream_when_the_message_is_a2a_cleartext_then_the_line_says_so_and_nothing_is_decrypted", async () => {
			const line = await previewOf(CLEARTEXT_EVENT);

			expect(line).toContain("[?] [Received as A2A cleartext");
			expect(line).toContain("plain");
			expect(line).not.toContain("[encrypted]");
			expect(mockDecryptDm).not.toHaveBeenCalled();
		});

		it("test_stream_json_when_the_message_is_a2a_cleartext_then_the_envelope_carries_the_flag", async () => {
			const out = captureStdout();
			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				Promise.resolve().then(() => {
					opts.onMessage({
						event: "message",
						data: JSON.stringify(CLEARTEXT_EVENT),
						id: null,
					});
					Promise.resolve().then(() => fireSigint());
				});
				return es;
			}) as any);

			await makeProgram().parseAsync(["node", "rine", "stream", "--json"]);
			out.restore();

			// The lifecycle lines share stdout; the message envelope is the one that carries data.
			const envelope = out.lines
				.map((l) => JSON.parse(l))
				.find((l) => l.event === "message");
			expect(envelope.a2a_cleartext).toBe(true);
			expect(envelope.a2a_cleartext_notice).toContain("not end-to-end encrypted");
		});

		it("decrypts an mls-v1 group message", async () => {
			mockDecryptGroup.mockResolvedValue(decrypted("group-mls-hello"));

			const line = await previewOf({
				from_agent_id: PEER_ID,
				type: "rine.v1.group_message",
				group_id: "group-1",
				group_handle: "team",
				encryption_version: "mls-v1",
				encrypted_payload: "AQID",
				created_at: CREATED_AT,
			});

			// The recovery's own argument order: the client leads, because the
			// ingest-and-retry it wraps is the thing that needs one.
			expect(mockDecryptGroup).toHaveBeenCalledWith(
				expect.anything(),
				"/fake/config",
				"agent-1",
				"group-1",
				"AQID",
				PEER_ID,
				CREATED_AT,
			);
			expect(line).toContain("[\u2713] group-mls-hello");
		});

		it("decrypts an hpke-hybrid-v2 direct message", async () => {
			mockDecryptDm.mockResolvedValue(decrypted("dm-hybrid-hello"));

			const line = await previewOf({
				from_agent_id: PEER_ID,
				type: "rine.v1.dm",
				encryption_version: "hpke-hybrid-v2",
				encrypted_payload: "AwQF",
				created_at: CREATED_AT,
			});

			// The row's own created_at selects the key generation.
			expect(mockDecryptDm).toHaveBeenCalledWith(
				"/fake/config",
				"agent-1",
				"AwQF",
				expect.anything(),
				PEER_ID,
				"agent-1",
				CREATED_AT,
			);
			expect(line).toContain("[\u2713] dm-hybrid-hello");
		});

		it("test_stream_when_the_row_is_a_control_frame_then_the_line_names_its_type_and_shows_no_payload", async () => {
			mockDecryptDm.mockResolvedValue(decrypted("secret-key-bytes"));

			for (const type of ["rine.v1.sender_key_distribution", "rine.v1.group_invite"]) {
				const line = await previewOf({
					from_agent_id: PEER_ID,
					type,
					encryption_version: "hpke-hybrid-v2",
					encrypted_payload: "AwQF",
					created_at: CREATED_AT,
				});

				expect(line).toContain(`[\u2713] [control] ${type}`);
				expect(line).not.toContain("secret-key-bytes");
			}
			expect(vi.mocked(ingestSenderKeyDistribution)).toHaveBeenCalledWith(
				"/fake/config",
				"agent-1",
				"rine.v1.sender_key_distribution",
				expect.anything(),
			);
		});

		it("test_stream_when_hide_control_is_set_then_a_control_frame_is_not_printed_but_is_still_ingested", async () => {
			mockDecryptDm.mockResolvedValue(decrypted("secret-key-bytes"));
			const control = {
				from_agent_id: PEER_ID,
				type: "rine.v1.sender_key_distribution",
				encryption_version: "hpke-hybrid-v2",
				encrypted_payload: "AwQF",
				created_at: CREATED_AT,
			};

			expect(await previewOf(control, "--hide-control")).toBe("");
			expect(vi.mocked(ingestSenderKeyDistribution)).toHaveBeenCalled();

			expect(await previewOf({ ...control, type: "rine.v1.dm" }, "--hide-control")).toContain(
				"secret-key-bytes",
			);
		});

		it("test_stream_when_hide_control_is_set_then_json_omits_a_control_frame_and_keeps_the_rest", async () => {
			const out = captureStdout();
			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				const es = { close: vi.fn() };
				Promise.resolve().then(() => {
					for (const type of ["rine.v1.group_invite", "rine.v1.dm"]) {
						opts.onMessage({ event: "message", data: JSON.stringify({ type }), id: null });
					}
					Promise.resolve().then(() => fireSigint());
				});
				return es;
			}) as any);

			await makeProgram().parseAsync(["node", "rine", "--json", "stream", "--hide-control"]);
			out.restore();

			const messages = out.lines.filter((l) => l.includes('"event":"message"'));
			expect(messages).toHaveLength(1);
			expect(messages[0]).toContain("rine.v1.dm");
		});

		it("names the cause when a sender key never arrived, not just the failure", async () => {
			// The ingest stub answers 0, so the one-shot recovery has run
			// and come back empty — the one decrypt failure a one-line preview
			// can explain. `[decrypt failed]` named neither cause nor move.
			mockDecryptGroup.mockRejectedValue(
				new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}sk-42`),
			);

			const line = await previewOf({
				from_agent_id: PEER_ID,
				type: "rine.v1.group_message",
				group_id: "group-1",
				encryption_version: "sender-key-v1",
				encrypted_payload: "AQID",
			});

			expect(line).toContain(SENDER_KEY_UNAVAILABLE_PREVIEW);
			expect(line).not.toContain("[decrypt failed]");
			// The library's control string is never what the operator reads.
			expect(line).not.toContain("unknown sender key id");
		});

		it("explains the missing sender key once per stream, beside the line", async () => {
			// A stream is a render of many lines, so the paragraph is said
			// once — and NOT inside the message line: this stream is read one
			// message per line by monitors, and a ~600-character sentence spliced
			// into a preview corrupts that for every reader of it.
			mockDecryptGroup.mockRejectedValue(
				new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}sk-42`),
			);

			const { lines, notices } = await previewsOf([
				noKeyEvent(1),
				noKeyEvent(2),
				noKeyEvent(3),
			]);

			// Every line carries the bounded marker and nothing longer.
			expect(lines).toHaveLength(3);
			for (const line of lines) {
				expect(line).toContain(SENDER_KEY_UNAVAILABLE_PREVIEW);
				expect(line).not.toContain("Ask the sender to post to the group");
			}
			// The explanation was given once, on its own channel, and names the key.
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("sk-42");
			expect(notices[0]).toContain("Ask the sender to post to the group again");
			expect(notices[0]).not.toContain("unknown sender key id");
		});

		it("hands every marked line the id its own remedy needs", async () => {
			// The marker promises the full sentence is one `rine message read`
			// away. Without the id on the line, an operator who scrolled past the
			// once-per-stream notice had to run `rine message list` and correlate
			// by timestamp and sender to find out which row it was — three steps
			// and a guess, on the only MULTI surface that did not carry an id.
			mockDecryptGroup.mockRejectedValue(
				new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}sk-42`),
			);

			const { lines } = await previewsOf([noKeyEvent(1), noKeyEvent(2)]);

			expect(lines[0]).toContain("rine message read msg-1");
			expect(lines[1]).toContain("rine message read msg-2");
			// Still bounded: the id is ~40 characters, not the ~600-character
			// paragraph the marker exists to keep off the line.
			for (const line of lines) {
				expect(line).not.toContain("Ask the sender to post to the group");
			}
		});

		it("does not re-explain the missing sender key on a later event", async () => {
			// The assertion that catches a per-EVENT explainer: with one, every
			// unopenable message in a long-running stream repeats the paragraph.
			mockDecryptGroup.mockRejectedValue(
				new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}sk-42`),
			);

			const { notices } = await previewsOf([noKeyEvent(1), noKeyEvent(2)]);

			expect(notices).toHaveLength(1);
		});

		it("reports [decrypt failed] when an mls-v1 group message cannot be decrypted", async () => {
			mockDecryptGroup.mockRejectedValue(new Error("No MLS state for group"));

			const line = await previewOf({
				from_agent_id: PEER_ID,
				type: "rine.v1.group_message",
				group_id: "group-1",
				encryption_version: "mls-v1",
				encrypted_payload: "AQID",
			});

			expect(line).toContain("[decrypt failed]");
			expect(line).not.toContain("[encrypted]");
		});

		it("reports [decrypt failed] when an hpke-hybrid-v2 message cannot be decrypted", async () => {
			mockDecryptDm.mockRejectedValue(new Error("no PQ encryption key"));

			const line = await previewOf({
				from_agent_id: PEER_ID,
				type: "rine.v1.dm",
				encryption_version: "hpke-hybrid-v2",
				encrypted_payload: "AwQF",
			});

			expect(line).toContain("[decrypt failed]");
			expect(line).not.toContain("[encrypted]");
		});

		it("never previews content signed by someone other than the event's sender", async () => {
			mockDecryptDm.mockResolvedValue({
				plaintext: "authentic content of another agent",
				senderKid: "rine:someone-else",
				verified: false,
				verificationStatus: "sender-mismatch",
			} as unknown as Awaited<ReturnType<typeof decryptMessage>>);

			const line = await previewOf({
				from_agent_id: PEER_ID,
				type: "rine.v1.dm",
				encryption_version: "hpke-hybrid-v2",
				encrypted_payload: "AwQF",
			});

			expect(line).toContain("sender mismatch");
			expect(line).not.toContain("authentic content of another agent");
		});

		it("leaves an event with no server-authenticated sender sealed", async () => {
			const line = await previewOf({
				type: "rine.v1.dm",
				encryption_version: "hpke-hybrid-v2",
				encrypted_payload: "AwQF",
			});

			expect(line).toContain("[encrypted]");
			expect(mockDecryptDm).not.toHaveBeenCalled();
		});

		// Which versions the preview tries to open, and what a failed open prints.
		it.each([
			["hpke-hybrid-v2", undefined, "dm", "[decrypt failed]"],
			["sender-key-v1", "group-1", "group", "[decrypt failed]"],
			["mls-v1", "group-1", "group", "[decrypt failed]"],
			["sender-key-v1", undefined, "none", "[decrypt failed]"],
			["mls-v1", undefined, "none", "[decrypt failed]"],
			["hpke-v1", undefined, "none", "[encrypted]"],
			["none", undefined, "none", "[encrypted]"],
			[undefined, undefined, "none", "[encrypted]"],
		])(
			"a failed open of version %s (group %s) goes to the %s decrypt and prints %s",
			async (version, groupId, decrypt, preview) => {
				mockDecryptDm.mockRejectedValue(new Error("cannot open"));
				mockDecryptGroup.mockRejectedValue(new Error("cannot open"));

				const line = await previewOf({
					from_agent_id: PEER_ID,
					type: "rine.v1.dm",
					group_id: groupId,
					encryption_version: version,
					encrypted_payload: "AwQF",
				});

				expect(line.endsWith(`: ${preview}`)).toBe(true);
				expect(mockDecryptDm).toHaveBeenCalledTimes(decrypt === "dm" ? 1 : 0);
				expect(mockDecryptGroup).toHaveBeenCalledTimes(decrypt === "group" ? 1 : 0);
			},
		);

		it("leaves an unsupported encryption version as [encrypted]", async () => {
			const line = await previewOf({
				from_agent_id: PEER_ID,
				type: "rine.v1.dm",
				encryption_version: "hpke-org-v1",
				encrypted_payload: "AwQF",
			});

			expect(line).toContain("[encrypted]");
			expect(mockDecryptDm).not.toHaveBeenCalled();
			expect(mockDecryptGroup).not.toHaveBeenCalled();
		});
	});
	describe("delivery acknowledgement", () => {
		const mockAgentKeysExist = vi.mocked(agentKeysExist);
		const mockDecryptDm = vi.mocked(decryptMessage);
		const mockDecryptGroup = vi.mocked(decryptGroupMessageWithRecovery);
		const PEER_ID = "22222222-2222-2222-2222-222222222222";

		const groupEvent = (id: string) => ({
			...dmEvent(id),
			type: "rine.v1.group_message",
			group_id: "group-1",
			encryption_version: "mls-v1",
		});

		const dmEvent = (id: string) => ({
			id,
			from_agent_id: PEER_ID,
			type: "rine.v1.dm",
			encryption_version: "hpke-hybrid-v2",
			encrypted_payload: "AwQF",
			created_at: CREATED_AT,
		});

		const opened = (verificationStatus: string, plaintext = "hello") =>
			({
				plaintext,
				senderKid: "agent-2:sig",
				verified: verificationStatus === "verified",
				verificationStatus,
			}) as unknown as Awaited<ReturnType<typeof decryptMessage>>;

		beforeEach(() => {
			markDelivered.mockReset();
			markDelivered.mockResolvedValue(undefined);
			mockAgentKeysExist.mockReset();
			mockAgentKeysExist.mockReturnValue(true);
			mockDecryptDm.mockReset();
			mockDecryptGroup.mockReset();
		});

		afterEach(() => {
			mockAgentKeysExist.mockReset();
			mockAgentKeysExist.mockReturnValue(false);
			mockDecryptDm.mockReset();
			mockDecryptGroup.mockReset();
		});

		const drain = async () => {
			for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
		};

		/** Streams the frames, optionally checks mid-stream, then stops with a signal. */
		async function streamFrames(
			frames: Array<{ event: string; data: string; id?: string | null }>,
			args: string[] = [],
			midStream?: () => void,
			signal: StopSignal = "SIGINT",
		): Promise<{ stdout: string[]; stderr: string[]; headers: Record<string, string>[] }> {
			const out = captureStdout();
			const err = captureStderr();
			const headers: Record<string, string>[] = [];
			mockCreateEventSource.mockImplementationOnce(((opts: any) => {
				headers.push(opts.headers);
				Promise.resolve().then(async () => {
					for (const f of frames) {
						opts.onMessage({ id: null, ...f });
						await drain();
					}
					midStream?.();
					fireSignal(signal);
				});
				return { close: vi.fn() };
			}) as any);
			await makeProgram().parseAsync(["node", "rine", ...args, "stream"]);
			await drain();
			out.restore();
			err.restore();
			return { stdout: out.lines, stderr: err.lines, headers };
		}

		const message = (payload: Record<string, unknown>) => ({
			event: "message",
			data: JSON.stringify(payload),
		});

		it.each([[[]], [["--json"]]])("connects with the peek header (%j)", async (args) => {
			const { headers } = await streamFrames([], args);
			expect(headers[0]?.[PEEK_HEADER]).toBe("1");
		});

		it.each([["human", []], ["json", ["--json"]]])(
			"acks an opened frame and not an undecryptable one (%s)",
			async (_mode, args) => {
				mockDecryptDm.mockResolvedValueOnce(opened("verified"));
				mockDecryptDm.mockRejectedValueOnce(new Error("no key"));
				await streamFrames(
					[message(dmEvent("opened")), message(dmEvent("locked"))],
					args,
				);
				expect(markDelivered).toHaveBeenCalledTimes(1);
				expect(markDelivered).toHaveBeenCalledWith("agent-1", ["opened"], {
					[ACTING_AGENT_HEADER]: "agent-1",
				});
			},
		);

		it("acks a frame whose sender signature failed", async () => {
			mockDecryptDm.mockResolvedValueOnce(opened("sender-mismatch", ""));
			await streamFrames([message(dmEvent("forged"))]);
			expect(markDelivered).toHaveBeenCalledWith("agent-1", ["forged"], expect.anything());
		});

		it.each([
			["invalid", "[✗ invalid signature]"],
			["sender-mismatch", "[✗ sender mismatch]"],
		] as const)(
			"acks a group frame whose author was refused (%s) and prints the verdict",
			async (status, label) => {
				mockDecryptGroup.mockRejectedValueOnce(new GroupAuthenticityError(status));
				const { stdout } = await streamFrames([message(groupEvent("forged"))]);

				expect(markDelivered).toHaveBeenCalledWith("agent-1", ["forged"], expect.anything());
				expect(stdout.join("\n")).toContain(label);
			},
		);

		it("does not ack a group frame that failed to decrypt for any other reason", async () => {
			mockDecryptGroup.mockRejectedValueOnce(new Error("No MLS state for group"));
			await streamFrames([message(groupEvent("locked"))]);

			expect(markDelivered).not.toHaveBeenCalled();
		});

		it("acks a cleartext frame without any local keys", async () => {
			mockAgentKeysExist.mockReturnValue(false);
			await streamFrames([
				message({ ...dmEvent("plain"), encryption_version: "none" }),
			]);
			expect(markDelivered).toHaveBeenCalledWith("agent-1", ["plain"], expect.anything());
		});

		it("does not ack a sealed frame when there are no local keys", async () => {
			mockAgentKeysExist.mockReturnValue(false);
			await streamFrames([message(dmEvent("sealed"))]);
			expect(markDelivered).not.toHaveBeenCalled();
		});

		it("does not ack a frame that is not an envelope", async () => {
			await streamFrames([{ event: "message", data: "not json" }]);
			expect(markDelivered).not.toHaveBeenCalled();
		});

		it("flushes the batch on a heartbeat, before the stream ends", async () => {
			mockDecryptDm.mockResolvedValue(opened("verified"));
			let ackedBeforeEnd = 0;
			await streamFrames(
				[message(dmEvent("a")), { event: "heartbeat", data: "{}" }],
				[],
				() => {
					ackedBeforeEnd = markDelivered.mock.calls.length;
				},
			);
			expect(ackedBeforeEnd).toBe(1);
		});

		it("keeps --json stdout byte for byte what the previous release printed", async () => {
			// Recorded by running this scenario against `git archive master`.
			const recorded: string[] = JSON.parse(
				readFileSync(
					new URL("./fixtures/stream-json-stdout.json", import.meta.url),
					"utf8",
				),
			);
			mockDecryptDm.mockResolvedValueOnce(opened("verified"));
			mockDecryptDm.mockRejectedValueOnce(new Error("no key"));
			const cleartext = {
				from_agent_id: PEER_ID,
				type: "rine.v1.a2a_message",
				encryption_version: "none",
				encrypted_payload: "W3sidGV4dCI6ICJwbGFpbiJ9XQ",
				created_at: CREATED_AT,
			};

			const { stdout } = await streamFrames(
				[
					{ ...message(dmEvent("raw")), id: "evt-1" },
					{ event: "heartbeat", data: "{}", id: null },
					{ ...message(dmEvent("locked")), id: "evt-2" },
					{ ...message(cleartext), id: "evt-3" },
					{ event: "message", data: "not json", id: "evt-4" },
				],
				["--json"],
			);

			expect(stdout).toEqual(recorded);
		});

		it("acks an A2A cleartext row whose body cannot be decoded, without a preview", async () => {
			mockAgentKeysExist.mockReturnValue(false);
			vi.mocked(a2aCleartextPlaintext).mockImplementationOnce(() => {
				throw new Error("not text");
			});
			const { stdout } = await streamFrames([
				message({
					...dmEvent("odd"),
					type: "rine.v1.a2a_message",
					encryption_version: "none",
					encrypted_payload: "W3sidGV4dCI6ICJwbGFpbiJ9XQ",
				}),
			]);

			expect(markDelivered).toHaveBeenCalledWith("agent-1", ["odd"], expect.anything());
			expect(stdout.filter((l) => l.includes("[message]"))).toEqual([]);
		});

		it("flushes the batch on SIGTERM as it does on SIGINT", async () => {
			mockDecryptDm.mockResolvedValue(opened("verified"));
			await streamFrames([message(dmEvent("a"))], [], undefined, "SIGTERM");
			expect(markDelivered).toHaveBeenCalledWith("agent-1", ["a"], expect.anything());
		});

		it("waits for a row still being opened before it sends the last batch", async () => {
			let release: () => void = () => {};
			mockDecryptDm.mockReturnValueOnce(
				new Promise((resolve) => {
					release = () => resolve(opened("verified"));
				}),
			);
			await streamFrames([message(dmEvent("late"))], [], () => {
				setTimeout(release, 20);
			});
			expect(markDelivered).toHaveBeenCalledWith("agent-1", ["late"], expect.anything());
		});

		describe("stopping promptly", () => {
			const stuckDecrypt = () =>
				mockDecryptDm.mockReturnValueOnce(new Promise(() => {}));

			beforeEach(() => {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			});

			afterEach(() => {
				vi.useRealTimers();
				vi.restoreAllMocks();
			});

			/** Runs the command until `settled` flips, advancing fake time by `ms` once the signal is out. */
			const runUntilStopped = async (
				start: () => Promise<unknown>,
				signal: () => void,
			) => {
				let settled = false;
				const run = start().then(() => {
					settled = true;
				});
				await drain();
				signal();
				await drain();
				return { run, isSettled: () => settled };
			};

			it("cuts the reconnect backoff short when a signal arrives", async () => {
				mockCreateEventSource.mockImplementationOnce((() => {
					throw new Error("connection refused");
				}) as any);
				const err = captureStderr();
				const { run, isSettled } = await runUntilStopped(
					() => makeProgram().parseAsync(["node", "rine", "stream"]),
					() => fireSignal("SIGTERM"),
				);
				err.restore();

				// No fake time has passed: only the signal can have ended the backoff.
				expect(isSettled()).toBe(true);
				await run;
			});

			it("cuts the heartbeat-timeout backoff short when a signal arrives", async () => {
				mockCreateEventSource.mockImplementationOnce((() => ({ close: vi.fn() })) as any);
				const err = captureStderr();
				let settled = false;
				const run = makeProgram()
					.parseAsync(["node", "rine", "stream", "--heartbeat-timeout", "10"])
					.then(() => {
						settled = true;
					});
				await drain();
				await vi.advanceTimersByTimeAsync(10_000);
				await drain();
				expect(settled).toBe(false);
				fireSignal("SIGTERM");
				await drain();
				err.restore();

				// The backoff is 500 to 1500 ms and none of it has passed.
				expect(settled).toBe(true);
				await run;
			});

			it("stops waiting for a row still being opened after two seconds", async () => {
				stuckDecrypt();
				mockCreateEventSource.mockImplementationOnce(((opts: any) => {
					opts.onMessage({ event: "message", data: JSON.stringify(dmEvent("stuck")), id: null });
					return { close: vi.fn() };
				}) as any);
				const { run, isSettled } = await runUntilStopped(
					() => makeProgram().parseAsync(["node", "rine", "stream"]),
					() => fireSignal("SIGINT"),
				);

				await vi.advanceTimersByTimeAsync(1900);
				expect(isSettled()).toBe(false);
				await vi.advanceTimersByTimeAsync(200);
				await run;
				expect(isSettled()).toBe(true);
			});

			it("exits at once on a second signal", async () => {
				stuckDecrypt();
				mockCreateEventSource.mockImplementationOnce(((opts: any) => {
					opts.onMessage({ event: "message", data: JSON.stringify(dmEvent("stuck")), id: null });
					return { close: vi.fn() };
				}) as any);
				const { run } = await runUntilStopped(
					() => makeProgram().parseAsync(["node", "rine", "stream"]),
					() => fireSignal("SIGINT"),
				);
				expect(exit).not.toHaveBeenCalled();

				fireSignal("SIGTERM");

				expect(exit).toHaveBeenCalledWith(0);
				await vi.advanceTimersByTimeAsync(2100);
				await run;
			});
		});

		it("ends the process with its status once the close has run", async () => {
			mockDecryptDm.mockResolvedValue(opened("verified"));
			await streamFrames([message(dmEvent("a"))]);

			expect(markDelivered).toHaveBeenCalledWith("agent-1", ["a"], expect.anything());
			expect(exit).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledWith(0);
			expect(exit.mock.invocationCallOrder[0]).toBeGreaterThan(
				markDelivered.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
			);
		});

		describe("exit after the close", () => {
			let flush: (() => void) | undefined;

			beforeEach(() => {
				flush = undefined;
				captureStderr();
				// A full pipe: the write is queued and its callback waits for the reader.
				vi.spyOn(process.stdout, "write").mockImplementation(((...args: unknown[]) => {
					const done = args.at(-1);
					if (typeof done === "function") flush = done as () => void;
					return false;
				}) as never);
			});

			it("waits for stdout to flush before ending the process", async () => {
				const ended = exitWhenFlushed(0);
				await Promise.resolve();

				expect(exit).not.toHaveBeenCalled();
				flush?.();
				await ended;
				expect(exit).toHaveBeenCalledWith(0);
			});

			it("ends the process anyway once a stalled reader outlasts the wait", async () => {
				vi.useFakeTimers();
				const ended = exitWhenFlushed(1, 50);
				await vi.advanceTimersByTimeAsync(49);
				expect(exit).not.toHaveBeenCalled();

				await vi.advanceTimersByTimeAsync(1);
				await ended;
				expect(exit).toHaveBeenCalledWith(1);
				vi.useRealTimers();
			});
		});

		it("reports a failed ack once, on stderr, and keeps streaming", async () => {
			mockDecryptDm.mockResolvedValue(opened("verified"));
			markDelivered.mockRejectedValue(new Error("503"));
			const { stderr } = await streamFrames([
				message(dmEvent("a")),
				message(dmEvent("b")),
			]);
			const warnings = stderr.filter((l) => l.includes("could not mark"));
			expect(warnings).toEqual([
				"rine: could not mark 2 message(s) delivered; they may be shown again (503)\n",
			]);
			expect(process.exitCode).not.toBe(1);
		});
	});
});
