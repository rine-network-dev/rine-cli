import * as core from "@rine-network/core";
import { Command } from "commander";
import {
	type MockInstance,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { registerRegister } from "../src/commands/register.js";
import * as outputModule from "../src/output.js";

const CONFIG_DIR = "/tmp/test-rine";
const OWNER_DIR = "/tmp/owner";
const PHRASE_PATH = "/tmp/owner/recovery-phrase.txt";
const PHRASE = "zebra yacht xenon wombat violin utopia tiger sapphire";
const REGISTRATION: core.RegistrationResult = {
	org_id: "org-uuid",
	org_words: "w1 w2 w3 w4 w5 w6 w7 w8",
	phrase_path: PHRASE_PATH,
};
const ARGS = [
	"node",
	"rine",
	"register",
	"--email",
	"a@b.co",
	"--name",
	"Acme",
	"--slug",
	"acme",
];

let captured: string[];
let registration: MockInstance<typeof core.performRegistration>;

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerRegister(program);
	return program;
}

function setStdoutTty(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
	captured = [];
	const keep = (...args: unknown[]) => {
		captured.push(args.map(String).join(" "));
	};
	vi.spyOn(console, "log").mockImplementation(keep);
	vi.spyOn(console, "error").mockImplementation(keep);
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		keep(chunk);
		return true;
	});
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		keep(chunk);
		return true;
	});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue(OWNER_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "readOwnerPhrase").mockReturnValue(PHRASE);
	// The proof of work is the only stub: it takes 30-60 s and needs a server.
	registration = vi.spyOn(core, "performRegistration").mockResolvedValue(REGISTRATION);
	setStdoutTty(false);
});

afterEach(() => {
	setStdoutTty(false);
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

describe("register", () => {
	it("registers under the resolved dirs and profile with the typed identity", async () => {
		await makeProgram({ profile: "work" }).parseAsync(ARGS);

		expect(registration).toHaveBeenCalledTimes(1);
		const [apiUrl, dirs, profile, identity, onProgress] =
			registration.mock.calls[0] ?? [];
		expect(apiUrl).toBe("https://test.rine.network");
		expect(dirs).toEqual({ configDir: CONFIG_DIR, ownerDir: OWNER_DIR });
		expect(profile).toBe("work");
		expect(identity).toEqual({ email: "a@b.co", slug: "acme", name: "Acme" });
		expect(typeof onProgress).toBe("function");
	});

	it("without a terminal prints the phrase file's path and never its words", async () => {
		await makeProgram().parseAsync(ARGS);

		const out = captured.join("\n");
		expect(out).toContain(`Recovery phrase file: ${PHRASE_PATH}`);
		expect(out).toContain(core.PHRASE_INSTRUCTION);
		expect(out).toContain("Org id: org-uuid");
		expect(out).toContain(`Org verification words: ${REGISTRATION.org_words}`);
		expect(out).not.toContain(PHRASE);
	});

	it("on a terminal shows the phrase once, framed", async () => {
		setStdoutTty(true);

		await makeProgram().parseAsync(ARGS);

		expect(captured.join("\n")).toContain(PHRASE);
	});

	it("--json emits the org and the phrase PATH, with the words nowhere", async () => {
		setStdoutTty(true);
		const printJson = vi.spyOn(outputModule, "printJson").mockImplementation(() => {});

		await makeProgram({ json: true }).parseAsync(ARGS);

		expect(printJson).toHaveBeenCalledWith({
			org_id: "org-uuid",
			org_words: REGISTRATION.org_words,
			recovery_phrase_file: PHRASE_PATH,
		});
		expect(captured.join("\n")).not.toContain(PHRASE);
	});

	it("refuses without the required options", async () => {
		const program = makeProgram();
		program.exitOverride();
		program.configureOutput({ writeErr: () => {} });

		await expect(
			program.parseAsync(["node", "rine", "register", "--email", "a@b.co"]),
		).rejects.toThrow();
		expect(registration).not.toHaveBeenCalled();
	});
});
