// The long-lived `rine relay` daemon. Structured on
// stream.ts (NOT withClient): builds its client with createClient, resolves the
// agent, installs a SIGINT handler that flips stopped=true + exitCode=0, and
// runs a while(!stopped) reconnect loop with jittered backoff capped at 30s and
// in-loop token refresh. At startup / each reconnect it orchestrates the four
// subsystems IN ORDER: (1) cert provision/renew → (2) control WS +
// mux tunnel → (3) local TLS-terminating listener → (4) per-request
// verify/encrypt/post (owned by relay-adapter). Lifecycle events
// mirror stream.ts emitLifecycle and NEVER carry a body.
//
// FROZEN-CONTRACT: the relay is CLI-only (never an MCP tool); the cert key stays
// local (DNS-01 only); the relay calls the cert/tunnel entry points — it
// contains no inline ACME, no inline mux framing, no server crypto.
//
// All externals are MOCKED (the @rine-network/core boundary incl. the funnel
// cert/tunnel/relay-adapter surfaces, createClient, node:tls). The command
// module `../src/commands/relay.js` does NOT exist yet (Track E creates it);
// these MUST fail now for the right reason (missing module / missing export).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
// Zero-trust hostname: TWO labels under `.hook.rine.network` — the per-hook
// label (`github`) then the per-AGENT base32-UUID label, so the
// relay keys its cert cache by the second-to-last label (the agent label), and
// ONE `*.{agentLabel}.hook` wildcard covers every hook of the agent. The agent
// label here is `agent_label(11111111-…)` (Crockford base32 of the UUID bytes).
const AGENT_LABEL = "0h248h248h248h248h248h248h";
const HOSTNAME = `github.${AGENT_LABEL}.hook.rine.network`;
// The broker control-WS endpoint the server returns in the hook row. The relay
// MUST dial this VERBATIM — NOT a value synthesized from the API base (which
// resolves to the primary IP / Caddy, with no funnel route).
const CONTROL_WS_URL = "wss://funnel.rine.network/_funnel/v1";

// Mirror the production funnel contracts so the mock call-argument tuples are
// typed (NOT the inferred `[]`) and the onClose callback matches TunnelHandle.
type CertArgs = { handle: string; options?: { staging?: boolean } };
type CertResult = {
	ready: boolean;
	fromCache: boolean;
	certPem: string;
	keyPem: string;
	meta: Record<string, unknown>;
};
type TunnelArgs = { hostname: string; controlWsUrl: string };
type TunnelClose = { code: number; clean: boolean };
type TunnelHandle = {
	close: () => void;
	onClose: (cb: (close: TunnelClose) => void) => void;
};

// Track the ORDER in which the orchestration steps run.
const orchestrationOrder: string[] = [];

