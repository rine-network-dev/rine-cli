import type {
	AgentRead,
	VerificationWordsComparison,
} from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { toAgentRow } from "../src/agent-format.js";

/**
 * The same comparison in a table: when the words this client derives and the
 * words the server asserts disagree, the row carries **both**, in two
 * columns. A table is still a display surface, so it may not resolve the
 * disagreement by picking one side.
 */

const AGENT = {
	id: "11111111-2222-3333-4444-555555555555",
	name: "me",
	handle: "me@myorg",
	human_oversight: true,
	created_at: "2026-01-01T00:00:00Z",
	unlisted: false,
	revoked_at: null,
} as unknown as AgentRead;

const COMPUTED = "abandon ability able about above";
const ASSERTED = "zoo zone zero zebra zap";

function comparison(
	over: Partial<VerificationWordsComparison>,
): VerificationWordsComparison {
	return {
		status: "match",
		computed: COMPUTED,
		asserted: COMPUTED,
		match: true,
		...over,
	} as VerificationWordsComparison;
}

describe("toAgentRow", () => {
	it("omits the words entirely when no comparison is passed", () => {
		const row = toAgentRow(AGENT);
		expect(row["Verification Words"]).toBeUndefined();
		expect(row["Verification Words (server)"]).toBeUndefined();
	});

	it("shows one column when the two agree", () => {
		const row = toAgentRow(AGENT, { verification: comparison({}) });
		expect(row["Verification Words"]).toBe(COMPUTED);
		expect(row["Verification Words (server)"]).toBeUndefined();
	});

	it("shows BOTH columns when they disagree", () => {
		const row = toAgentRow(AGENT, {
			verification: comparison({
				status: "mismatch",
				asserted: ASSERTED,
				match: false,
			}),
		});
		expect(row["Verification Words"]).toBe(COMPUTED);
		expect(row["Verification Words (server)"]).toBe(ASSERTED);
	});

	it("labels the server's column as the server's when nothing was computed", () => {
		const row = toAgentRow(AGENT, {
			verification: comparison({
				status: "not-computed",
				computed: null,
				asserted: ASSERTED,
				match: null,
			}),
		});
		expect(row["Verification Words"]).toBeUndefined();
		expect(row["Verification Words (server)"]).toBe(ASSERTED);
	});

	it("shows the computed words alone when the server asserts none", () => {
		const row = toAgentRow(AGENT, {
			verification: comparison({
				status: "not-asserted",
				asserted: null,
				match: null,
			}),
		});
		expect(row["Verification Words"]).toBe(COMPUTED);
		expect(row["Verification Words (server)"]).toBeUndefined();
	});

	it("still carries card and revoked columns alongside", () => {
		const row = toAgentRow(AGENT, {
			includeCard: true,
			includeRevoked: true,
			verification: comparison({}),
		});
		expect(row.Card).toBe("public");
		expect(row.Revoked).toBe("—");
	});
});
