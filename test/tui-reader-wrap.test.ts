import { displayWidth } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { bodyLines } from "../src/tui/widgets/wrap.js";

describe("bodyLines wrapping", () => {
	it("keeps indentation when a wide cluster follows a full-width indented line", () => {
		expect(bodyLines(" abcd中", 5, true)).toEqual([" abcd", "中"]);
	});

	it("never emits a piece wider than the width", () => {
		for (const text of [" abcd中", "  ab cd中文 ef", '  "key": "值值值值 value"', "a bcd中 中中中"]) {
			for (let width = 2; width < 10; width++) {
				for (const line of bodyLines(text, width, true)) expect(displayWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("does not produce an empty piece from leading spaces", () => {
		expect(bodyLines("  abcdef", 5, true).every((l) => l !== "")).toBe(true);
	});
});
