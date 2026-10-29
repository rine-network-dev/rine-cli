/**
 * The stream's two cleartext surfaces: the human preview line and the `--json`
 * envelope. A message that arrived as A2A cleartext says so in both; every
 * other line is byte for byte what it was.
 */

import * as core from "@rine-network/core";
import { describe, expect, it } from "vitest";
import {
	a2aCleartextPreview,
	messageEventLine,
} from "../src/commands/stream-cleartext.js";

/** The wire payload of one text part "plain", as the server serves it: unpadded base64url. */
const WIRE_PAYLOAD = "W3sidGV4dCI6ICJwbGFpbiJ9XQ";

const CLEARTEXT = {
	type: "rine.v1.a2a_message",
	encryption_version: "none",
	encrypted_payload: WIRE_PAYLOAD,
};

describe("stream cleartext preview", () => {
	it("test_preview_when_the_event_is_a2a_cleartext_then_it_carries_the_notice_and_the_body", () => {
		const preview = a2aCleartextPreview(CLEARTEXT);

		expect(preview).toContain(core.A2A_CLEARTEXT_NOTICE);
		expect(preview).toContain("plain");
		expect(preview?.startsWith("[?] ")).toBe(true);
	});

	it("test_preview_when_the_event_is_sealed_then_it_is_null", () => {
		expect(
			a2aCleartextPreview({
				type: "rine.v1.text",
				encryption_version: "hpke-hybrid-v2",
				encrypted_payload: WIRE_PAYLOAD,
			}),
		).toBeNull();
	});

	it("test_preview_when_the_event_is_not_a2a_but_cleartext_then_it_is_null", () => {
		expect(
			a2aCleartextPreview({
				type: "rine.v1.text",
				encryption_version: "none",
				encrypted_payload: WIRE_PAYLOAD,
			}),
		).toBeNull();
	});
});

describe("stream json message line", () => {
	it("test_message_event_line_when_the_event_is_a2a_cleartext_then_it_carries_the_flag_and_notice", () => {
		const data = JSON.stringify(CLEARTEXT);

		const line = JSON.parse(messageEventLine("message", "evt-1", data));

		expect(line.a2a_cleartext).toBe(true);
		expect(line.a2a_cleartext_notice).toBe(core.A2A_CLEARTEXT_NOTICE);
		expect(line.data).toBe(data);
	});

	it("test_message_event_line_when_the_event_is_sealed_then_it_is_unchanged", () => {
		const data = JSON.stringify({
			type: "rine.v1.text",
			encryption_version: "hpke-hybrid-v2",
		});

		expect(messageEventLine("message", "evt-1", data)).toBe(
			JSON.stringify({ event: "message", id: "evt-1", data }),
		);
	});

	it("test_message_event_line_when_the_event_is_a_heartbeat_then_it_is_unchanged", () => {
		const data = JSON.stringify(CLEARTEXT);

		expect(messageEventLine("heartbeat", "evt-2", data)).toBe(
			JSON.stringify({ event: "heartbeat", id: "evt-2", data }),
		);
	});
});
