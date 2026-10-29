// The relay's standing cert renewal: the zero-trust listener arms a 12 h
// re-check, the re-check renews only when due and never overlaps an issuance
// already in flight, and stop() disarms it. The @rine-network/core cert and
// listener entry points and node:dns are mocked; relayCert and prepareTier run
// for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RENEWAL_MS = 12 * 60 * 60 * 1000;
const AGENT_LABEL = "0h248h248h248h248h248h248h";
const HOSTNAME = `github.${AGENT_LABEL}.hook.rine.network`;

const issued = { certPem: "CERT", keyPem: "KEY" };
const mockEnsureCert = vi.fn(async (_args: unknown) => issued);
const mockRenewalDue = vi.fn(() => true);
const mockListenerClose = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		buildIssueCertDeps: vi.fn(async () => ({})),
		ensureCert: (args: unknown) => mockEnsureCert(args),
		loadMeta: vi.fn(() => ({ not_after: "2099-01-01T00:00:00Z" })),
		renewalDueWithJitter: () => mockRenewalDue(),
		startTlsListener: vi.fn(async () => ({
			close: mockListenerClose,
			port: 8443,
			openLocalPipe: vi.fn(),
		})),
	};
});

vi.mock("node:dns/promises", () => ({
	resolve4: vi.fn(async () => ["203.0.113.7"]),
}));

import type { HookRead, HttpClient, RelayResult } from "@rine-network/core";
import { type RelayCert, relayCert } from "../src/commands/relay-cert.js";
import { prepareTier } from "../src/commands/relay-tier.js";

const RELAYED: RelayResult = { verified: true, relayed: true, duplicate: false };

function makeCert(): RelayCert {
	return relayCert({
		configDir: "/fake/config",
		agentId: "11111111-1111-1111-1111-111111111111",
		client: {} as HttpClient,
		options: {},
		json: undefined,
		isStopped: () => false,
	});
}

const zeroTrustHook = {
	hook_name: "default",
	hostname: HOSTNAME,
	control_ws_url: "wss://funnel.rine.network/_funnel/v1",
	termination: "zero_trust",
} as HookRead;

beforeEach(() => {
	vi.useFakeTimers();
	mockEnsureCert.mockClear();
	mockEnsureCert.mockImplementation(async () => issued);
	mockRenewalDue.mockReturnValue(true);
	mockListenerClose.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("relayCert — standing renewal re-check", () => {
	it("renews a due cert on each 12 h tick once armed", async () => {
		const cert = makeCert();
		await cert.ensure(AGENT_LABEL);
		cert.startRenewalTimer();
		await vi.advanceTimersByTimeAsync(RENEWAL_MS);
		expect(mockEnsureCert).toHaveBeenCalledTimes(2);
		expect(mockEnsureCert).toHaveBeenLastCalledWith(
			expect.objectContaining({ handle: AGENT_LABEL }),
		);
		cert.stop();
	});

	it("does not renew before it is armed, or when the cert is not due", async () => {
		const cert = makeCert();
		await cert.ensure(AGENT_LABEL);
		await vi.advanceTimersByTimeAsync(RENEWAL_MS);
		expect(mockEnsureCert).toHaveBeenCalledTimes(1);
		mockRenewalDue.mockReturnValue(false);
		cert.startRenewalTimer();
		await vi.advanceTimersByTimeAsync(RENEWAL_MS);
		expect(mockEnsureCert).toHaveBeenCalledTimes(1);
		cert.stop();
	});

	it("arms one timer however often it is started", async () => {
		const cert = makeCert();
		await cert.ensure(AGENT_LABEL);
		cert.startRenewalTimer();
		cert.startRenewalTimer();
		await vi.advanceTimersByTimeAsync(RENEWAL_MS);
		expect(mockEnsureCert).toHaveBeenCalledTimes(2);
		cert.stop();
	});

	it("skips a tick while an issuance is still in flight", async () => {
		const cert = makeCert();
		await cert.ensure(AGENT_LABEL);
		cert.startRenewalTimer();
		let finish: (v: typeof issued) => void = () => {};
		mockEnsureCert.mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve)),
		);
		const reconnectIssue = cert.ensure(AGENT_LABEL);
		await vi.advanceTimersByTimeAsync(RENEWAL_MS);
		expect(mockEnsureCert).toHaveBeenCalledTimes(2);
		finish(issued);
		await reconnectIssue;
		cert.stop();
	});

	it("stop() disarms the re-check", async () => {
		const cert = makeCert();
		await cert.ensure(AGENT_LABEL);
		cert.startRenewalTimer();
		cert.stop();
		await vi.advanceTimersByTimeAsync(RENEWAL_MS * 2);
		expect(mockEnsureCert).toHaveBeenCalledTimes(1);
	});
});

describe("prepareTier — zero-trust listen()", () => {
	it("arms the renewal re-check once the listener is up", async () => {
		const cert = makeCert();
		const tier = await prepareTier(
			zeroTrustHook,
			async () => RELAYED,
			cert,
			undefined,
		);
		await tier.listen(8443, () => {});
		await vi.advanceTimersByTimeAsync(RENEWAL_MS);
		expect(mockEnsureCert).toHaveBeenCalledTimes(2);
		cert.stop();
	});

	it("hands the listener over before a later step can fail", async () => {
		const cert = makeCert();
		vi.spyOn(cert, "startRenewalTimer").mockImplementation(() => {
			throw new Error("timer refused");
		});
		const tier = await prepareTier(
			zeroTrustHook,
			async () => RELAYED,
			cert,
			undefined,
		);
		const handedOver: { close(): void }[] = [];
		await expect(
			tier.listen(8443, (listener) => handedOver.push(listener)),
		).rejects.toThrow("timer refused");
		expect(handedOver).toHaveLength(1);
		handedOver[0]?.close();
		expect(mockListenerClose).toHaveBeenCalledTimes(1);
	});
});
