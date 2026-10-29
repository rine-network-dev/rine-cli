import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import * as core from "@rine-network/core";
import * as actionModule from "../src/action.js";
import * as outputModule from "../src/output.js";
import * as agentFormatModule from "../src/agent-format.js";
import { registerOnboard } from "../src/commands/onboard.js";

const CONFIG_DIR = "/tmp/test-rine";
const OWNER_DIR = "/tmp/owner";
const PHRASE_PATH = "/tmp/owner/recovery-phrase.txt";

/** Everything the command wrote to a screen, in order. */
let captured: string[] = [];

function capturedText(): string {
	return captured.join("\n");
}

// Capture console output during tests instead of letting it reach the runner.
beforeEach(() => {
	captured = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		captured.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		captured.push(args.map(String).join(" "));
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		captured.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		captured.push(String(chunk));
		return true;
	});
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
	"--agent-name",
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

const MOCK_REG_RESULT: core.RegistrationResult = {
	org_id: "org-uuid",
	org_words: "w1 w2 w3 w4 w5 w6 w7 w8",
	phrase_path: PHRASE_PATH,
};

const MOCK_ORG = { id: "org-uuid", slug: "test-org", name: "Test Org" };
const MOCK_AGENTS_LIST: core.ListResponse<core.AgentRead> = {
	items: [MOCK_AGENT],
	total: 1,
};

/** The dirs the command resolves, and the identity state of a fresh owner dir. */
function mockFreshPath(): void {
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue(OWNER_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "validateSlug").mockReturnValue(true);
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
}

/**
 * An onboard program wired the way `main.ts` wires one.
 *
 * `refusing` makes Commander throw its refusals instead of exiting the test
 * runner, and silences the usage text it would otherwise write to stderr — the
 * only difference between a run that is expected to work and one that is
 * expected to be turned away.
 */
function makeProgram(
	globalOpts: Record<string, unknown> = {},
	{ refusing = false }: { refusing?: boolean } = {},
): Command {
	const program = new Command();
	if (refusing) {
		program.exitOverride();
		program.configureOutput({ writeErr: () => {} });
	}
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerOnboard(program);
	return program;
}

