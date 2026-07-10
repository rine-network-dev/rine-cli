import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import * as core from "@rine-network/core";
import * as actionModule from "../src/action.js";
import * as outputModule from "../src/output.js";
import * as agentFormatModule from "../src/agent-format.js";
import { registerOnboard } from "../src/commands/onboard.js";

// Suppress console output during tests
beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

const BASE_ARGS = [
	"node",
	"rine",
	"onboard",
	"--email",
	"test@example.com",
	"--name",
	"Test Org",
	"--slug",
	"test-org",
	"--agent",
	"my-agent",
];

const MOCK_AGENT: core.AgentRead = {
	id: "agent-uuid",
	name: "my-agent",
	handle: "my-agent@test-org.rine.network",
	incoming_policy: "open",
	outgoing_policy: "open",
	human_oversight: true,
	unlisted: false,
	created_at: "2026-01-01T00:00:00Z",
	revoked_at: null,
	verification_words: "alpha beta gamma",
	poll_url: "https://rine.network/poll/token",
};

const MOCK_REG_RESULT = {
	org_id: "org-uuid",
	client_id: "client-uuid",
};

const MOCK_ORG = { id: "org-uuid", slug: "test-org", name: "Test Org" };
const MOCK_AGENTS_LIST: core.ListResponse<core.AgentRead> = {
	items: [MOCK_AGENT],
	total: 1,
};

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerOnboard(program);
	return program;
}

describe("onboard command — invalid slug", () => {
	beforeEach(() => {
		vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
		vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
		vi.spyOn(core, "validateSlug").mockReturnValue(false);
		vi.spyOn(core, "getCredentialEntry").mockReturnValue(undefined);
	});

	it("prints error and sets exitCode=1 without calling registration", async () => {
		const printErrorSpy = vi.spyOn(outputModule, "printError");
		const performRegistrationSpy = vi
			.spyOn(core, "performRegistration")
			.mockResolvedValue(MOCK_REG_RESULT);

		const program = makeProgram();
		await program.parseAsync(BASE_ARGS);

		expect(printErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Invalid slug"),
		);
		expect(process.exitCode).toBe(1);
		expect(performRegistrationSpy).not.toHaveBeenCalled();
	});
});

describe("onboard command — already registered (idempotency)", () => {
	let mockClient: { get: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
		vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
		vi.spyOn(core, "validateSlug").mockReturnValue(true);
		vi.spyOn(core, "getCredentialEntry").mockReturnValue({
			client_id: "existing-id",
			client_secret: "existing-secret",
		});

		mockClient = { get: vi.fn() };
		mockClient.get.mockImplementation((path: string) => {
			if (path === "/org") return Promise.resolve(MOCK_ORG);
			if (path === "/agents") return Promise.resolve(MOCK_AGENTS_LIST);
			return Promise.reject(new Error(`Unknown path: ${path}`));
		});

		vi.spyOn(actionModule, "createClient").mockResolvedValue({
			client: mockClient as unknown as core.HttpClient,
			profileName: "default",
			entry: { client_id: "existing-id", client_secret: "existing-secret" },
		});
	});

	it("fetches /org and /agents, prints info in text mode, skips registration", async () => {
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});
		const performRegistrationSpy = vi
			.spyOn(core, "performRegistration")
			.mockResolvedValue(MOCK_REG_RESULT);

		const program = makeProgram({ json: false });
		await program.parseAsync(BASE_ARGS);

		expect(mockClient.get).toHaveBeenCalledWith("/org");
		expect(mockClient.get).toHaveBeenCalledWith("/agents");
		expect(printTableSpy).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ ID: MOCK_AGENT.id }),
			]),
		);
		expect(performRegistrationSpy).not.toHaveBeenCalled();
	});

	it("outputs JSON with status=already_registered in json mode", async () => {
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(BASE_ARGS);

		expect(printJsonSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "already_registered",
				org: MOCK_ORG,
				agents: MOCK_AGENTS_LIST,
			}),
		);
	});

	it("does not call performRegistration", async () => {
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
		const performRegistrationSpy = vi
			.spyOn(core, "performRegistration")
			.mockResolvedValue(MOCK_REG_RESULT);

		const program = makeProgram();
		await program.parseAsync(BASE_ARGS);

		expect(performRegistrationSpy).not.toHaveBeenCalled();
	});
});

