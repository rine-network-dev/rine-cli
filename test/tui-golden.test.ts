import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReadGapReason, type ReadMessage } from "@rine-network/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { ColorDepth } from "../src/tui/caps.js";
import { render } from "../src/tui/render.js";
import { Screen } from "../src/tui/screen.js";
import { initialModel, update } from "../src/tui/state.js";
import type { Model } from "../src/tui/state-model.js";
import { sgr } from "../src/tui/style.js";
import { type RowView, rowView } from "../src/tui/view-model.js";
import { RESTING } from "../src/tui/motion.js";
import { messageOf, textBody } from "./tui-fixture.js";

process.env.TZ = "UTC";

const DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"tui-golden",
);
const REGEN = process.env.RINE_TUI_GOLDEN_REGEN === "1";

const SIZES = [
	[120, 40],
	[80, 24],
	[60, 20],
	[40, 10],
] as const;
const MODES: readonly { name: string; unicode: boolean; depth: ColorDepth }[] =
	[
		{ name: "utf8-colour", unicode: true, depth: "truecolor" },
		{ name: "no-color", unicode: true, depth: "none" },
		{ name: "ascii", unicode: false, depth: "16" },
	];

const NOW = Date.UTC(2026, 9, 26, 15, 30, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How long before NOW each message was sent: one of every shape the date column takes. */
const AGES = [10_000, 5 * MINUTE, 2 * HOUR, DAY + 2 * HOUR, 3 * DAY, 12 * DAY, 400 * DAY];

const party = (agentId: string, handle: string, own: boolean) => ({
	agentId,
	handle,
	orgId: "o",
	own,
});
const SALES = party("3f9a1c07-0000-4000-8000-000000000001", "sales@acme.rine.network", true);
const BILLING = party("8b20e4d1-0000-4000-8000-000000000002", "billing@acme.rine.network", true);
const PARTNER = party("c41d77aa-0000-4000-8000-000000000003", "buyer@fjord21735.rine.network", false);

function message(
	n: number,
	over: Partial<ReadMessage>,
	row: Partial<ReadMessage["row"]> = {},
): ReadMessage {
	return messageOf(`m${n}`, over, {
		createdAt: new Date(NOW - (AGES[n] as number)).toISOString(),
		createdAtMicros: (NOW - (AGES[n] as number)) * 1000,
		ciphertext: new Uint8Array(),
		sender: SALES,
		recipient: BILLING,
		...row,
	});
}

const text = textBody;
const TWO_PARAGRAPHS = `${"Invoice 4471 is ready for review. The total is 1,240.00 EUR, due in 30 days. ".repeat(3)}\n\nThanks, sales`;

const MESSAGES: ReadMessage[] = [
	message(0, { text: text(TWO_PARAGRAPHS), verification: "verified" }),
	message(
		1,
		{ text: text("Deploy finished on eu-1"), verification: "verified" },
		{ groupId: "g1", groupHandle: "#ops@acme.rine.network", recipient: null },
	),
	message(
		2,
		{
			text: text("Quote\u202e accepted\u200b"),
			verification: "verified",
			equivocation: true,
		},
		{ recipient: PARTNER, direction: "sent" },
	),
	message(
		3,
		{ gap: { reason: ReadGapReason.NoEscrow, epoch: 41 } },
		{ recipient: PARTNER, direction: "sent" },
	),
	message(
		4,
		{ verification: "unverifiable" },
		{ groupId: "g1", groupHandle: "#ops@acme.rine.network", sender: BILLING, recipient: null },
	),
	message(
		5,
		{ verification: "invalid" },
		{ sender: PARTNER, recipient: SALES, direction: "received" },
	),
	message(
		6,
		{ verification: "sender-mismatch" },
		{ sender: PARTNER, recipient: BILLING, direction: "received" },
	),
];

const views = new Map<string, RowView>();
function fixedModel(): Model {
	const rows = MESSAGES.map((message) => rowView(message, undefined, "acme"));
	for (const row of rows) views.set(row.id, row);
	const loaded = update(initialModel, { type: "reset", rows }).model;
	const live = update(loaded, {
		type: "connection",
		connection: { kind: "live", pollS: 5 },
	}).model;
	const named = update(live, {
		type: "org",
		org: { name: "Acme Corp", slug: "acme" },
	}).model;
	return { ...named, selectedId: "m2" };
}

/** The frame as plain cells, then a style map with one letter per cell and its legend. */
function serialize(screen: Screen, depth: ColorDepth): string {
	const legend = new Map<string, string>();
	const letterOf = (code: string): string => {
		if (code === sgr({}, depth)) return ".";
		if (!legend.has(code))
			legend.set(code, String.fromCharCode(97 + legend.size));
		return legend.get(code) as string;
	};
	const cells: string[] = [];
	const styles: string[] = [];
	for (let y = 0; y < screen.rows; y++) {
		let line = "";
		let map = "";
		for (let x = 0; x < screen.cols; x++) {
			const cell = screen.cell(x, y);
			if (cell.width === 0) continue;
			line += cell.text;
			map += letterOf(sgr(cell.style, depth));
		}
		cells.push(line);
		styles.push(map);
	}
	const key = [...legend].map(
		([code, letter]) => `${letter} ${JSON.stringify(code)}`,
	);
	return [
		...cells,
		"--- styles ---",
		...styles,
		"--- legend ---",
		...key,
		"",
	].join("\n");
}

describe("golden frames", () => {
	beforeAll(() => {
		if (REGEN) mkdirSync(DIR, { recursive: true });
	});

	it.each(
		SIZES.flatMap(([cols, rows]) =>
			MODES.map((mode) => ({ cols, rows, ...mode })),
		),
	)(
		"renders the fixed model at $cols x $rows in $name",
		({ cols, rows, name, unicode, depth }) => {
			const screen = new Screen(cols, rows);
			const model = fixedModel();
			render(screen, model, {
				caps: { unicode },
				motion: RESTING,
				now: NOW,
				viewOf: (row) => views.get(row.id),
			});
			const frame = serialize(screen, depth);
			const file = join(DIR, `${cols}x${rows}-${name}.txt`);
			if (REGEN) writeFileSync(file, frame);
			expect(existsSync(file), `missing golden ${file}`).toBe(true);
			expect(frame).toBe(readFileSync(file, "utf8"));
			expect(screen.controlsRefused).toBe(0);
		},
	);
});

const OTHER_GROUP = "9c2e51f0-0000-4000-8000-000000000009";

function findingsModel(overlay: Model["overlay"]): Model {
	const found = [
		{ groupId: "g1", gap: { reason: ReadGapReason.NoEscrow, epoch: 41 } },
		{ groupId: OTHER_GROUP, gap: { reason: ReadGapReason.EscrowForged, epoch: 7 } },
	];
	let model = fixedModel();
	for (const finding of found)
		model = update(model, { type: "finding", finding }).model;
	return { ...model, overlay };
}

describe("golden frames with findings", () => {
	it.each(
		[
			{ cols: 80, rows: 24, overlay: "none" as const },
			{ cols: 80, rows: 24, overlay: "findings" as const },
			{ cols: 40, rows: 10, overlay: "none" as const },
		].flatMap((size) => MODES.map((mode) => ({ ...size, ...mode }))),
	)(
		"renders findings ($overlay) at $cols x $rows in $name",
		({ cols, rows, overlay, name, unicode, depth }) => {
			const screen = new Screen(cols, rows);
			render(screen, findingsModel(overlay), {
				caps: { unicode },
				motion: RESTING,
				now: NOW,
				viewOf: (row) => views.get(row.id),
			});
			const frame = serialize(screen, depth);
			const file = join(DIR, `findings-${overlay === "none" ? "bar" : "overlay"}-${cols}x${rows}-${name}.txt`);
			if (REGEN) writeFileSync(file, frame);
			expect(existsSync(file), `missing golden ${file}`).toBe(true);
			expect(frame).toBe(readFileSync(file, "utf8"));
			expect(screen.controlsRefused).toBe(0);
		},
	);
});

describe("render sources", () => {
	it.each(["render.ts", "render-items.ts"])(
		"test_%s_codeLines_wrapAtBiomeWidth",
		(file) => {
			const src = readFileSync(
				join(dirname(fileURLToPath(import.meta.url)), "../src/tui", file),
				"utf8",
			);
			const wide = src
				.split("\n")
				.filter((line) => !/^\s*(\/\*\*|\*|\/\/)/.test(line))
				.filter((line) => line.replaceAll("\t", "  ").length > 80);
			expect(wide).toEqual([]);
		},
	);
});