describe("onboard command — invalid slug", () => {
	beforeEach(() => {
		mockFreshPath();
		vi.spyOn(core, "validateSlug").mockReturnValue(false);
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

// `--agent` named the agent being created, never an agent reference.
// It is now `--agent-name`, and the old spelling is accepted by nothing: an
// onboard run from a stale script stops before it registers an org.
describe("onboard command — the retired --agent spelling is gone", () => {
	beforeEach(() => {
		mockFreshPath();
	});

	const refusingProgram = () => makeProgram({}, { refusing: true });

	// Commander checks its mandatory options before it reports an unknown one,
	// so a run that gives `--agent` and nothing else surfaces the stale spelling
	// as the missing new one — which is the sentence that tells the caller what
	// to type. Either way nothing is registered.
	it("refuses --agent by naming --agent-name, before any registration", async () => {
		const performRegistrationSpy = vi
			.spyOn(core, "performRegistration")
			.mockResolvedValue(MOCK_REG_RESULT);

		await expect(
			refusingProgram().parseAsync([
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
			]),
		).rejects.toThrow(/required option '--agent-name/);
		expect(performRegistrationSpy).not.toHaveBeenCalled();
	});

	it("still refuses --agent when --agent-name is also given", async () => {
		const performRegistrationSpy = vi
			.spyOn(core, "performRegistration")
			.mockResolvedValue(MOCK_REG_RESULT);

		await expect(
			refusingProgram().parseAsync([...BASE_ARGS, "--agent", "my-agent"]),
		).rejects.toThrow(/unknown option '--agent'/);
		expect(performRegistrationSpy).not.toHaveBeenCalled();
	});
});

describe("onboard command — already registered (idempotency)", () => {
	let mockClient: { get: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		mockFreshPath();
		// A resolvable identity is the guard: this owner dir already holds a root.
		vi.spyOn(core, "resolveAuth").mockReturnValue({
			signer: {} as core.ResolvedAuth["signer"],
			orgId: "org-uuid",
			cacheDir: OWNER_DIR,
		});

		mockClient = { get: vi.fn() };
		mockClient.get.mockImplementation((path: string) => {
			if (path === "/whoami")
				return Promise.resolve({ org: MOCK_ORG, principal: {}, agents: [] });
			if (path === "/agents") return Promise.resolve(MOCK_AGENTS_LIST);
			return Promise.reject(new Error(`Unknown path: ${path}`));
		});

		vi.spyOn(actionModule, "createClient").mockResolvedValue({
			client: mockClient as unknown as core.HttpClient,
			profileName: "default",
			dirs: { configDir: CONFIG_DIR, ownerDir: OWNER_DIR },
			auth: undefined,
			token: async () => "token",
		});
	});

	it("fetches /whoami and /agents, prints info in text mode, skips registration", async () => {
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});
		const performRegistrationSpy = vi
			.spyOn(core, "performRegistration")
			.mockResolvedValue(MOCK_REG_RESULT);

		const program = makeProgram({ json: false });
		await program.parseAsync(BASE_ARGS);

		expect(mockClient.get).toHaveBeenCalledWith("/whoami");
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
		mockFreshPath();
		vi.spyOn(core, "performRegistration").mockResolvedValue(MOCK_REG_RESULT);
		vi.spyOn(core, "performAgentCreation").mockResolvedValue(MOCK_AGENT);

		mockClient = { get: vi.fn() };
		vi.spyOn(actionModule, "createClient").mockResolvedValue({
			client: mockClient as unknown as core.HttpClient,
			profileName: "default",
			dirs: { configDir: CONFIG_DIR, ownerDir: OWNER_DIR },
			auth: undefined,
			token: async () => "token",
		});
	});

	it("calls performRegistration with the resolved custody dirs", async () => {
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
		vi.spyOn(agentFormatModule, "toAgentRow").mockReturnValue({
			ID: MOCK_AGENT.id,
			Name: MOCK_AGENT.name,
			Handle: MOCK_AGENT.handle ?? MOCK_AGENT.id,
			"Human Oversight": "true",
			Created: MOCK_AGENT.created_at,
		});

		const program = makeProgram({ json: false });
		await program.parseAsync(BASE_ARGS);

		expect(core.performRegistration).toHaveBeenCalledWith(
			"https://test.rine.network",
			{ configDir: CONFIG_DIR, ownerDir: OWNER_DIR },
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
			Handle: MOCK_AGENT.handle ?? MOCK_AGENT.id,
			"Human Oversight": "true",
			Created: MOCK_AGENT.created_at,
		});

		const program = makeProgram({ json: false });
		await program.parseAsync(BASE_ARGS);

		expect(core.performAgentCreation).toHaveBeenCalledWith(
			mockClient,
			{ configDir: CONFIG_DIR, ownerDir: OWNER_DIR },
			"default",
			expect.objectContaining({ name: "my-agent" }),
		);
	});

	it("calls printTable with toAgentRow result", async () => {
		const agentRow = {
			ID: MOCK_AGENT.id,
			Name: MOCK_AGENT.name,
			Handle: MOCK_AGENT.handle ?? MOCK_AGENT.id,
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
			expect.objectContaining({
				includeCard: true,
				// The row is handed the COMPARISON, never a "print the words"
				// flag — a surface with no local key cannot reach a state where
				// it prints the server's string as its own.
				verification: expect.objectContaining({ status: "not-computed" }),
			}),
		);
		expect(printTableSpy).toHaveBeenCalledWith([agentRow]);
	});

	it("prints the org verification words", async () => {
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(BASE_ARGS);

		expect(capturedText()).toContain(
			`Org verification words: ${MOCK_REG_RESULT.org_words}`,
		);
	});
});

describe("onboard command — happy path (JSON mode)", () => {
	let mockClient: { get: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		mockFreshPath();
		vi.spyOn(core, "performRegistration").mockResolvedValue(MOCK_REG_RESULT);
		vi.spyOn(core, "performAgentCreation").mockResolvedValue(MOCK_AGENT);

		mockClient = { get: vi.fn() };
		vi.spyOn(actionModule, "createClient").mockResolvedValue({
			client: mockClient as unknown as core.HttpClient,
			profileName: "default",
			dirs: { configDir: CONFIG_DIR, ownerDir: OWNER_DIR },
			auth: undefined,
			token: async () => "token",
		});
	});

	it("calls printJson with org_id, org_words, recovery_phrase_file, agent, poll_url, config_dir, owner_dir", async () => {
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(BASE_ARGS);

		expect(printJsonSpy).toHaveBeenCalledWith({
			org_id: MOCK_REG_RESULT.org_id,
			org_words: MOCK_REG_RESULT.org_words,
			recovery_phrase_file: MOCK_REG_RESULT.phrase_path,
			agent: MOCK_AGENT,
			// The comparison ships as its own field, both values and a
			// boolean, beside the agent rather than folded into it. This config
			// dir holds no key for the mocked agent, so it is `not-computed` —
			// which is exactly the state a surface must not print as if it had
			// recomputed anything.
			verification: {
				status: "not-computed",
				computed: null,
				asserted: MOCK_AGENT.verification_words,
				match: null,
			},
			poll_url: MOCK_AGENT.poll_url,
			identity: undefined,
			identity_error: undefined,
			config_dir: CONFIG_DIR,
			owner_dir: OWNER_DIR,
		});
	});

	it("emits recovery_phrase_file and never a client_id", async () => {
		const program = makeProgram({ json: true });
		await program.parseAsync(BASE_ARGS);

		const text = capturedText();
		expect(text).toContain("recovery_phrase_file");
		expect(text).toContain(MOCK_REG_RESULT.phrase_path);
		expect(text).not.toContain("client_id");
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

describe("onboard command — the recovery phrase never leaks", () => {
	const PHRASE =
		"abandon ability able about above absent absorb abstract absurd abuse access accident " +
		"account achieve acid acoustic acquire across act action actor actress actual";

	beforeEach(() => {
		mockFreshPath();
		vi.spyOn(core, "performRegistration").mockResolvedValue(MOCK_REG_RESULT);
		vi.spyOn(core, "performAgentCreation").mockResolvedValue(MOCK_AGENT);
		vi.spyOn(core, "readOwnerPhrase").mockReturnValue(PHRASE);
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
		vi.spyOn(actionModule, "createClient").mockResolvedValue({
			client: { get: vi.fn() } as unknown as core.HttpClient,
			profileName: "default",
			dirs: { configDir: CONFIG_DIR, ownerDir: OWNER_DIR },
			auth: undefined,
			token: async () => "token",
		});
	});

	it("never prints the words when stdout is not a TTY", async () => {
		const original = process.stdout.isTTY;
		process.stdout.isTTY = false;
		try {
			const program = makeProgram({ json: false });
			await program.parseAsync(BASE_ARGS);
		} finally {
			process.stdout.isTTY = original;
		}

		expect(capturedText()).not.toContain(PHRASE);
		expect(capturedText()).toContain(PHRASE_PATH);
	});

	it("prints the words exactly once on a terminal outside --json", async () => {
		const original = process.stdout.isTTY;
		process.stdout.isTTY = true;
		try {
			const program = makeProgram({ json: false });
			await program.parseAsync(BASE_ARGS);
		} finally {
			process.stdout.isTTY = original;
		}

		const occurrences = capturedText().split(PHRASE).length - 1;
		expect(occurrences).toBe(1);
	});
});

describe("onboard command — error handling", () => {
	beforeEach(() => {
		mockFreshPath();
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
