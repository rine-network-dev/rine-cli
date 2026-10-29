import { describe, expect, it } from "vitest";
import { type CapsInput, detectCaps } from "../src/tui/caps.js";

const tty = (bits: number): CapsInput["stream"] => ({
	getColorDepth: () => bits,
});

function caps(env: NodeJS.ProcessEnv, stream = tty(24), ascii = false) {
	const result = detectCaps({ env, stream, ascii });
	if (!result.ok) throw new Error(result.refused);
	return result.caps;
}

describe("detectCaps colour precedence", () => {
	it("follows the stream when no variable is set", () => {
		expect(caps({}, tty(24)).color).toBe("truecolor");
		expect(caps({}, tty(8)).color).toBe("256");
		expect(caps({}, tty(4)).color).toBe("16");
		expect(caps({}, tty(1)).color).toBe("none");
	});

	it("has no colour on a stream that cannot report depth", () => {
		expect(caps({}, {}).color).toBe("none");
	});

	it("lets a non-empty NO_COLOR win over FORCE_COLOR and the stream", () => {
		expect(caps({ NO_COLOR: "1", FORCE_COLOR: "3" }).color).toBe("none");
	});

	it("ignores an empty NO_COLOR", () => {
		expect(caps({ NO_COLOR: "", FORCE_COLOR: "2" }, tty(1)).color).toBe("256");
	});

	it("maps FORCE_COLOR 0/1/2/3 over the stream", () => {
		expect(caps({ FORCE_COLOR: "0" }, tty(24)).color).toBe("none");
		expect(caps({ FORCE_COLOR: "1" }, tty(24)).color).toBe("16");
		expect(caps({ FORCE_COLOR: "2" }, tty(1)).color).toBe("256");
		expect(caps({ FORCE_COLOR: "3" }, {}).color).toBe("truecolor");
	});

	it("falls through to the stream on an unknown FORCE_COLOR value", () => {
		expect(caps({ FORCE_COLOR: "banana" }, tty(8)).color).toBe("256");
	});
});

describe("detectCaps unicode", () => {
	it("is unicode by default and with a UTF-8 locale", () => {
		expect(caps({}).unicode).toBe(true);
		expect(caps({ LANG: "en_US.UTF-8" }).unicode).toBe(true);
		expect(caps({ LC_ALL: "C.utf8" }).unicode).toBe(true);
	});

	it("is ASCII for a non-UTF-8 locale, the first set variable deciding", () => {
		expect(caps({ LANG: "C" }).unicode).toBe(false);
		expect(caps({ LC_ALL: "POSIX", LANG: "en_US.UTF-8" }).unicode).toBe(false);
		expect(
			caps({ LC_CTYPE: "en_US.ISO-8859-1", LANG: "en_US.UTF-8" }).unicode,
		).toBe(false);
		expect(caps({ LC_ALL: "en_US.UTF-8", LANG: "C" }).unicode).toBe(true);
	});

	it("is ASCII with --ascii or TERM=linux", () => {
		expect(caps({ LANG: "en_US.UTF-8" }, tty(24), true).unicode).toBe(false);
		expect(caps({ TERM: "linux" }).unicode).toBe(false);
	});
});

describe("detectCaps refusal", () => {
	it("refuses TERM=dumb", () => {
		expect(detectCaps({ env: { TERM: "dumb" }, stream: tty(24) })).toEqual({
			ok: false,
			refused: "dumb-terminal",
		});
	});
});
