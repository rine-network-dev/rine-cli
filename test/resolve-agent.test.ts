import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgent, resetAgentCache } from "../src/resolve-agent.js";
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

describe("resolveAgent", () => {
	it("returns explicit --agent when provided", async () => {
		const client = makeClient([]);
		const result = await resolveAgent(client, "explicit-id");
		expect(result).toBe("explicit-id");
		expect(client.get).not.toHaveBeenCalled();
	});

	it("returns --as flag when --agent is omitted", async () => {
		const client = makeClient([]);
		const result = await resolveAgent(client, undefined, "as-id");
		expect(result).toBe("as-id");
		expect(client.get).not.toHaveBeenCalled();
	});

	it("explicit --agent wins over --as", async () => {
		const client = makeClient([]);
		const result = await resolveAgent(client, "explicit-id", "as-id");
		expect(result).toBe("explicit-id");
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

	it("caches GET /agents across calls", async () => {
		const agent = makeAgent("agent-1", "bot@org.rine.network");
		const client = makeClient([agent]);

		await resolveAgent(client);
		await resolveAgent(client);

		expect(client.get).toHaveBeenCalledTimes(1);
	});
});
