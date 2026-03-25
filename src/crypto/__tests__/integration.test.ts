import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "../envelope.js";
import { open, seal } from "../hpke.js";
import { generateAgentKeys } from "../keys.js";
import { signPayload, verifySignature } from "../sign.js";

describe("full E2EE roundtrip", () => {
	it("sender encrypts, recipient decrypts and verifies", async () => {
		const sender = generateAgentKeys();
		const recipient = generateAgentKeys();
		const senderKid = "rine:00000000-0000-4000-a000-000000000001";

		// Sender side
		const plaintext = new TextEncoder().encode(
			JSON.stringify({ task: "validate", amount: 42 }),
		);
		const signature = signPayload(sender.signing.privateKey, plaintext);
		const envelope = encodeEnvelope(senderKid, signature, plaintext);
		const encrypted = await seal(recipient.encryption.publicKey, envelope);

		// --- server stores and returns `encrypted` as opaque blob ---

		// Recipient side
		const decryptedEnvelope = await open(
			recipient.encryption.privateKey,
			encrypted,
		);
		const decoded = decodeEnvelope(decryptedEnvelope);

		expect(decoded.kid).toBe(senderKid);
		const verified = verifySignature(
			sender.signing.publicKey,
			decoded.payload,
			decoded.signature,
		);
		expect(verified).toBe(true);

		const recoveredPayload = JSON.parse(
			new TextDecoder().decode(decoded.payload),
		);
		expect(recoveredPayload).toEqual({ task: "validate", amount: 42 });
	});

	it("rejects message signed by different sender", async () => {
		const sender = generateAgentKeys();
		const impersonator = generateAgentKeys();
		const recipient = generateAgentKeys();

		const plaintext = new TextEncoder().encode("legit message");
		// Impersonator signs with their own key but claims sender's kid
		const sig = signPayload(impersonator.signing.privateKey, plaintext);
		const envelope = encodeEnvelope("fake-kid", sig, plaintext);
		const encrypted = await seal(recipient.encryption.publicKey, envelope);

		const decrypted = await open(recipient.encryption.privateKey, encrypted);
		const decoded = decodeEnvelope(decrypted);

		// Verify against the real sender's key — should fail
		const verified = verifySignature(
			sender.signing.publicKey,
			decoded.payload,
			decoded.signature,
		);
		expect(verified).toBe(false);
	});
});