describe("onboard command — happy path (text mode)", () => {
	let mockClient: { get: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
		vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
		vi.spyOn(core, "validateSlug").mockReturnValue(true);
		vi.spyOn(core, "getCredentialEntry").mockReturnValue(undefined);
		vi.spyOn(core, "performRegistration").mockResolvedValue(MOCK_REG_RESULT);
		vi.spyOn(core, "performAgentCreation").mockResolvedValue(MOCK_AGENT);

		mockClient = { get: vi.fn() };
		vi.spyOn(actionModule, "createClient").mockResolvedValue({
			client: mockClient as unknown as core.HttpClient,
			profileName: "default",
			entry: undefined,
		});
	});

	it("calls performRegistration with correct params", async () => {
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
		vi.spyOn(agentFormatModule, "toAgentRow").mockReturnValue({
			ID: MOCK_AGENT.id,
			Name: MOCK_AGENT.name,
			Handle: MOCK_AGENT.handle,
			"Human Oversight": "true",
			Created: MOCK_AGENT.created_at,
		});

		const program = makeProgram({ json: false });
		await program.parseAsync(BASE_ARGS);

		expect(core.performRegistration).toHaveBeenCalledWith(
			"https://test.rine.network",
			"/tmp/test-rine",
			"default",
			{ email: "test@example.com", slug: "test-org", name: "Test Org" },
			expect.any(Function),
		);
	});

	it("calls performAgentCreation after registration", async () => {
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
		vi.spyOn(agentFormatModule, "toAgentRow").mockReturnValue({
			ID: MOCK_AGENT.id,
			Name: MOCK_AGENT.name,
			Handle: MOCK_AGENT.handle,
			"Human Oversight": "true",
			Created: MOCK_AGENT.created_at,
		});

		const program = makeProgram({ json: false });
		await program.parseAsync(BASE_ARGS);

		expect(core.performAgentCreation).toHaveBeenCalledWith(
			mockClient,
			"/tmp/test-rine",
			"default",
			expect.objectContaining({ name: "my-agent" }),
		);
	});

	it("calls printTable with toAgentRow result", async () => {
		const agentRow = {
			ID: MOCK_AGENT.id,
			Name: MOCK_AGENT.name,
			Handle: MOCK_AGENT.handle,
			"Human Oversight": "true",
			Created: MOCK_AGENT.created_at,
		};
		vi.spyOn(agentFormatModule, "toAgentRow").mockReturnValue(agentRow);
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(BASE_ARGS);

		expect(agentFormatModule.toAgentRow).toHaveBeenCalledWith(
			MOCK_AGENT,
			expect.objectContaining({ includeCard: true, includeVerificationWords: true }),
		);
		expect(printTableSpy).toHaveBeenCalledWith([agentRow]);
	});
});

describe("onboard command — happy path (JSON mode)", () => {
	let mockClient: { get: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
		vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
		vi.spyOn(core, "validateSlug").mockReturnValue(true);
		vi.spyOn(core, "getCredentialEntry").mockReturnValue(undefined);
		vi.spyOn(core, "performRegistration").mockResolvedValue(MOCK_REG_RESULT);
		vi.spyOn(core, "performAgentCreation").mockResolvedValue(MOCK_AGENT);

		mockClient = { get: vi.fn() };
		vi.spyOn(actionModule, "createClient").mockResolvedValue({
			client: mockClient as unknown as core.HttpClient,
			profileName: "default",
			entry: undefined,
		});
	});

	it("calls printJson with org_id, client_id, agent, poll_url, config_dir", async () => {
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(BASE_ARGS);

		expect(printJsonSpy).toHaveBeenCalledWith({
			org_id: MOCK_REG_RESULT.org_id,
			client_id: MOCK_REG_RESULT.client_id,
			agent: MOCK_AGENT,
			poll_url: MOCK_AGENT.poll_url,
			identity: undefined,
			config_dir: "/tmp/test-rine",
		});
	});

	it("does not call printTable in json mode", async () => {
		vi.spyOn(outputModule, "printJson").mockImplementation(() => {});
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(BASE_ARGS);

		expect(printTableSpy).not.toHaveBeenCalled();
	});
});

describe("onboard command — error handling", () => {
	beforeEach(() => {
		vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
		vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
		vi.spyOn(core, "validateSlug").mockReturnValue(true);
		vi.spyOn(core, "getCredentialEntry").mockReturnValue(undefined);
	});

	it("handles error from performRegistration via withErrorHandler", async () => {
		vi.spyOn(core, "performRegistration").mockRejectedValue(
			new core.RineApiError(500, "Server Error"),
		);
		const printErrorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});

		const program = makeProgram();
		await program.parseAsync(BASE_ARGS);

		expect(printErrorSpy).toHaveBeenCalledWith("Server Error");
		expect(process.exitCode).toBe(1);
	});
});
