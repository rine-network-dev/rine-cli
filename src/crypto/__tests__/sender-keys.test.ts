import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEnvelope } from "../envelope.js";
import { generateSigningKeyPair } from "../keys.js";
import {
	advanceChain,
	deriveMessageKey,
	generateSenderKey,
	loadSenderKeyStates,
	openGroup,
	saveSenderKeyState,
	sealGroup,
	type SenderKeyState,
} from "../sender-keys.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeState(): SenderKeyState {
	return generateSenderKey("group-1", "agent-1");
}

function stateMap(state: SenderKeyState): Map<string, SenderKeyState> {
	return new Map([[state.senderKeyId, state]]);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("generateSenderKey", () => {
	it("produces state with expected shape", () => {
		const state = generateSenderKey("gid", "aid");
		expect(state.groupId).toBe("gid");
		expect(state.senderAgentId).toBe("aid");
		expect(state.messageIndex).toBe(0);
		expect(state.chainKey).toHaveLength(32);
		expect(state.senderKeyId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("produces different chain keys each call", () => {
		const a = generateSenderKey("g", "a");
		const b = generateSenderKey("g", "a");
		expect(Buffer.from(a.chainKey).equals(Buffer.from(b.chainKey))).toBe(false);
	});
});

describe("deriveMessageKey", () => {
	it("is deterministic for the same chain key", () => {
		const ck = new Uint8Array(32).fill(0xab);
		const r1 = deriveMessageKey(ck);
		const r2 = deriveMessageKey(ck);
		expect(Buffer.from(r1.messageKey).equals(Buffer.from(r2.messageKey))).toBe(true);
		expect(Buffer.from(r1.nextChainKey).equals(Buffer.from(r2.nextChainKey))).toBe(true);
	});

	it("message key and next chain key are different", () => {
		const { messageKey, nextChainKey } = deriveMessageKey(new Uint8Array(32).fill(1));
		expect(Buffer.from(messageKey).equals(Buffer.from(nextChainKey))).toBe(false);
	});

	it("returns 32-byte keys", () => {
		const { messageKey, nextChainKey } = deriveMessageKey(new Uint8Array(32).fill(2));
		expect(messageKey).toHaveLength(32);
		expect(nextChainKey).toHaveLength(32);
	});
});

describe("sealGroup + openGroup roundtrip", () => {
	it("recovers plaintext and advances state", async () => {
		const signing = generateSigningKeyPair();
		const state = makeState();
		const plaintext = new TextEncoder().encode("hello group");

		const { encryptedPayload, updatedState } = await sealGroup(
			signing.privateKey,
			"kid-1",
			state,
			plaintext,
		);

		expect(updatedState.messageIndex).toBe(1);

		const { innerEnvelope, senderKeyId, messageIndex, updatedState: recvState } = await openGroup(
			stateMap(state),
			encryptedPayload,
		);

		const decoded = decodeEnvelope(innerEnvelope);
		expect(new TextDecoder().decode(decoded.payload)).toBe("hello group");
		expect(senderKeyId).toBe(state.senderKeyId);
		expect(messageIndex).toBe(0);
		expect(recvState.messageIndex).toBe(1);
	});

	it("version byte in wire output is 0x02", async () => {
		const signing = generateSigningKeyPair();
		const state = makeState();
		const { encryptedPayload } = await sealGroup(
			signing.privateKey,
			"kid",
			state,
			new Uint8Array([1]),
		);
		expect(encryptedPayload[0]).toBe(0x02);
	});

	it("produces different ciphertext each time (random nonce)", async () => {
		const signing = generateSigningKeyPair();
		const state = makeState();
		const msg = new TextEncoder().encode("same");

		const { encryptedPayload: ct1 } = await sealGroup(signing.privateKey, "k", state, msg);
		const { encryptedPayload: ct2 } = await sealGroup(signing.privateKey, "k", state, msg);

		expect(Buffer.from(ct1).equals(Buffer.from(ct2))).toBe(false);
	});

	it("rejects unknown sender key id", async () => {
		const signing = generateSigningKeyPair();
		const state = makeState();
		const { encryptedPayload } = await sealGroup(
			signing.privateKey,
			"kid",
			state,
			new Uint8Array([1]),
		);

		// Empty map — no matching key
		await expect(openGroup(new Map(), encryptedPayload)).rejects.toThrow(
			"unknown sender key id",
		);
	});

	it("rejects wrong version byte", async () => {
		const signing = generateSigningKeyPair();
		const state = makeState();
		const { encryptedPayload } = await sealGroup(
			signing.privateKey,
			"kid",
			state,
			new Uint8Array([1]),
		);
		encryptedPayload[0] = 0x99;
		await expect(openGroup(stateMap(state), encryptedPayload)).rejects.toThrow(
			"unsupported version",
		);
	});
});

describe("out-of-order messages (skip + cache)", () => {
	it("can decrypt message at index 2 then go back and read index 1 (REQ-5A-001)", async () => {
		const signing = generateSigningKeyPair();
		const sharedState = makeState();

		const sealed0 = await sealGroup(signing.privateKey, "k", sharedState, new TextEncoder().encode("msg-0"));
		const sealed1 = await sealGroup(signing.privateKey, "k", sealed0.updatedState, new TextEncoder().encode("msg-1"));
		const sealed2 = await sealGroup(signing.privateKey, "k", sealed1.updatedState, new TextEncoder().encode("msg-2"));

		// Receiver at index 0 opens message at index 2 (skips 0 and 1)
		const receiverStates = stateMap(sharedState);
		const result2 = await openGroup(receiverStates, sealed2.encryptedPayload);
		expect(decodeEnvelope(result2.innerEnvelope).payload).toEqual(new TextEncoder().encode("msg-2"));
		expect(result2.messageIndex).toBe(2);

		// Update state map with the result (which should have skipped keys for 0 and 1)
		receiverStates.set(result2.updatedState.senderKeyId, result2.updatedState);
		expect(result2.updatedState.skippedKeys).toBeDefined();
		expect(result2.updatedState.skippedKeys![0]).toBeDefined();
		expect(result2.updatedState.skippedKeys![1]).toBeDefined();

		// Now go back and read message 1
		const result1 = await openGroup(receiverStates, sealed1.encryptedPayload);
		expect(new TextDecoder().decode(decodeEnvelope(result1.innerEnvelope).payload)).toBe("msg-1");

		// And message 0
		receiverStates.set(result1.updatedState.senderKeyId, result1.updatedState);
		const result0 = await openGroup(receiverStates, sealed0.encryptedPayload);
		expect(new TextDecoder().decode(decodeEnvelope(result0.innerEnvelope).payload)).toBe("msg-0");
	});

	it("reading already-consumed key throws (REQ-5A-002)", async () => {
		const signing = generateSigningKeyPair();
		const sharedState = makeState();

		const sealed0 = await sealGroup(signing.privateKey, "k", sharedState, new TextEncoder().encode("msg-0"));
		const sealed1 = await sealGroup(signing.privateKey, "k", sealed0.updatedState, new TextEncoder().encode("msg-1"));

		// Read message 1 first (skipping 0)
		const receiverStates = stateMap(sharedState);
		const result1 = await openGroup(receiverStates, sealed1.encryptedPayload);
		receiverStates.set(result1.updatedState.senderKeyId, result1.updatedState);

		// Read message 0 (from skipped cache)
		const result0 = await openGroup(receiverStates, sealed0.encryptedPayload);
		receiverStates.set(result0.updatedState.senderKeyId, result0.updatedState);

		// Try to read message 0 again — key was consumed
		await expect(openGroup(receiverStates, sealed0.encryptedPayload)).rejects.toThrow(
			"message key expired or already consumed",
		);
	});
});

describe("sender key distribution ingestion roundtrip (FIX-3)", () => {
	it("ingested distribution payload can decrypt a message from that sender", async () => {
		const { toBase64Url, fromBase64Url } = await import("../keys.js");
		const signing = generateSigningKeyPair();

		// Sender generates a sender key and seals a message
		const senderState = generateSenderKey("group-dist", "sender-agent");
		const plaintext = new TextEncoder().encode("group message");
		const { encryptedPayload, updatedState } = await sealGroup(
			signing.privateKey,
			"kid-dist",
			senderState,
			plaintext,
		);

		// Simulate a distribution payload (what sender would send via HPKE)
		const distPayload = {
			group_id: senderState.groupId,
			sender_key_id: senderState.senderKeyId,
			chain_key: toBase64Url(senderState.chainKey),
			message_index: senderState.messageIndex,
			sender_agent_id: senderState.senderAgentId,
		};

		// Recipient reconstructs the sender key state from the distribution payload
		const reconstructed: SenderKeyState = {
			senderKeyId: distPayload.sender_key_id,
			groupId: distPayload.group_id,
			senderAgentId: distPayload.sender_agent_id,
			chainKey: fromBase64Url(distPayload.chain_key),
			messageIndex: distPayload.message_index,
		};

		// Decrypt the message using the reconstructed state
		const { innerEnvelope } = await openGroup(
			stateMap(reconstructed),
			encryptedPayload,
		);
		const decoded = decodeEnvelope(innerEnvelope);
		expect(new TextDecoder().decode(decoded.payload)).toBe("group message");
	});
});

describe("encryptGroupMessage preserves foreign sender key states (FIX-4)", () => {
	let tmpDir: string;
	const origEnv = process.env.RINE_CONFIG_DIR;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-sk-fix4-"));
		process.env.RINE_CONFIG_DIR = tmpDir;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		if (origEnv !== undefined) {
			process.env.RINE_CONFIG_DIR = origEnv;
		} else {
			process.env.RINE_CONFIG_DIR = undefined;
		}
	});

	it("foreign sender key state survives encryptGroupMessage", async () => {
		const { generateAgentKeys, saveAgentKeys } = await import("../keys.js");
		const { encryptGroupMessage } = await import("../message.js");

		const agentId = "00000000-0000-4000-a000-f00000000004";
		const groupId = "00000000-0000-4000-b000-f00000000004";

		// Generate and save agent keys so encryptGroupMessage can load them
		const agentKeys = generateAgentKeys();
		saveAgentKeys(agentId, agentKeys);

		// Create sender's own state and a foreign state
		const ownState = generateSenderKey(groupId, agentId);
		const foreignState = generateSenderKey(groupId, "00000000-0000-4000-a000-f00000000099");

		// Save both states
		saveSenderKeyState(agentId, groupId, [ownState, foreignState]);

		// Encrypt a group message (this updates ownState internally)
		await encryptGroupMessage(agentId, groupId, ownState, { hello: "world" });

		// Load states and verify both are present
		const loaded = loadSenderKeyStates(agentId, groupId);
		expect(loaded).toHaveLength(2);
		const foreignLoaded = loaded.find(s => s.senderAgentId === "00000000-0000-4000-a000-f00000000099");
		expect(foreignLoaded).toBeDefined();
		expect(foreignLoaded!.senderKeyId).toBe(foreignState.senderKeyId);
	});
});

describe("advanceChain", () => {
	it("returns skipped keys for each index", () => {
		const state = makeState();
		const { skippedKeys, updatedState } = advanceChain(state, 3);
		expect(skippedKeys.size).toBe(3);
		expect(skippedKeys.has(0)).toBe(true);
		expect(skippedKeys.has(1)).toBe(true);
		expect(skippedKeys.has(2)).toBe(true);
		expect(updatedState.messageIndex).toBe(3);
	});

	it("throws when skip exceeds max", () => {
		const state = makeState();
		expect(() => advanceChain(state, 1001)).toThrow("too many skipped messages");
	});

	it("exactly 1000 skips is allowed", () => {
		const state = makeState();
		expect(() => advanceChain(state, 1000)).not.toThrow();
	});
});

describe("saveSenderKeyState / loadSenderKeyStates", () => {
	let tmpDir: string;
	const origEnv = process.env.RINE_CONFIG_DIR;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-sk-test-"));
		process.env.RINE_CONFIG_DIR = tmpDir;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		if (origEnv !== undefined) {
			process.env.RINE_CONFIG_DIR = origEnv;
		} else {
			process.env.RINE_CONFIG_DIR = undefined;
		}
	});

	it("roundtrips sender key states including chain key", () => {
		const state = makeState();
		const agX = "00000000-0000-4000-a000-aaaaaaaaaaaa";
		const grY = "00000000-0000-4000-b000-bbbbbbbbbbbb";
		saveSenderKeyState(agX, grY, [state]);
		const loaded = loadSenderKeyStates(agX, grY);

		expect(loaded).toHaveLength(1);
		const s = loaded[0]!;
		expect(s.senderKeyId).toBe(state.senderKeyId);
		expect(s.groupId).toBe(state.groupId);
		expect(s.senderAgentId).toBe(state.senderAgentId);
		expect(s.messageIndex).toBe(state.messageIndex);
		expect(Buffer.from(s.chainKey).equals(Buffer.from(state.chainKey))).toBe(true);
	});

	it("roundtrips skipped keys through save/load (REQ-5A-003)", () => {
		const state = makeState();
		state.skippedKeys = { 0: "AAAA", 1: "BBBB", 5: "CCCC" };
		const agS = "00000000-0000-4000-a000-cccccccccccc";
		const grS = "00000000-0000-4000-b000-dddddddddddd";
		saveSenderKeyState(agS, grS, [state]);
		const loaded = loadSenderKeyStates(agS, grS);

		expect(loaded).toHaveLength(1);
		const s = loaded[0]!;
		expect(s.skippedKeys).toBeDefined();
		expect(s.skippedKeys![0]).toBe("AAAA");
		expect(s.skippedKeys![1]).toBe("BBBB");
		expect(s.skippedKeys![5]).toBe("CCCC");
	});

	it("returns empty array when file does not exist", () => {
		const result = loadSenderKeyStates("00000000-0000-4000-a000-eeeeeeeeeeee", "00000000-0000-4000-b000-ffffffffffff");
		expect(result).toEqual([]);
	});

	it("sets restrictive file permissions", () => {
		const state = makeState();
		const permAg = "00000000-0000-4000-a000-111111111111";
		const permGr = "00000000-0000-4000-b000-222222222222";
		saveSenderKeyState(permAg, permGr, [state]);
		const filePath = path.join(tmpDir, "keys", permAg, "sender_keys", `${permGr}.json`);
		const stat = fs.statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	});
});
