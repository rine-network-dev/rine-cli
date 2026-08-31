import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessages } from "../src/commands/messages.js";
import * as outputModule from "../src/output.js";

// `rine read` must recognise hpke-hybrid-v1 messages as decryptable. The
// hybrid PQ work added a new encryption_version, but the read command's
// canDecrypt gate originally only matched hpke-v1 and sender-key-v1, so hybrid
// messages silently fell through to the raw "Encrypted Payload" fallback and
// were never decrypted.
//
// These tests drive the REAL `read` command with a message whose
// encryption_version === "hpke-hybrid-v1". canDecrypt is the gate that
// decides whether core.decryptMessage is invoked at all. Reverting the fix
// (dropping "hpke-hybrid-v1" from the canDecrypt union) makes canDecrypt
// false, so decryptMessage is never called and the decrypted payload is
// never shown — failing every assertion below.
//
// SCOPE — IMPORTANT: these CLI tests cover ONLY the CLI-layer gate
// (`canDecrypt` in src/commands/messages.ts) and the read command's
// observable rendering. core.decryptMessage is intentionally mocked here,
// so these tests do NOT exercise the cryptographic VERSION_HYBRID
// byte-routing inside core/crypto/message.ts. That dispatch — including the
// regression where a hpke-hybrid-v1 ciphertext must NOT silently fall back
// to classical HPKE — is owned by rine-core/test/crypto/message-hybrid.test.ts
// (see its `describe("decryptMessage version dispatch")` block). Keep the
// split intentional: do not try to assert real PQ decryption here.

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const MESSAGE_ID = "msg-hybrid-1";

const HYBRID_MESSAGE: core.MessageRead = {
	id: MESSAGE_ID,
	conversation_id: "conv-1",
	type: "rine.v1.dm",
	from_agent_id: "22222222-2222-2222-2222-222222222222",
	to_agent_id: AGENT_ID,
	sender_handle: "alice@org.rine.network",
	recipient_handle: "bot@org.rine.network",
	encrypted_payload: "AABBCCDD-hybrid-ciphertext",
	encryption_version: "hpke-hybrid-v1",
	created_at: "2026-01-15T12:00:00Z",
} as unknown as core.MessageRead;

const DECRYPT_RESULT = {
	plaintext: JSON.stringify({ hello: "post-quantum" }),
	senderKid: "rine:22222222-2222-2222-2222-222222222222",
	verified: true,
	verificationStatus: "verified" as const,
};

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");

	// withClient (action.ts) builds a real HttpClient internally, so intercept
	// the GET at the prototype level rather than mocking createClient.
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			if (path === `/messages/${MESSAGE_ID}`) {
				return Promise.resolve(HYBRID_MESSAGE);
			}
			return Promise.reject(new Error(`Unknown path: ${path}`));
		},
	);
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, handle: "bot@org.rine.network" } as never,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });
	// Recipient holds local keys, so canDecrypt depends purely on the version.
	vi.spyOn(core, "agentKeysExist").mockReturnValue(true);
	vi.spyOn(core, "ingestSenderKeyDistribution").mockReturnValue(false);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerMessages(program);
	return program;
}

