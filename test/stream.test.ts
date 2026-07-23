import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("eventsource-client", () => ({
	createEventSource: vi.fn(),
}));

vi.mock("@rine-network/core", () => ({
	resolveConfigDir: vi.fn(() => "/fake/config"),
	resolveApiUrl: vi.fn(() => "http://localhost:7001"),
	fetchAgents: vi.fn(async () => [{ id: "agent-1", name: "bot" }]),
	resolveAgent: vi.fn(async () => "agent-1"),
	getOrRefreshToken: vi.fn(async () => "fake-token"),
	jitteredRefreshMargin: vi.fn(() => 60),
	formatError: vi.fn((e: unknown) => String(e)),
	agentKeysExist: vi.fn(() => false),
	ingestSenderKeyDistribution: vi.fn(),
	decryptMessage: vi.fn(),
	decryptGroupMessage: vi.fn(),
}));

vi.mock("../src/action.js", () => ({
	createClient: vi.fn(async () => ({
		client: { get: vi.fn(), post: vi.fn() },
		profileName: "default",
		entry: { client_id: "c", client_secret: "s" },
	})),
}));

vi.mock("../src/output.js", () => ({
	printError: vi.fn(),
}));

vi.mock("../src/commands/sender-key-ops.js", () => ({
	fetchAndIngestPendingSKDistributions: vi.fn(async () => 0),
}));

vi.mock("../src/commands/stream-cursor.js", () => ({
	loadStreamCursor: vi.fn(() => undefined),
	saveStreamCursor: vi.fn(),
}));

import { createEventSource } from "eventsource-client";
import { Command } from "commander";
import { registerStream } from "../src/commands/stream.js";
import {
	agentKeysExist,
	decryptGroupMessage,
	decryptMessage,
} from "@rine-network/core";
import { loadStreamCursor, saveStreamCursor } from "../src/commands/stream-cursor.js";

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
		return true;
	});
	return { lines, restore: () => mock.mockRestore() };
}

type SigintHandler = (...args: unknown[]) => void;

describe("rine stream", () => {
	let sigintListeners: SigintHandler[];

	function fireSigint(): void {
		for (const l of [...sigintListeners]) l();
	}

	function installSigintCapture(): void {
		sigintListeners = [];
		vi.spyOn(process, "on").mockImplementation(((event: string, listener: SigintHandler) => {
			if (event === "SIGINT") sigintListeners.push(listener);
			return process;
		}) as typeof process.on);
		vi.spyOn(process, "once").mockImplementation(((event: string, listener: SigintHandler) => {
			if (event === "SIGINT") sigintListeners.push(listener);
			return process;
		}) as typeof process.once);
	}

	function makeMockEs(onCreated?: (opts: any, es: any) => void): any {
		return (opts: any) => {
			const es = { close: vi.fn() };
			onCreated?.(opts, es);
			return es;
		};
	}

	beforeEach(() => {
		installSigintCapture();
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
			expect(reconnecting.data.backoff_ms).toBe(0);
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
		const mockDecryptGroup = vi.mocked(decryptGroupMessage);
		const mockDecryptDm = vi.mocked(decryptMessage);

		const decrypted = (plaintext: string) =>
			({
				plaintext,
				senderKid: "agent-2:sig",
				verified: true,
				verificationStatus: "verified",
			}) as unknown as Awaited<ReturnType<typeof decryptMessage>>;

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

		async function previewOf(payload: Record<string, unknown>): Promise<string> {
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
			await program.parseAsync(["node", "rine", "stream"]);
			// The preview is formatted asynchronously and can settle after the
			// SIGINT-terminated loop returns — drain the queue before asserting.
			for (let i = 0; i < 5; i++) {
				await new Promise((r) => setImmediate(r));
			}
			out.restore();
			stderr.restore();

			return out.lines.join("\n");
		}

		it("decrypts an mls-v1 group message", async () => {
			mockDecryptGroup.mockResolvedValue(decrypted("group-mls-hello"));

			const line = await previewOf({
				type: "rine.v1.group_message",
				group_id: "group-1",
				group_handle: "team",
				encryption_version: "mls-v1",
				encrypted_payload: "AQID",
			});

			expect(mockDecryptGroup).toHaveBeenCalledWith(
				"/fake/config",
				"agent-1",
				"group-1",
				"AQID",
				expect.anything(),
			);
			expect(line).toContain("[\u2713] group-mls-hello");
		});

		it("decrypts an hpke-hybrid-v1 direct message", async () => {
			mockDecryptDm.mockResolvedValue(decrypted("dm-hybrid-hello"));

			const line = await previewOf({
				type: "rine.v1.dm",
				encryption_version: "hpke-hybrid-v1",
				encrypted_payload: "AwQF",
			});

			expect(mockDecryptDm).toHaveBeenCalledWith(
				"/fake/config",
				"agent-1",
				"AwQF",
				expect.anything(),
			);
			expect(line).toContain("[\u2713] dm-hybrid-hello");
		});

		it("reports [decrypt failed] when an mls-v1 group message cannot be decrypted", async () => {
			mockDecryptGroup.mockRejectedValue(new Error("No MLS state for group"));

			const line = await previewOf({
				type: "rine.v1.group_message",
				group_id: "group-1",
				encryption_version: "mls-v1",
				encrypted_payload: "AQID",
			});

			expect(line).toContain("[decrypt failed]");
			expect(line).not.toContain("[encrypted]");
		});

		it("reports [decrypt failed] when an hpke-hybrid-v1 message cannot be decrypted", async () => {
			mockDecryptDm.mockRejectedValue(new Error("no PQ encryption key"));

			const line = await previewOf({
				type: "rine.v1.dm",
				encryption_version: "hpke-hybrid-v1",
				encrypted_payload: "AwQF",
			});

			expect(line).toContain("[decrypt failed]");
			expect(line).not.toContain("[encrypted]");
		});

		it("leaves an unsupported encryption version as [encrypted]", async () => {
			const line = await previewOf({
				type: "rine.v1.dm",
				encryption_version: "hpke-org-v1",
				encrypted_payload: "AwQF",
			});

			expect(line).toContain("[encrypted]");
			expect(mockDecryptDm).not.toHaveBeenCalled();
			expect(mockDecryptGroup).not.toHaveBeenCalled();
		});
	});
});
