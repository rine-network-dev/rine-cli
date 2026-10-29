import * as core from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import { derivedAgentKeys } from "./derived-keys.js";
import { AGENT_ID, makeProgram, run, srcDir, useKeysFixture } from "./keys-fixture.js";

useKeysFixture();

const GROUP_ID = "33333333-3333-3333-3333-333333333333";
const REPORT: core.RotationSettlement = {
	key_packages: "republished",
	group_seats: [
		{ group_id: GROUP_ID, status: "deferred", reason: "epoch_race" },
		{ group_id: "33333333-3333-3333-3333-333333333334", status: "updated", epoch: 4 },
	],
};

/** Everything the command printed, one line per call. */
function printed(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((call) => call.join(" "))
		.join("\n");
}

describe("keys rotate", () => {
	it("rotates through the org custody and checks the server holds the new keys", async () => {
		const rotated = derivedAgentKeys(AGENT_ID, 1);
		core.saveAgentKeys(srcDir, AGENT_ID, derivedAgentKeys(AGENT_ID, 0));
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);
		const rotate = vi.spyOn(core, "rotateAgentWithSeats").mockImplementation(async () => {
			core.saveAgentKeys(srcDir, AGENT_ID, rotated);
			return { agent: {} as never, ...REPORT };
		});
		// withClient builds a real HttpClient, so intercept at the prototype.
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue({
			signing_public_key: { x: core.toBase64Url(rotated.signing.publicKey) },
			encryption_public_key: { x: core.toBase64Url(rotated.encryption.publicKey) },
			pq_encryption_public_key: { x: core.toBase64Url(rotated.pqEncryption.publicKey) },
		});

		await run("rotate", "--agent", AGENT_ID);

		expect(rotate).toHaveBeenCalledWith(
			expect.any(core.HttpClient),
			{ configDir: srcDir, ownerDir: "/tmp/test-rine-owner" },
			AGENT_ID,
		);
		expect(process.exitCode).toBeUndefined();
		const said = printed();
		expect(said).toContain(`E2EE keys rotated for agent ${AGENT_ID}`);
		expect(said).toContain("Published key packages now carry the new key.");
		expect(said).toContain(`Group ${GROUP_ID}: Its leaf still carries an earlier key`);
		expect(said).not.toContain("Group 33333333-3333-3333-3333-333333333334");
	});

	it("prints the whole report as JSON under --json", async () => {
		const rotated = derivedAgentKeys(AGENT_ID, 1);
		core.saveAgentKeys(srcDir, AGENT_ID, derivedAgentKeys(AGENT_ID, 0));
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);
		vi.spyOn(core, "rotateAgentWithSeats").mockImplementation(async () => {
			core.saveAgentKeys(srcDir, AGENT_ID, rotated);
			return { agent: {} as never, ...REPORT };
		});
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue({
			signing_public_key: { x: core.toBase64Url(rotated.signing.publicKey) },
			encryption_public_key: { x: core.toBase64Url(rotated.encryption.publicKey) },
			pq_encryption_public_key: { x: core.toBase64Url(rotated.pqEncryption.publicKey) },
		});

		await makeProgram({ json: true }).parseAsync([
			"node",
			"rine",
			"keys",
			"rotate",
			"--agent",
			AGENT_ID,
		]);

		expect(JSON.parse(printed())).toEqual({ ok: true, ...REPORT });
	});

	it.each(["add-pq", "generate"])("has no %s subcommand", async (name) => {
		const program = makeProgram({ json: false });
		const keys = program.commands.find((c) => c.name() === "keys");
		expect(keys?.commands.map((c) => c.name())).not.toContain(name);
	});
});