describe("thread command — role-tagged transcript", () => {
	// A UUID because the server types this path parameter `uuid.UUID` and always
	// has: `conv-7` was a fixture no live conversation could have matched, and
	// the command now says so before it spends the request.
	const CONV_ID = "77777777-7777-7777-7777-777777777777";
	const THREAD_ENTRIES = [
		{
			direction: "sent" as const,
			sender_handle: "bot@org.rine.network",
			text: "my question",
			verification_status: "verified" as const,
			type: "rine.v1.task_request",
			created_at: "2026-01-15T12:00:00Z",
		},
		{
			direction: "received" as const,
			sender_handle: "alice@org.rine.network",
			text: "their answer",
			verification_status: "verified" as const,
			type: "rine.v1.task_response",
			created_at: "2026-01-15T12:00:01Z",
		},
	];

	beforeEach(() => {
		// The conversations endpoint returns the both-sided page; decryptThreadRows
		// is unit-covered in rine-core, so stub it to the rendered entries here and
		// assert on the CLI-layer rendering (decrypted tool OUTPUT).
		//
		// The PLURAL call is what the command makes, and deliberately so: the whole
		// render is one call, which is what lets rine-core say why an unopenable
		// group message stayed shut once per transcript instead of once per row.
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
			(path: string) => {
				if (path === `/conversations/${CONV_ID}/messages`) {
					return Promise.resolve({ messages: [{}, {}], truncated: false });
				}
				return Promise.reject(new Error(`Unknown path: ${path}`));
			},
		);
		vi.spyOn(core, "decryptThreadRows").mockResolvedValue(THREAD_ENTRIES);
	});

	it("prints both [sent] and [received] rows in order", async () => {
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "thread", CONV_ID]);

		const rows = printTableSpy.mock.calls.at(-1)?.[0] as Array<
			Record<string, unknown>
		>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			Direction: "[sent]",
			From: "you",
			Text: "my question",
		});
		expect(rows[1]).toMatchObject({
			Direction: "[received]",
			From: "alice@org.rine.network",
			Text: "their answer",
		});
	});

	it("--json emits the decrypted entry array", async () => {
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "thread", CONV_ID]);

		expect(printJsonSpy).toHaveBeenCalledWith(THREAD_ENTRIES);
	});
});

describe("thread command — reading a group", () => {
	const GROUP_ID = "88888888-8888-8888-8888-888888888888";
	const CONV_ID = "77777777-7777-7777-7777-777777777777";

	function stubPaths(): string[] {
		const seen: string[] = [];
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
			(path: string) => {
				seen.push(path);
				if (path === "/groups") {
					return Promise.resolve({
						items: [{ id: GROUP_ID, handle: "#ops@acme.rine.network" }],
					});
				}
				return Promise.resolve({ messages: [], truncated: false });
			},
		);
		vi.spyOn(core, "decryptThreadRows").mockResolvedValue([]);
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
		return seen;
	}

	it("reads the group's own route when --group names a handle", async () => {
		const seen = stubPaths();
		const program = makeProgram({ json: false });
		await program.parseAsync([
			"node",
			"rine",
			"thread",
			"--group",
			"#ops@acme",
		]);
		expect(seen).toEqual(["/groups", `/groups/${GROUP_ID}/messages`]);
	});

	it("refuses both references before it spends a request", async () => {
		const seen = stubPaths();
		// `fetchAgents` is the acting-agent lookup this command used to spend
		// BEFORE deciding the reference — a refusal advertised as free that cost a
		// round trip. It is stubbed here rather than driven, so the assertion below
		// is that it was never asked.
		const agents = vi.mocked(core.fetchAgents);
		agents.mockClear();
		const errors = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		const program = makeProgram({ json: false });
		await program.parseAsync([
			"node",
			"rine",
			"thread",
			CONV_ID,
			"--group",
			"#ops@acme",
		]);
		expect(seen).toEqual([]);
		expect(agents).not.toHaveBeenCalled();
		expect(errors.mock.calls.at(-1)?.[0]).toContain(
			"Name exactly one of --group (a group handle, name or UUID) or " +
				"<conversation-id> (a conversation UUID).",
		);
	});

	it("tells a caller who named a group to the conversation argument where it goes", async () => {
		const seen = stubPaths();
		const errors = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "thread", "#ops@acme"]);
		expect(seen).toEqual([]);
		// 🔴 The placeholder ban, second rung. This printed
		// `--group=#logistics@acme.rine.network` until the worked example was
		// retired: a model was measured inventing the local part
		// and pasting the printed domain back verbatim. The refusal still names
		// the argument that takes a group, and lists the three spellings it
		// accepts, with no handle of its own to copy.
		expect(errors.mock.calls.at(-1)?.[0]).toContain(
			"To read a group, name the group instead — --group takes a group's " +
				"whole handle, a bare group name, or its UUID.",
		);
	});
});

