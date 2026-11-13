import { isControlFrameType } from "@rine-network/core";

/** Help text for `--hide-control` on the commands that only list messages. */
export const HIDE_CONTROL_HELP =
	"Omit group-key and group-invite control frames from the output (they are not marked read or changed)";

/** Help text for `--hide-control` on `stream`, which marks every message it settles delivered. */
export const STREAM_HIDE_CONTROL_HELP =
	"Omit group-key and group-invite control frames from the output (they are still marked delivered once settled, like any other message)";

/** `rows` without their control frames when `hide` is set, otherwise as they are. */
export function withoutControlFrames<T extends { type?: string | null }>(
	rows: readonly T[],
	hide: boolean | undefined,
): readonly T[] {
	return hide ? rows.filter((row) => !isControlFrameType(row.type ?? "")) : rows;
}

/** Whether a streamed message event's data is a control frame; data that does not parse is not. */
export function isControlEventData(data: string): boolean {
	try {
		const parsed = JSON.parse(data) as { type?: unknown } | null;
		return typeof parsed?.type === "string" && isControlFrameType(parsed.type);
	} catch {
		return false;
	}
}
