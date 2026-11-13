// A held agent (suspended, its branch suspended, its org frozen) is not a revoked one. The relay
// pauses on a `suspended` NAK, a 4423 close, or a mint refused with a hold code: it retries every
// 30 s with a freshly minted token, never exits and never wipes the wildcard. A revocation NAK is
// confirmed once with a fresh mint before the relay gives up, because an older broker or server
// reports a held agent as revoked; a confirming mint that meets a network fault, a 429 or a 5xx
// retries with the backoff instead. Externals are mocked as in relay.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const HOSTNAME = "github.0h248h248h248h248h248h248h.hook.rine.network";
const PAUSE_MESSAGE =
	"tunnel paused: the agent is suspended; retrying every 30 s";

type TunnelClose = { code: number; clean: boolean };
type Tunnel = {
	close: () => void;
	onClose: (cb: (close: TunnelClose) => void) => void;
};

const mockConnectTunnel = vi.fn(async (): Promise<Tunnel> => bound());
const mockToken = vi.fn(async (_opts?: { force?: boolean }) => "fake-token");

/** A bound tunnel that stays up until the relay closes it. */
function bound(): Tunnel {
	return { close: vi.fn(), onClose: vi.fn() };
}

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveConfigDir: vi.fn(() => "/fake/config"),
		resolveApiUrl: vi.fn(() => "http://localhost:7001"),
		fetchAgents: vi.fn(async () => [{ id: AGENT_ID, name: "bot" }]),
		resolveAgent: vi.fn(async () => ({ agentId: AGENT_ID })),
		formatError: vi.fn((e: unknown) => String(e)),
		loadHookSecret: vi.fn(() => "hook-secret"),
		agentKeysExist: vi.fn(() => true),
		buildIssueCertDeps: vi.fn(async () => ({})),
		ensureCert: vi.fn(async () => ({
			ready: true,
			fromCache: false,
			certPem: "CERT",
			keyPem: "KEY",
			meta: {},
		})),
		loadMeta: vi.fn(() => ({ not_after: "2099-01-01T00:00:00Z" })),
		renewalDueWithJitter: vi.fn(() => false),
		connectTunnel: () => mockConnectTunnel(),
		startTlsListener: vi.fn(async () => ({ close: vi.fn(), port: 8443 })),
	};
});

vi.mock("node:dns/promises", () => ({
	resolve4: vi.fn(async () => ["203.0.113.7"]),
}));

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
						control_ws_url: "wss://funnel.rine.network/_funnel/v1",
						termination: "zero_trust",
					},
				],
			})),
			post: vi.fn(),
		},
		profileName: "default",
		dirs: { configDir: "/fake/config", ownerDir: "/fake/owner" },
		auth: undefined,
		token: (opts?: { force?: boolean }) => mockToken(opts),
	})),
}));

import { RineApiError, TunnelBindError } from "@rine-network/core";
import { Command } from "commander";
import { registerRelay } from "../src/commands/relay.js";

const sigintListeners: Array<() => void> = [];
const fireSigint = () => {
	for (const l of [...sigintListeners]) l();
};
const lines: string[] = [];
let run: Promise<unknown>;

function startRelay(): void {
	const program = new Command();
	program.option("--json");
	vi.spyOn(program, "opts").mockReturnValue({ json: true });
	registerRelay(program);
	run = program.parseAsync([
		"node",
		"rine",
		"relay",
		"--agent",
		AGENT_ID,
		"--json",
	]);
}

function events(): Array<Record<string, unknown>> {
	return lines.flatMap((l) => {
		try {
			const e = JSON.parse(l) as {
				event: string;
				data: Record<string, unknown>;
			};
			return e.event === "lifecycle" ? [e.data] : [];
		} catch {
			return [];
		}
	});
}
const states = () => events().map((e) => e.state);
const count = (state: string) => states().filter((s) => s === state).length;

/** Refused the way the token mint refuses a held principal. */
function heldMint(reason = "agent_suspended"): RineApiError {
	const body = {
		error: "unauthorized_client",
		reason,
		error_description: "held",
	};
	return new RineApiError(400, "held", undefined, "unauthorized_client", body);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	sigintListeners.length = 0;
	lines.length = 0;
	process.exitCode = undefined;
	mockConnectTunnel.mockReset().mockImplementation(async () => bound());
	mockToken.mockReset().mockImplementation(async () => "fake-token");
	vi.spyOn(process, "on").mockImplementation(((e: string, l: () => void) => {
		if (e === "SIGINT") sigintListeners.push(l);
		return process;
	}) as typeof process.on);
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) =>
		lines.push(a.map(String).join(" ")),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

async function until(check: () => boolean): Promise<void> {
	await vi.waitFor(() => expect(check()).toBe(true));
}

async function finish(): Promise<void> {
	fireSigint();
	await run;
}