describe("read command — hpke-hybrid-v1 is decryptable", () => {
	it("invokes decryptMessage for a hybrid message", async () => {
		const decryptSpy = vi
			.spyOn(core, "decryptMessage")
			.mockResolvedValue(DECRYPT_RESULT);
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		// Reverting the fix makes canDecrypt false → this is never called.
		expect(decryptSpy).toHaveBeenCalledTimes(1);
		expect(decryptSpy).toHaveBeenCalledWith(
			"/tmp/test-rine",
			AGENT_ID,
			HYBRID_MESSAGE.encrypted_payload,
			expect.any(core.HttpClient),
			// The envelope is checked against the row's server-authenticated sender.
			HYBRID_MESSAGE.from_agent_id,
		);

		// Observable outcome: the rendered row must be the decrypted view, not
		// the raw "Encrypted Payload" fallback. This guards against decryptMessage
		// being invoked but its result never reaching the output.
		const row = printTableSpy.mock.calls.at(-1)?.[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(row).not.toHaveProperty("Encrypted Payload");
	});

	it("renders the decrypted payload, not the raw encrypted fallback (text)", async () => {
		vi.spyOn(core, "decryptMessage").mockResolvedValue(DECRYPT_RESULT);
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		const row = printTableSpy.mock.calls.at(-1)?.[0]?.[0] as Record<
			string,
			unknown
		>;
		// Decrypted path emits a Payload/Verified row; the raw fallback would
		// instead emit "Encrypted Payload" + "Encryption" keys.
		expect(row).toHaveProperty(
			"Payload",
			DECRYPT_RESULT.plaintext.slice(0, 200),
		);
		expect(row).toHaveProperty("Verified", "✓");
		expect(row).not.toHaveProperty("Encrypted Payload");
		expect(row).not.toHaveProperty("Encryption");
	});

	it("emits decrypted_payload in JSON mode for a hybrid message", async () => {
		vi.spyOn(core, "decryptMessage").mockResolvedValue(DECRYPT_RESULT);
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		expect(printJsonSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: MESSAGE_ID,
				decrypted_payload: { hello: "post-quantum" },
				signature_verified: true,
				verification_status: "verified",
			}),
		);
	});

	it("leaves a message with no server-authenticated sender encrypted", async () => {
		// Nothing to check the envelope's claim of authorship against, so the row
		// is shown as it arrived rather than opened on trust.
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
			(path: string) => {
				if (path === `/messages/${MESSAGE_ID}`) {
					return Promise.resolve({
						...HYBRID_MESSAGE,
						from_agent_id: undefined,
					});
				}
				return Promise.resolve({ items: [{ id: AGENT_ID, name: "bot" }] });
			},
		);
		const decryptSpy = vi
			.spyOn(core, "decryptMessage")
			.mockResolvedValue(DECRYPT_RESULT);
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		expect(decryptSpy).not.toHaveBeenCalled();
		const arg = printJsonSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(arg).not.toHaveProperty("decrypted_payload");
	});

	it("marks a message signed by someone other than its sender, not a bare ✓", async () => {
		vi.spyOn(core, "decryptMessage").mockResolvedValue({
			...DECRYPT_RESULT,
			verified: false,
			verificationStatus: "sender-mismatch",
		});
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		const row = printTableSpy.mock.calls.at(-1)?.[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(row.Verified).toBe("✗ SENDER MISMATCH");
	});

	it("falls back to raw encrypted output when hybrid decryption fails", async () => {
		// Distinct branch from the success cases above: canDecrypt is still true
		// for a hybrid message (so the gate is exercised), but decryptMessage
		// rejects. The read command must then emit the raw message WITHOUT a
		// decrypted_payload key rather than crashing or pretending it decrypted.
		const decryptSpy = vi
			.spyOn(core, "decryptMessage")
			.mockRejectedValue(new Error("pq private key missing"));
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		// The gate let us reach decryptMessage (proves canDecrypt was true for
		// the hybrid version)...
		expect(decryptSpy).toHaveBeenCalledTimes(1);
		// ...but decryption threw, so the raw fallback is emitted instead.
		const arg = printJsonSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(arg).not.toHaveProperty("decrypted_payload");
		expect(arg).toHaveProperty("encryption_version", "hpke-hybrid-v1");
	});
});
describe("read command — a group message whose sender key never arrived", () => {
	const GROUP_MESSAGE_ID = "msg-group-1";
	const GROUP_ID = "88888888-8888-8888-8888-888888888888";
	const MISSING_KEY_ID = "44444444-4444-4444-4444-444444444444";

	beforeEach(() => {
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
			(path: string) => {
				if (path === `/messages/${GROUP_MESSAGE_ID}`) {
					return Promise.resolve({
						...HYBRID_MESSAGE,
						id: GROUP_MESSAGE_ID,
						group_id: GROUP_ID,
						encryption_version: "sender-key-v1",
					} as unknown as core.MessageRead);
				}
				return Promise.reject(new Error(`Unknown path: ${path}`));
			},
		);
		// The seam is the RECOVERY, not the bare decrypt: `read` reaches this
		// failure through core's one-shot ingest-and-retry, and what comes back is
		// the verdict that recovery reached — the scan ran and found nothing, which
		// is what makes the refusal below an answer rather than a stage.
		vi.spyOn(core, "decryptGroupMessageWithRecovery").mockRejectedValue(
			new core.SenderKeyUnavailableError(MISSING_KEY_ID, GROUP_ID),
		);
	});

	it("test_group_read_when_no_key_arrives_then_it_explains_instead_of_echoing_the_control_string", async () => {
		const printErrorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "read", GROUP_MESSAGE_ID]);

		const said = printErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(said).toContain(MISSING_KEY_ID);
		expect(said).toContain("Ask the sender to post to the group again");
		expect(said).toContain("This message stays sealed");
		// "unknown sender key id: <uuid>" is what core throws so the
		// recovery knows what to fetch — never what an operator is shown.
		expect(said).not.toContain("unknown sender key id");
	});

	it("test_group_read_when_json_is_asked_for_then_the_refusal_stays_off_stderr", async () => {
		const printErrorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", GROUP_MESSAGE_ID]);

		expect(printErrorSpy).not.toHaveBeenCalled();
		const arg = printJsonSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(arg).not.toHaveProperty("decrypted_payload");
	});
});

