import * as fs from "node:fs";
import { join } from "node:path";

/**
 * Persisted SSE stream cursor.
 *
 * `rine stream` keeps `lastEventId` in-process only, so every fresh process
 * (a new shell, a restarted CC-plugin monitor) reconnects cursorless and
 * triggers a full catch-up replay. Persisting the last-seen event id per agent
 * to `$RINE_DIR/state/stream-cursor.json` lets a restart resume precisely via
 * the `Last-Event-ID` header — narrowing the at-most-once window and working
 * even against an un-patched server.
 *
 * Both helpers are best-effort: a read/write failure (missing dir, foreign-owned
 * or read-only file) must never crash the stream loop — at worst the next start
 * replays from the server's default bound.
 */

type CursorMap = Record<string, string>;

function cursorPath(configDir: string): string {
	return join(configDir, "state", "stream-cursor.json");
}

function loadCursorMap(configDir: string): CursorMap {
	try {
		const raw = fs.readFileSync(cursorPath(configDir), "utf-8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as CursorMap) : {};
	} catch {
		return {};
	}
}

/** Return the last persisted event id for an agent, or undefined if none/unreadable. */
export function loadStreamCursor(configDir: string, agentId: string): string | undefined {
	const value = loadCursorMap(configDir)[agentId];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Persist the last-seen event id for an agent (best-effort, atomic, no-op if unchanged). */
export function saveStreamCursor(configDir: string, agentId: string, eventId: string): void {
	if (!eventId) return;
	try {
		const map = loadCursorMap(configDir);
		if (map[agentId] === eventId) return;
		map[agentId] = eventId;
		const dir = join(configDir, "state");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = cursorPath(configDir);
		const tmp = `${path}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(map), "utf-8");
		fs.renameSync(tmp, path);
		fs.chmodSync(path, 0o600);
	} catch {
		// swallow — a cursor write failure only costs a replay on next start
	}
}