const mockEnsureCert = vi.fn(async (_args: CertArgs): Promise<CertResult> => {
	orchestrationOrder.push("cert");
	return {
		ready: true,
		fromCache: false,
		certPem: "CERT",
		keyPem: "KEY",
		meta: {},
	};
});
const mockConnectTunnel = vi.fn(
	async (_args: TunnelArgs): Promise<TunnelHandle> => {
		orchestrationOrder.push("tunnel");
		return { close: vi.fn(), onClose: vi.fn() };
	},
);
const mockStartTlsListener = vi.fn(async () => {
	orchestrationOrder.push("listener");
	return { close: vi.fn(), port: 8443 };
});
const mockAgentKeysExist = vi.fn(() => true);
// The persisted HMAC secret the relay resolves at startup. Default: a real secret
// so the orchestration tests run; the empty-secret fail-closed test overrides
// it to "" to exercise the refuse-to-start guard.
const mockLoadHookSecret = vi.fn<() => string | undefined>(() => "hook-secret");

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveConfigDir: vi.fn(() => "/fake/config"),
		resolveApiUrl: vi.fn(() => "http://localhost:7001"),
		fetchAgents: vi.fn(async () => [{ id: AGENT_ID, name: "bot" }]),
		resolveAgent: vi.fn(async () => ({ agentId: AGENT_ID })),
		getOrRefreshToken: vi.fn(async () => "fake-token"),
		formatError: vi.fn((e: unknown) => String(e)),
		loadHookSecret: (...a: unknown[]) => mockLoadHookSecret(...(a as [])),
		agentKeysExist: (...a: unknown[]) => mockAgentKeysExist(...(a as [])),
		buildIssueCertDeps: vi.fn(async () => ({})),
		ensureCert: (...a: unknown[]) => mockEnsureCert(...(a as [CertArgs])),
		nextBackoffDelayMs: vi.fn(() => 1000),
		// The standing renewal re-check reads cert meta and the per-agent
		// jittered renewal trigger. Default: a far-future cert that is
		// never due, so the timer never fires an overlapping ensureCert in these tests.
		loadMeta: vi.fn(() => ({ not_after: "2099-01-01T00:00:00Z" })),
		renewalDueWithJitter: vi.fn(() => false),
		// `agentLabel` is the SOLE deriver of the per-agent cert-cache key — keep the
		// REAL implementation so the regression asserts the real label extraction
		// from the server hostname (the second-to-last label before `.hook.…`).
		agentLabel: orig.agentLabel,
		// The mux tunnel + local TLS listener are re-exported from the rine-core
		// package ROOT (src/index.ts → export * from "./funnel/index.js"), so the
		// relay command imports them from "@rine-network/core" — mock them here.
		connectTunnel: (...a: unknown[]) =>
			mockConnectTunnel(...(a as [TunnelArgs])),
		startTlsListener: (...a: unknown[]) => mockStartTlsListener(...(a as [])),
	};
});

// The relay asserts the per-agent wildcard A resolves before declaring the
// listener ready; default to a present A so the happy path proceeds.
vi.mock("node:dns/promises", () => ({
	resolve4: vi.fn(async () => ["203.0.113.7"]),
}));

// The relay resolves the SERVER-allocated hook row from the funnel-hooks list
// (the single source of truth for the cert CN/SAN + the BIND + the broker
// control-WS URL + the termination tier), so the mock client must return a hook
// row whose hostname is the real two-label zero-trust `.hook` shape, carries the
// server `control_ws_url`, AND declares `termination: zero_trust` — the exact
// values the relay binds, issues the cert for, dials, and tier-branches on.
vi.mock("../src/action.js", () => ({
	createClient: vi.fn(async () => ({
		client: {
			get: vi.fn(async () => ({
				items: [
					{
						hook_name: "default",
						hostname: HOSTNAME,
						active: true,
						created_at: "2026-06-13T00:00:00Z",
						control_ws_url: CONTROL_WS_URL,
						termination: "zero_trust",
					},
				],
			})),
			post: vi.fn(),
		},
		profileName: "default",
		entry: { client_id: "c", client_secret: "s" },
	})),
}));

import { Command } from "commander";
import { registerRelay } from "../src/commands/relay.js";

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json");
	program.option("--profile <name>");
	program.option("--as <handle>");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerRelay(program);
	return program;
}

type SigintHandler = (...args: unknown[]) => void;
let sigintListeners: SigintHandler[];

function fireSigint(): void {
	for (const l of [...sigintListeners]) l();
}

function installSigintCapture(): void {
	sigintListeners = [];
	vi.spyOn(process, "on").mockImplementation(((
		event: string,
		listener: SigintHandler,
	) => {
		if (event === "SIGINT") sigintListeners.push(listener);
		return process;
	}) as typeof process.on);
	vi.spyOn(process, "once").mockImplementation(((
		event: string,
		listener: SigintHandler,
	) => {
		if (event === "SIGINT") sigintListeners.push(listener);
		return process;
	}) as typeof process.once);
}

function captureStdout(): { lines: string[] } {
	const lines: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
		lines.push(args.map(String).join(" ")),
	);
	return { lines };
}

