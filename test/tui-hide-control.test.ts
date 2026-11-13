/**
 * `rine tui --hide-control`: group-key and group-invite control frames stay out of what the
 * view and the feed show, and a view without the flag shows them as before.
 */

import type { ActivityQuery, ReadMessage, ReadPage } from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Poller } from "../src/tui/data.js";
import type { DataEvent } from "../src/tui/data-types.js";
import { messageOf, textBody } from "./tui-fixture.js";

const runFeed = vi.fn(async (_opts: Record<string, unknown>) => 0);
const runApp = vi.fn(async () => 0);
vi.mock("../src/tui/feed.js", () => ({ runFeed }));
vi.mock("../src/tui/app.js", () => ({ runApp }));
vi.mock("../src/tui/identity.js", () => ({ resolveIdentity: () => ({}) }));
const { registerTui } = await import("../src/commands/tui.js");

const NOW = Date.UTC(2026, 9, 24, 14, 0, 0);
const row = (id: string, type: string): ReadMessage =>
	messageOf(id, { text: textBody("hi") }, { type, createdAtMicros: NOW * 1000 });

async function shown(hideControl: boolean): Promise<string[]> {
	const events: DataEvent[] = [];
	const items = [
		row("text-1", "rine.v1.dm"),
		row("key-1", "rine.v1.sender_key_distribution"),
		row("invite-1", "rine.v1.group_invite"),
	];
	const page: ReadPage = { items, nextCursor: null, findings: [] };
	const reader = { read: async (_query: ActivityQuery) => page };
	const poller = new Poller({ reader, emit: (e) => events.push(e), now: () => NOW, hideControl });
	await poller.start();
	await poller.stop();
	return events.flatMap((e) => (e.type === "rows" ? e.rows.map((m) => m.row.id) : []));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the tui poller", () => {
	it("test_poller_when_hide_control_is_set_then_control_frames_are_not_reported", async () => {
		expect(await shown(true)).toEqual(["text-1"]);
	});

	it("test_poller_when_hide_control_is_not_set_then_control_frames_are_reported", async () => {
		expect(await shown(false)).toEqual(["text-1", "key-1", "invite-1"]);
	});
});

describe("rine tui --hide-control", () => {
	const tui = async (...args: string[]): Promise<void> => {
		const program = new Command("rine");
		registerTui(program);
		await program.parseAsync(["tui", ...args], { from: "user" });
	};

	afterEach(() => {
		process.exitCode = undefined;
		vi.clearAllMocks();
	});

	it("test_tui_when_the_flag_is_given_then_the_feed_hides_control_frames", async () => {
		await tui("--feed", "--hide-control");
		expect(runFeed.mock.calls[0]?.[0]).toMatchObject({ hideControl: true });
	});

	it("test_tui_when_the_flag_is_absent_then_the_feed_shows_control_frames", async () => {
		await tui("--feed");
		expect(runFeed.mock.calls[0]?.[0]).toMatchObject({ hideControl: undefined });
	});

	it("test_tui_when_the_flag_is_given_then_the_help_lists_it", () => {
		const program = new Command("rine");
		registerTui(program);
		const help = program.commands.find((c) => c.name() === "tui")?.helpInformation() ?? "";
		expect(help).toContain("--hide-control");
	});
});
