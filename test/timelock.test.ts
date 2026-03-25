import { describe, expect, it } from "vitest";
import { solveTimeLock, solveTimeLockWithProgress } from "../src/timelock.js";

// N = 17 (0x11), base = 2 (0x02)
// After 3+ squarings mod 17: 2→4→16→1→1→... (converges to 1)
// For T=100: result is 1 (confirmed: 2^(2^100) mod 17 = 1)
const BASE = "02";
const MODULUS = "11"; // hex for 17

describe("solveTimeLock", () => {
	it("produces deterministic result for known inputs (T=100)", () => {
		expect(solveTimeLock(BASE, MODULUS, 100)).toBe("1");
	});

	it("returns base mod N unchanged at T=0", () => {
		// T=0: no squarings, x = 2n % 17n = 2n → "2"
		expect(solveTimeLock(BASE, MODULUS, 0)).toBe("2");
	});

	it("intermediate T=3 also converges to 1", () => {
		// x0=2, x1=4, x2=16, x3=256%17=1
		expect(solveTimeLock(BASE, MODULUS, 3)).toBe("1");
	});

	it("same result for T=4 as T=3 (fixed point)", () => {
		expect(solveTimeLock(BASE, MODULUS, 4)).toBe("1");
	});

	it("handles base equal to modulus (result is 0)", () => {
		// base=17=0x11 → x = 17 % 17 = 0 → 0^2 % 17 = 0 always
		expect(solveTimeLock("11", "11", 10)).toBe("0");
	});
});

describe("solveTimeLockWithProgress", () => {
	it("produces same result as solveTimeLock", async () => {
		const result = await solveTimeLockWithProgress(BASE, MODULUS, 100);
		expect(result).toBe("1");
	});

	it("calls progress callback with values 0–99", async () => {
		const calls: number[] = [];
		await solveTimeLockWithProgress(BASE, MODULUS, 100, (pct) =>
			calls.push(pct),
		);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]).toBe(0);
		// All values should be in range [0, 100)
		for (const pct of calls) {
			expect(pct).toBeGreaterThanOrEqual(0);
			expect(pct).toBeLessThan(100);
		}
	});

	it("works without progress callback", async () => {
		const result = await solveTimeLockWithProgress(BASE, MODULUS, 100);
		expect(result).toBe("1");
	});
});