describe("rine relay — a held agent pauses the relay", () => {
	it("a suspended NAK pauses with the held-agent text, retries after 30 s and a later bind resumes", async () => {
		mockConnectTunnel.mockRejectedValueOnce(new TunnelBindError("suspended"));
		startRelay();
		await until(() => count("tunnel_paused") === 1);
		expect(events().find((e) => e.state === "tunnel_paused")?.message).toBe(
			PAUSE_MESSAGE,
		);
		expect(mockConnectTunnel).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(29_000);
		expect(mockConnectTunnel).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2_000);
		await until(() => count("tunnel_connected") === 1);
		expect(mockConnectTunnel).toHaveBeenCalledTimes(2);
		expect(states()).not.toContain("tunnel_revoked");

		await finish();
		expect(process.exitCode).toBe(0);
	});

	it("a 4423 close pauses the relay and a later bind resumes it", async () => {
		mockConnectTunnel.mockImplementationOnce(async () => ({
			close: vi.fn(),
			onClose: (cb) => cb({ code: 4423, clean: false }),
		}));
		startRelay();
		await until(() => count("tunnel_paused") === 1);
		expect(states()).not.toContain("tunnel_reconnecting");

		await vi.advanceTimersByTimeAsync(31_000);
		await until(() => count("tunnel_connected") === 2);
		expect(states()).not.toContain("tunnel_revoked");

		await finish();
		expect(process.exitCode).toBe(0);
	});

	it("a paused retry mints a fresh token instead of presenting the cached one", async () => {
		mockConnectTunnel.mockRejectedValueOnce(new TunnelBindError("suspended"));
		startRelay();
		await until(() => count("tunnel_paused") === 1);
		await vi.advanceTimersByTimeAsync(31_000);
		await until(() => mockConnectTunnel.mock.calls.length === 2);

		expect(mockToken.mock.calls.map(([o]) => o?.force)).toEqual([false, true]);

		await finish();
	});

	it("a bind after the pause clears it: the next ordinary reconnect uses the cached token", async () => {
		mockConnectTunnel
			.mockRejectedValueOnce(new TunnelBindError("suspended"))
			.mockImplementationOnce(async () => ({
				close: vi.fn(),
				onClose: (cb) => cb({ code: 1000, clean: true }),
			}));
		startRelay();
		await until(() => count("tunnel_paused") === 1);
		await vi.advanceTimersByTimeAsync(31_000);
		await until(() => mockConnectTunnel.mock.calls.length === 3);

		expect(mockToken.mock.calls.map(([o]) => o?.force)).toEqual([
			false,
			true,
			false,
		]);

		await finish();
	});

	it("a mint refused with a hold code keeps the relay paused and retrying", async () => {
		mockConnectTunnel.mockRejectedValueOnce(new TunnelBindError("suspended"));
		mockToken
			.mockResolvedValueOnce("t1")
			.mockRejectedValueOnce(heldMint("branch_suspended"));
		startRelay();
		await until(() => count("tunnel_paused") === 1);
		await vi.advanceTimersByTimeAsync(31_000);
		await until(() => count("tunnel_paused") === 2);
		expect(mockConnectTunnel).toHaveBeenCalledTimes(1);
		expect(states()).not.toContain("tunnel_revoked");

		await vi.advanceTimersByTimeAsync(31_000);
		await until(() => count("tunnel_connected") === 1);

		await finish();
		expect(process.exitCode).toBe(0);
	});

	it("SIGINT ends a paused relay at once, without waiting out the 30 s", async () => {
		mockConnectTunnel.mockRejectedValueOnce(new TunnelBindError("suspended"));
		startRelay();
		await until(() => count("tunnel_paused") === 1);

		await finish();
		expect(process.exitCode).toBe(0);
		expect(states()).toContain("stopped");
		expect(mockConnectTunnel).toHaveBeenCalledTimes(1);
	});
});

describe("rine relay — a revocation NAK is confirmed once with a fresh mint", () => {
	it("an inactive NAK whose confirming mint is refused with a hold code pauses instead of exiting", async () => {
		mockConnectTunnel.mockRejectedValueOnce(new TunnelBindError("inactive"));
		mockToken
			.mockResolvedValueOnce("t1")
			.mockRejectedValueOnce(heldMint("org_frozen"));
		startRelay();
		await until(() => count("tunnel_paused") === 1);
		expect(mockToken.mock.calls[1]?.[0]).toMatchObject({ force: true });
		expect(states()).not.toContain("tunnel_revoked");

		await vi.advanceTimersByTimeAsync(31_000);
		await until(() => count("tunnel_connected") === 1);

		await finish();
		expect(process.exitCode).toBe(0);
	});

	it("an inactive NAK whose confirming mint succeeds is revoked: exit 1 after one confirmation", async () => {
		mockConnectTunnel.mockRejectedValueOnce(new TunnelBindError("inactive"));
		startRelay();
		await run;

		expect(states()).toContain("tunnel_revoked");
		expect(states()).not.toContain("tunnel_paused");
		expect(process.exitCode).toBe(1);
		expect(mockToken).toHaveBeenCalledTimes(2);
		expect(mockToken.mock.calls[1]?.[0]).toMatchObject({ force: true });
		expect(mockConnectTunnel).toHaveBeenCalledTimes(1);
	});

	it("a confirming mint that fails for any other reason leaves the binding revoked", async () => {
		mockConnectTunnel.mockRejectedValueOnce(new TunnelBindError("not_owned"));
		mockToken
			.mockResolvedValueOnce("t1")
			.mockRejectedValueOnce(new RineApiError(401, "bad assertion"));
		startRelay();
		await run;

		expect(states()).toContain("tunnel_revoked");
		expect(process.exitCode).toBe(1);
	});

	it.each([
		["a network fault", () => new TypeError("fetch failed")],
		["a 503", () => new RineApiError(503, "unavailable")],
		["a 429", () => new RineApiError(429, "slow down")],
	])(
		"a confirming mint that meets %s retries with the backoff instead of exiting",
		async (_name, transient) => {
			mockConnectTunnel.mockRejectedValueOnce(new TunnelBindError("inactive"));
			mockToken.mockResolvedValueOnce("t1").mockRejectedValueOnce(transient());
			startRelay();
			await until(() => count("tunnel_reconnecting") === 1);
			expect(
				events().find((e) => e.state === "tunnel_reconnecting")?.reason,
			).toBe("error");
			expect(states()).not.toContain("tunnel_revoked");

			await vi.advanceTimersByTimeAsync(5_000);
			await until(() => count("tunnel_connected") === 1);

			await finish();
			expect(process.exitCode).toBe(0);
		},
	);
});
