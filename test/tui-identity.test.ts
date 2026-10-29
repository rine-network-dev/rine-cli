import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentKeysFromDerived,
	deriveAgent,
	deriveBranch,
	deriveOrg,
	saveAgentKeys,
	saveProfiles,
	saveRoot,
} from "@rine-network/core";
import { FIXTURE_ROOT } from "@rine-network/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityKind, resolveIdentity } from "../src/tui/identity.js";
import { FeedErrorCode } from "../src/tui/feed-schema.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH = "main";
const org = () => deriveOrg(FIXTURE_ROOT);

let tmp: string;
let configDir: string;
let ownerDir: string;

const resolve = () => resolveIdentity({ configDir, ownerDir });

function holdAgentProfile(): void {
	const derived = deriveAgent(deriveBranch(org(), BRANCH), AGENT_ID, 0);
	saveAgentKeys(configDir, AGENT_ID, agentKeysFromDerived(derived));
	saveProfiles(configDir, {
		default: {
			org_id: org().orgId,
			principal: `agent:${AGENT_ID}`,
			agent_id: AGENT_ID,
			branch: BRANCH,
		},
	});
}

beforeEach(() => {
	tmp = fs.mkdtempSync(join(tmpdir(), "rine-tui-identity-"));
	configDir = join(tmp, "config");
	ownerDir = join(tmp, "owner");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(ownerDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveIdentity", () => {
	it("test_resolveIdentity_when_owner_dir_holds_root_then_reader_of_that_org", () => {
		saveRoot(ownerDir, FIXTURE_ROOT);
		const result = resolve();
		expect(result.kind).toBe(IdentityKind.Reader);
		if (result.kind !== IdentityKind.Reader) return;
		expect(result.key.orgId).toBe(org().orgId);
		result.key.dispose();
	});

	it("test_resolveIdentity_when_reader_closed_then_it_disposes_the_key", async () => {
		saveRoot(ownerDir, FIXTURE_ROOT);
		const result = resolve();
		expect(result.kind).toBe(IdentityKind.Reader);
		if (result.kind !== IdentityKind.Reader) return;
		await result.reader.close();
		expect(() => result.key.signer).toThrow("ReadKey is disposed");
	});

	it("test_resolveIdentity_when_root_and_agent_profile_then_the_root_wins", () => {
		saveRoot(ownerDir, FIXTURE_ROOT);
		holdAgentProfile();
		const result = resolve();
		expect(result.kind).toBe(IdentityKind.Reader);
		if (result.kind === IdentityKind.Reader) result.key.dispose();
	});

	it("test_resolveIdentity_when_org_id_in_profile_is_foreign_then_the_org_id_still_comes_from_the_root", () => {
		saveRoot(ownerDir, FIXTURE_ROOT);
		saveProfiles(ownerDir, {
			default: {
				org_id: "99999999-9999-4999-8999-999999999999",
				principal: `org:${org().orgId}`,
			},
		});
		const result = resolve();
		expect(result.kind).toBe(IdentityKind.Reader);
		if (result.kind !== IdentityKind.Reader) return;
		expect(result.key.orgId).toBe(org().orgId);
		result.key.dispose();
	});

	it("test_resolveIdentity_when_only_a_branch_directory_then_needs_org_key", () => {
		fs.mkdirSync(join(configDir, "branch", BRANCH), { recursive: true });
		expect(resolve()).toEqual({ kind: IdentityKind.Blocked, code: FeedErrorCode.NeedsOrgKey });
	});

	it("test_resolveIdentity_when_only_a_branch_reader_profile_then_needs_org_key", () => {
		saveProfiles(configDir, {
			default: {
				org_id: org().orgId,
				principal: `reader:${org().orgId}:${BRANCH}`,
				branch: BRANCH,
			},
		});
		fs.mkdirSync(join(configDir, "branch", BRANCH), { recursive: true });
		expect(resolve()).toEqual({ kind: IdentityKind.Blocked, code: FeedErrorCode.NeedsOrgKey });
	});

	it("test_resolveIdentity_when_only_an_agent_profile_then_needs_org_key", () => {
		holdAgentProfile();
		expect(resolve()).toEqual({ kind: IdentityKind.Blocked, code: FeedErrorCode.NeedsOrgKey });
	});

	it("test_resolveIdentity_when_nothing_is_held_then_no_identity", () => {
		expect(resolve()).toEqual({ kind: IdentityKind.Blocked, code: FeedErrorCode.NoIdentity });
	});

	it("test_resolveIdentity_when_a_file_named_branch_then_no_identity", () => {
		fs.writeFileSync(join(configDir, "branch"), "x");
		expect(resolve()).toEqual({ kind: IdentityKind.Blocked, code: FeedErrorCode.NoIdentity });
	});
});
