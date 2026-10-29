import {
	KEY_NOT_CURRENT_MESSAGE,
	KeyPackageRotation,
	type RotationSettlement,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printRotationReport } from "../src/commands/keys-rotate-report.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function said(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((call) => call.join(" "))
		.join("\n");
}

function report(keyPackages: RotationSettlement["key_packages"]): RotationSettlement {
	return { key_packages: keyPackages, group_seats: [] };
}

describe("the rotation report's key-package line", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("says the next MLS command replaces key packages that still carry the old key", () => {
		printRotationReport(AGENT_ID, report(KeyPackageRotation.Pending), false);
		expect(said()).toContain(
			"Published key packages still carry the old key; the next MLS command on this device replaces them.",
		);
	});

	it("says another device moves the packages and seats when this one holds no MLS state", () => {
		printRotationReport(AGENT_ID, report(KeyPackageRotation.NotHeld), false);
		expect(said()).toContain(
			"This device holds no MLS state for the agent, so its key packages and group seats move from a device that does.",
		);
	});

	it("says the key packages already carry the current key when nothing was replaced", () => {
		printRotationReport(AGENT_ID, report(KeyPackageRotation.Current), false);
		expect(said()).toContain(
			"Published key packages already carry the current key.",
		);
	});

	it("names the earlier key generation when this device is behind the agent's current key", () => {
		printRotationReport(AGENT_ID, report(KeyPackageRotation.KeyNotCurrent), false);
		expect(said()).toContain(KEY_NOT_CURRENT_MESSAGE);
	});

	it.each(Object.values(KeyPackageRotation))(
		"prints a defined sentence for the %s outcome",
		(outcome) => {
			printRotationReport(AGENT_ID, report(outcome), false);
			const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
			expect(lines).toHaveLength(2);
			expect(lines.every((line) => typeof line === "string")).toBe(true);
		},
	);
});
