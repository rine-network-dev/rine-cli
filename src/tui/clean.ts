import { clipToWidth, scrub } from "@rine-network/core";

/** A server string as one scrubbed line; every wire-derived label goes through this before it is drawn. */
export const clean = (value: string): string => scrub(value, true).text;

/** `clean`, then cut to at most `cells` columns (no ellipsis). */
export const cleanTo = (value: string, cells: number): string =>
	clipToWidth(clean(value), cells);
