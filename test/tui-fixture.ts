import type { ReadMessage } from "@rine-network/core";

export const SALES = {
	agentId: "3f9a1c07-0000-4000-8000-000000000001",
	handle: "sales@acme",
	orgId: "o",
	own: true,
};
export const BILLING = {
	agentId: "8b20e4d1-0000-4000-8000-000000000002",
	handle: "billing@acme",
	orgId: "o",
	own: true,
};
export const PARTNER = {
	agentId: "c41d77aa-0000-4000-8000-000000000003",
	handle: "partner.x",
	orgId: "p",
	own: false,
};

/** A plaintext that must never reach a log, a stderr line or a serialised error. */
export const SECRET = "SENTINEL-plaintext-4821";

export const textBody = (body: string): string => JSON.stringify({ text: body });

/** An internal text message from sales to billing; `over` and `row` replace single fields. */
export function messageOf(
	id: string,
	over: Partial<ReadMessage> = {},
	row: Partial<ReadMessage["row"]> = {},
): ReadMessage {
	return {
		row: {
			id,
			createdAt: "2026-10-24T14:00:00Z",
			createdAtMicros: Date.UTC(2026, 9, 24, 14, 0, 0) * 1000,
			offsetMinutes: 0,
			type: "rine.v1.text",
			direction: "internal",
			sender: SALES,
			recipient: BILLING,
			groupId: null,
			groupHandle: null,
			conversationId: "c",
			encryptionVersion: "hpke-hybrid-v2",
			ciphertext: new Uint8Array([1]),
			selfCiphertext: null,
			keyGen: null,
			...row,
		},
		text: null,
		verification: null,
		equivocation: false,
		epoch: null,
		gap: null,
		slot: null,
		envelope: null,
		...over,
	};
}