beforeEach(() => {
	installSigintCapture();
	orchestrationOrder.length = 0;
	process.exitCode = undefined;
	mockEnsureCert.mockClear();
	mockConnectTunnel.mockClear();
	mockStartTlsListener.mockClear();
	mockAgentKeysExist.mockReturnValue(true);
	mockLoadHookSecret.mockReturnValue("hook-secret");
	vi.spyOn(console, "error").mockImplementation(() => {});
	// The tunnel connect fires its onClose to make the loop tick once then SIGINT.
	mockConnectTunnel.mockImplementation(async () => {
		orchestrationOrder.push("tunnel");
		Promise.resolve().then(() => fireSigint());
		return {
			close: vi.fn(),
			onClose: (cb: (c: TunnelClose) => void) =>
				cb({ code: 1000, clean: true }),
		};
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

// ── flags + SIGINT clean exit ───────────────────────────────────────────────

describe("rine relay — command shape & flags", () => {
	it("registers a flat `relay` command with the documented flags", () => {
		const program = makeProgram();
		const relay = program.commands.find((c) => c.name() === "relay");
		expect(relay).toBeDefined();
		const flags = relay?.options.map((o) => o.long);
		expect(flags).toEqual(
			expect.arrayContaining([
				"--agent",
				"--hook",
				"--port",
				"--secret-file",
				"--secret-env",
				"--staging",
			]),
		);
	});

	it("SIGINT exits with code 0 after a clean teardown", async () => {
		const program = makeProgram({});
		await program.parseAsync(["node", "rine", "relay", "--agent", AGENT_ID]);
		expect(process.exitCode).toBe(0);
	});
});

describe("rine relay — fatal startup gates (edge cases)", () => {
	it("fails with exit code 2 when the agent's identity keys are absent (no loop entry)", async () => {
		mockAgentKeysExist.mockReturnValue(false);
		const program = makeProgram({});
		await program.parseAsync(["node", "rine", "relay", "--agent", AGENT_ID]);
		expect(process.exitCode).toBe(2);
		// Never even attempts to provision a cert / open a tunnel.
		expect(mockEnsureCert).not.toHaveBeenCalled();
		expect(mockConnectTunnel).not.toHaveBeenCalled();
	});

	it("refuses to start (exit 2, no listener/tunnel) when no HMAC secret resolves (fail-closed)", async () => {
		// No --secret-env / --secret-file and nothing persisted ⇒ empty secret.
		mockLoadHookSecret.mockReturnValue(undefined);
		const program = makeProgram({});
		await program.parseAsync(["node", "rine", "relay", "--agent", AGENT_ID]);
		expect(process.exitCode).toBe(2);
		// A fail-OPEN relay would still provision/listen; this must NOT.
		expect(mockEnsureCert).not.toHaveBeenCalled();
		expect(mockConnectTunnel).not.toHaveBeenCalled();
		expect(mockStartTlsListener).not.toHaveBeenCalled();
	});
});

// ── orchestration order ─────────────────────────────────────────────────────

describe("rine relay — startup orchestration order", () => {
	it("provisions the cert, THEN opens the tunnel, THEN starts the local TLS listener", async () => {
		const program = makeProgram({});
		await program.parseAsync(["node", "rine", "relay", "--agent", AGENT_ID]);
		const idxCert = orchestrationOrder.indexOf("cert");
		const idxTunnel = orchestrationOrder.indexOf("tunnel");
		const idxListener = orchestrationOrder.indexOf("listener");
		expect(idxCert).toBeGreaterThanOrEqual(0);
		expect(idxCert).toBeLessThan(idxTunnel);
		expect(idxTunnel).toBeLessThan(idxListener);
	});

	it("forwards --staging into the cert flow", async () => {
		const program = makeProgram({});
		await program.parseAsync([
			"node",
			"rine",
			"relay",
			"--agent",
			AGENT_ID,
			"--staging",
		]);
		// ensureCert is invoked with options carrying staging:true.
		const call = mockEnsureCert.mock.calls[0]?.[0] as
			| { options?: { staging?: boolean } }
			| undefined;
		expect(call?.options).toMatchObject({ staging: true });
	});

	it("issues the cert for the SERVER hostname's AGENT LABEL, not the agent UUID", async () => {
		const program = makeProgram({});
		await program.parseAsync(["node", "rine", "relay", "--agent", AGENT_ID]);
		// The cert handle must be the AGENT label — the second-to-last DNS label of
		// the zero-trust hostname (`{hook}.{agentLabel}.hook.rine.network`) — so the
		// per-agent `*.{agentLabel}.hook` wildcard covers GitHub's TLS SNI and ONE
		// cert serves every hook of the agent. NEVER the raw UUID
		// (the relay reads the opaque label off the hostname, never re-encodes it).
		const certCall = mockEnsureCert.mock.calls[0]?.[0] as
			| { handle?: string }
			| undefined;
		expect(certCall?.handle).toBe(AGENT_LABEL);
		expect(certCall?.handle).not.toBe(AGENT_ID);
		// And the tunnel BINDs the full server hostname verbatim AND dials the
		// server-returned control_ws_url verbatim — NOT a value synthesized from
		// the API base (which has no funnel route).
		const tunnelCall = mockConnectTunnel.mock.calls[0]?.[0] as
			| { hostname?: string; controlWsUrl?: string }
			| undefined;
		expect(tunnelCall?.hostname).toBe(HOSTNAME);
		expect(tunnelCall?.controlWsUrl).toBe(CONTROL_WS_URL);
		// It must NOT reconstruct the WS URL from the API base (localhost:7001).
		expect(tunnelCall?.controlWsUrl).not.toMatch(/localhost|7001/);
	});

	it("a cert-provision failure triggers backoff-reconnect, not a crash", async () => {
		let calls = 0;
		mockEnsureCert.mockImplementation(async () => {
			calls++;
			if (calls === 1) throw new Error("ACME failure");
			orchestrationOrder.push("cert");
			Promise.resolve().then(() => fireSigint());
			return {
				ready: true,
				fromCache: false,
				certPem: "C",
				keyPem: "K",
				meta: {},
			};
		});
		const program = makeProgram({});
		await program.parseAsync(["node", "rine", "relay", "--agent", AGENT_ID]);
		// It retried (calls >= 2) and exited cleanly — no unhandled crash.
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(process.exitCode).toBe(0);
	});
});

// ── lifecycle events (stream.ts shape, never a body) ────────────────────────

describe("rine relay — lifecycle events", () => {
	it("emits cert_ready, tunnel_connected and stopped in the emitLifecycle JSON shape", async () => {
		const out = captureStdout();
		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"relay",
			"--agent",
			AGENT_ID,
			"--json",
		]);

		const events = out.lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(
				(e): e is { event: string; data: Record<string, unknown> } =>
					e?.event === "lifecycle",
			);
		const states = events.map((e) => e.data.state);
		expect(states).toContain("cert_ready");
		expect(states).toContain("tunnel_connected");
		expect(states).toContain("stopped");
		// cert_ready carries the hostname (never any key material).
		const certReady = events.find((e) => e.data.state === "cert_ready");
		expect(JSON.stringify(certReady)).not.toMatch(
			/BEGIN (EC )?PRIVATE KEY|KEY"/,
		);
	});

	it("emits tunnel_reconnecting with attempt + backoff_ms on a recoverable failure", async () => {
		let calls = 0;
		mockConnectTunnel.mockImplementation(async () => {
			calls++;
			if (calls === 1) throw new Error("WS connect refused");
			orchestrationOrder.push("tunnel");
			Promise.resolve().then(() => fireSigint());
			return {
				close: vi.fn(),
				onClose: (cb: (c: TunnelClose) => void) =>
					cb({ code: 1000, clean: true }),
			};
		});
		const out = captureStdout();
		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"relay",
			"--agent",
			AGENT_ID,
			"--json",
		]);

		const events = out.lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(
				(e): e is { event: string; data: Record<string, unknown> } =>
					e?.event === "lifecycle",
			);
		const reconnecting = events.find(
			(e) => e.data.state === "tunnel_reconnecting",
		);
		expect(reconnecting).toBeDefined();
		expect(typeof reconnecting?.data.attempt).toBe("number");
		expect(reconnecting?.data.backoff_ms as number).toBeGreaterThan(0);
	});

	it("a CLEAN server close reconnects immediately (backoff_ms 0), not with a jittered delay", async () => {
		let calls = 0;
		mockConnectTunnel.mockImplementation(async () => {
			calls++;
			orchestrationOrder.push("tunnel");
			if (calls === 1) {
				// Orderly broker close (1000) → the relay must reconnect immediately.
				return {
					close: vi.fn(),
					onClose: (cb: (c: { code: number; clean: boolean }) => void) =>
						cb({ code: 1000, clean: true }),
				};
			}
			Promise.resolve().then(() => fireSigint());
			return {
				close: vi.fn(),
				onClose: (cb: (c: TunnelClose) => void) =>
					cb({ code: 1000, clean: true }),
			};
		});
		const out = captureStdout();
		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"relay",
			"--agent",
			AGENT_ID,
			"--json",
		]);

		const reconnect = out.lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(
				(e): e is { event: string; data: Record<string, unknown> } =>
					e?.event === "lifecycle",
			)
			.find((e) => e.data.state === "tunnel_reconnecting");
		expect(reconnect).toBeDefined();
		expect(reconnect?.data.reason).toBe("server_close");
		expect(reconnect?.data.backoff_ms).toBe(0);
	});

	it("an ABNORMAL server close backs off with a jittered delay", async () => {
		let calls = 0;
		mockConnectTunnel.mockImplementation(async () => {
			calls++;
			orchestrationOrder.push("tunnel");
			if (calls === 1) {
				// Abnormal close (1011 internal error) → jittered backoff, not immediate.
				return {
					close: vi.fn(),
					onClose: (cb: (c: { code: number; clean: boolean }) => void) =>
						cb({ code: 1011, clean: false }),
				};
			}
			Promise.resolve().then(() => fireSigint());
			return {
				close: vi.fn(),
				onClose: (cb: (c: TunnelClose) => void) =>
					cb({ code: 1000, clean: true }),
			};
		});
		const out = captureStdout();
		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"relay",
			"--agent",
			AGENT_ID,
			"--json",
		]);

		const reconnect = out.lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(
				(e): e is { event: string; data: Record<string, unknown> } =>
					e?.event === "lifecycle",
			)
			.find((e) => e.data.state === "tunnel_reconnecting");
		expect(reconnect).toBeDefined();
		expect(reconnect?.data.reason).toBe("error");
		expect(reconnect?.data.backoff_ms as number).toBeGreaterThan(0);
	});

	it("emits tunnel_revoked and exits non-zero when the binding is rejected (hook deleted)", async () => {
		mockConnectTunnel.mockImplementation(async () => {
			// BIND_NAK / ownership rejection surfaces as a revoked tunnel.
			throw Object.assign(new Error("binding rejected"), { revoked: true });
		});
		const out = captureStdout();
		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"relay",
			"--agent",
			AGENT_ID,
			"--json",
		]);

		const events = out.lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(
				(e): e is { event: string; data: Record<string, unknown> } =>
					e?.event === "lifecycle",
			);
		expect(events.map((e) => e.data.state)).toContain("tunnel_revoked");
		expect(process.exitCode).not.toBe(0);
	});

	it("no lifecycle event ever carries a request body or the HMAC secret", async () => {
		const out = captureStdout();
		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"relay",
			"--agent",
			AGENT_ID,
			"--json",
		]);
		const all = out.lines.join("\n");
		// No event should ever surface body/payload/secret keys.
		const events = out.lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(
				(e): e is { event: string; data: Record<string, unknown> } =>
					e?.event === "lifecycle",
			);
		for (const e of events) {
			expect(Object.keys(e.data)).not.toContain("body");
			expect(Object.keys(e.data)).not.toContain("secret");
			expect(Object.keys(e.data)).not.toContain("payload");
		}
		expect(all).not.toMatch(/BEGIN (EC )?PRIVATE KEY/);
	});
});
