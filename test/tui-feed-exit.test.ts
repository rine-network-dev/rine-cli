import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "rine-feed-exit-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

// The plugin pins this number on its own side, so the built command is run and its status read
// as a literal: a renumbering in the schema would pass every test that compares against the
// schema's own constant.
describe("rine tui --feed (built)", () => {
	it("exits_3_naming_no_identity_when_the_machine_holds_no_key", () => {
		expect(existsSync(MAIN), "build rine-cli first: npm run build").toBe(true);
		const run = spawnSync(process.execPath, [MAIN, "tui", "--feed"], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				HOME: home,
				RINE_CONFIG_DIR: join(home, "config"),
				RINE_OWNER_DIR: join(home, "owner"),
			},
		});
		expect(run.status).toBe(3);
		const [line] = run.stdout.split("\n");
		expect(JSON.parse(line ?? "")).toMatchObject({
			event: "error",
			data: { code: "no_identity" },
		});
	});
});