describe("read command — what the read did to a closed group's MLS state", () => {
	const MLS_MESSAGE_ID = "msg-mls-1";
	const GROUP_ID = "99999999-9999-9999-9999-999999999999";

	function serveMlsRow(): void {
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
			(path: string) => {
				if (path === `/messages/${MLS_MESSAGE_ID}`) {
					return Promise.resolve({
						...HYBRID_MESSAGE,
						id: MLS_MESSAGE_ID,
						group_id: GROUP_ID,
						encryption_version: "mls-v1",
					} as unknown as core.MessageRead);
				}
				return Promise.reject(new Error(`Unknown path: ${path}`));
			},
		);
	}

	it("test_mls_read_when_the_catch_up_applied_commits_then_json_reports_them", async () => {
		// The commits were applied on the way to this plaintext and then thrown
		// away, so a client twenty-five epochs behind read exactly like a current
		// one. It reports the work it did, never the distance it had left.
		serveMlsRow();
		vi.spyOn(core, "decryptGroupMessageWithRecovery").mockResolvedValue({
			...DECRYPT_RESULT,
			catchUp: { processed: 3, epoch: 9, evicted: false },
		});
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", MLS_MESSAGE_ID]);

		const arg = printJsonSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(arg.catch_up).toEqual({ processed: 3, epoch: 9, evicted: false });
	});

	it("test_mls_read_when_no_catch_up_ran_then_json_claims_nothing", async () => {
		// Absent, not zeroed: "this read applied nothing" is a different claim
		// from "you are current", and only the first one is true here.
		serveMlsRow();
		vi.spyOn(core, "decryptGroupMessageWithRecovery").mockResolvedValue(DECRYPT_RESULT);
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", MLS_MESSAGE_ID]);

		const arg = printJsonSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(arg).not.toHaveProperty("catch_up");
	});

	it("test_mls_read_when_the_catch_up_evicted_this_agent_then_the_reader_is_told", async () => {
		// The row still opens — it is the NEXT send that is refused — so without
		// this line the eviction is learned from an unrelated failure later.
		serveMlsRow();
		vi.spyOn(core, "decryptGroupMessageWithRecovery").mockResolvedValue({
			...DECRYPT_RESULT,
			catchUp: { processed: 1, epoch: 10, evicted: true },
		});
		const printErrorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		vi.spyOn(outputModule, "printTable").mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "read", MLS_MESSAGE_ID]);

		const said = printErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(said).toContain(core.MLS_EVICTED_BY_COMMIT);
	});
});
