/**
 * The org a view names itself with: its name and slug from `GET /whoami`, scrubbed. Loading is tolerant, because a
 * title is not worth an error state: any failure, or an answer with no usable slug, reads as no org. The view retries
 * a read that may yet succeed (a network error, a 5xx or a throttle), see `app-org.ts`; a refusal (4xx) or an answer
 * with no org is final.
 */
import {
	MalformedPageError,
	type OrgReader,
	RineApiError,
	validateSlug,
} from "@rine-network/core";
import { clean } from "./clean.js";

export interface OrgIdentity {
	readonly name: string;
	readonly slug: string;
}

/**
 * One read of `GET /whoami`: it either failed (and may succeed later), or answered, with no org when the answer has no
 * usable name or slug, or when the server refused the request for good.
 */
export type OrgRead =
	| { readonly kind: "failed" }
	| { readonly kind: "answered"; readonly org: OrgIdentity | null };

/** A failure no later read cures: the server refused the request (a 4xx but a throttle), or answered without an org. */
function isFinal(error: unknown): boolean {
	if (error instanceof MalformedPageError) return true;
	return (
		error instanceof RineApiError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 429
	);
}

export async function readOrg(reader: Pick<OrgReader, "org">): Promise<OrgRead> {
	try {
		const { name, slug } = await reader.org();
		const shown = clean(name);
		return {
			kind: "answered",
			org: validateSlug(slug) && shown !== "" ? { name: shown, slug } : null,
		};
	} catch (error) {
		return isFinal(error) ? { kind: "answered", org: null } : { kind: "failed" };
	}
}

export async function loadOrg(
	reader: Pick<OrgReader, "org">,
): Promise<OrgIdentity | null> {
	const read = await readOrg(reader);
	return read.kind === "answered" ? read.org : null;
}
