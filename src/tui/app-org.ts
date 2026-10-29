/** The org the view names itself with: read once at start and, if that read fails, again on each poll tick until one answers or is refused. */
import type { OrgReader } from "@rine-network/core";
import { type OrgIdentity, readOrg } from "./org-identity.js";

export interface OrgLoader {
	/** The first read; settles once it has answered or failed. */
	load(): Promise<void>;
	/**
	 * A poll tick passed: read again unless a read has answered. Settles true when this read answered with an
	 * org.
	 */
	retry(): Promise<boolean>;
}

/** `apply` takes every answer, once. A throw in it reaches the caller of `load` or `retry`. */
export function createOrgLoader(
	reader: Pick<OrgReader, "org">,
	apply: (org: OrgIdentity | null) => void,
): OrgLoader {
	let answered = false;
	let reading = false;
	const attempt = async (): Promise<boolean> => {
		if (answered || reading) return false;
		reading = true;
		const read = await readOrg(reader);
		reading = false;
		if (read.kind === "failed") return false;
		answered = true;
		apply(read.org);
		return read.org !== null;
	};
	return { load: async () => void (await attempt()), retry: attempt };
}
