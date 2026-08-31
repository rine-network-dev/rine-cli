/**
 * `ownAgentHandles` — the CLI half of the id→handle resolution.
 *
 * The three render cases are asserted on the renderer (`group-rows.test.ts`).
 * What is asserted here is the part the renderer cannot see: which agents make
 * it into the map at all, and that a failed `GET /agents` degrades the cell
 * rather than the command.
 */

import type { AgentRead } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { ownAgentHandles } from "../src/commands/own-agents.js";

const OPS = "22222222-2222-4222-8222-222222222222";
const BILLING = "33333333-3333-4333-8333-333333333333";

function agent(id: string, handle: string | null): AgentRead {
	return {
		id,
		name: handle?.split("@")[0] ?? "unnamed",
		handle,
		human_oversight: true,
		incoming_policy: "accept_all",
		outgoing_policy: "send_all",
		created_at: "2026-01-01T00:00:00Z",
	};
}

describe("ownAgentHandles", () => {
	it("indexes this org's handles by lowercased id", async () => {
		const map = await ownAgentHandles(async () => [
			agent(OPS, "ops@acme"),
			agent(BILLING, "billing@acme"),
		]);
		expect(map.get(OPS)).toBe("ops@acme");
		expect(map.get(OPS.toUpperCase().toLowerCase())).toBe("ops@acme");
	});

	it("leaves an agent with no handle out, so the cell prints its id", async () => {
		// `POST /agents` mints a handle only once the org has a slug, so this is
		// a real org state and not a malformed row. A name is NOT the fallback:
		// the server refuses a bare name as an actor, so printing one would hand
		// back a value nothing accepts.
		const map = await ownAgentHandles(async () => [agent(OPS, null)]);
		expect(map.has(OPS)).toBe(false);
	});

	it("answers an empty map when the agent list cannot be read", async () => {
		// The group read has already succeeded by the time this runs.
		const map = await ownAgentHandles(async () => {
			throw new Error("503 from /agents");
		});
		expect(map.size).toBe(0);
	});
});
