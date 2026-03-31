import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBareAgentName, resolveAgent, resetAgentCache } from "../src/resolve-agent.js";
import type { HttpClient } from "../src/http.js";
import type { AgentRead } from "../src/api-types.js";

function makeAgent(id: string, handle: string): AgentRead {
	return {
		id,
		name: `Agent ${id.slice(0, 4)}`,
		handle,
		human_oversight: false,
		incoming_policy: "open",
		outgoing_policy: "open",
		created_at: "2026-01-01T00:00:00Z",
	};
}

function makeClient(agents: AgentRead[]): HttpClient {
	return {
		get: vi.fn().mockResolvedValue({ items: agents, total: agents.length }),
	} as unknown as HttpClient;
}

beforeEach(() => {
	resetAgentCache();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const EXPLICIT_UUID = "a0000000-0000-0000-0000-000000000001";
const AS_UUID = "b0000000-0000-0000-0000-000000000002";

describe("resolveAgent", () => {
	it("returns explicit --agent when provided", async () => {
		const client = makeClient([]);
		const result = await resolveAgent(client, EXPLICIT_UUID);
		expect(result).toBe(EXPLICIT_UUID);
		expect(client.get).not.toHaveBeenCalled();
	});

	it("returns --as flag when --agent is omitted", async () => {
		const client = makeClient([]);
		const result = await resolveAgent(client, undefined, AS_UUID);
		expect(result).toBe(AS_UUID);
		expect(client.get).not.toHaveBeenCalled();
	});

	it("explicit --agent wins over --as", async () => {
		const client = makeClient([]);
		const result = await resolveAgent(client, EXPLICIT_UUID, AS_UUID);
		expect(result).toBe(EXPLICIT_UUID);
	});

	it("resolves bare name via agent list (explicit)", async () => {
		const agent = makeAgent("id-kofi", "kofi@org.rine.network");
		agent.name = "Kofi";
		const client = makeClient([agent]);
		const result = await resolveAgent(client, "Kofi");
		expect(result).toBe("id-kofi");
		expect(client.get).toHaveBeenCalledWith("/agents");
	});

	it("resolves bare name via agent list (asFlag)", async () => {
		const agent = makeAgent("id-kofi", "kofi@org.rine.network");
		agent.name = "Kofi";
		const client = makeClient([agent]);
		const result = await resolveAgent(client, undefined, "kofi");
		expect(result).toBe("id-kofi");
	});

	it("bare name resolution is case-insensitive", async () => {
		const agent = makeAgent("id-kofi", "kofi@org.rine.network");
		agent.name = "Kofi";
		const client = makeClient([agent]);
		const result = await resolveAgent(client, undefined, "KOFI");
		expect(result).toBe("id-kofi");
	});

	it("throws helpful error for unmatched bare name", async () => {
		const agent = makeAgent("id-leon", "leon@org.rine.network");
		agent.name = "Leon";
		const client = makeClient([agent]);
		await expect(resolveAgent(client, "nobody")).rejects.toThrow(
			/No agent named 'nobody'/,
		);
		await expect(resolveAgent(client, "nobody")).rejects.toThrow(/Leon/);
	});

	it("auto-resolves single agent", async () => {
		const agent = makeAgent("agent-1", "bot@org.rine.network");
		const client = makeClient([agent]);
		const result = await resolveAgent(client, undefined, undefined);
		expect(result).toBe("agent-1");
		expect(client.get).toHaveBeenCalledWith("/agents");
	});

	it("throws for zero agents", async () => {
		const client = makeClient([]);
		await expect(resolveAgent(client)).rejects.toThrow(
			"No active agents. Create one with 'rine agent create --name <name>'",
		);
	});

	it("throws for multiple agents with listing", async () => {
		const a1 = makeAgent("id-aaa", "alpha@org.rine.network");
		const a2 = makeAgent("id-bbb", "beta@org.rine.network");
		const client = makeClient([a1, a2]);
		await expect(resolveAgent(client)).rejects.toThrow(
			/Multiple agents found/,
		);
		await expect(resolveAgent(client)).rejects.toThrow(/id-aaa/);
		await expect(resolveAgent(client)).rejects.toThrow(/id-bbb/);
	});

	it("throws for unmatched bare name with no agents", async () => {
		const client = makeClient([]);
		await expect(resolveAgent(client, "kofi")).rejects.toThrow(
			/No agent named 'kofi'/,
		);
	});

	it("caches GET /agents across calls", async () => {
		const agent = makeAgent("agent-1", "bot@org.rine.network");
		const client = makeClient([agent]);

		await resolveAgent(client);
		await resolveAgent(client);

		expect(client.get).toHaveBeenCalledTimes(1);
	});
});

describe("isBareAgentName", () => {
	it("returns true for plain names", () => {
		expect(isBareAgentName("kofi")).toBe(true);
		expect(isBareAgentName("My Agent")).toBe(true);
	});

	it("returns false for UUIDs", () => {
		expect(isBareAgentName(EXPLICIT_UUID)).toBe(false);
	});

	it("returns false for handles", () => {
		expect(isBareAgentName("bot@org.rine.network")).toBe(false);
	});
});
