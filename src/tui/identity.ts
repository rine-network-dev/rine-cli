/**
 * Who the org view reads as. Only the org key reads: a `root.key` in the owner dir
 * becomes the reader; a branch key file or a profile that resolves (agent, branch or reader
 * principal) means the person has a rine identity but not the key that opens the org.
 */
import {
	OrgReader,
	ReadKey,
	TokenBucket,
	hasRoot,
	holdsBranchKeys,
	resolveApiUrl,
	resolveAuth,
	resolveConfigDir,
	resolveOwnerDir,
} from "@rine-network/core";
import { FeedErrorCode } from "./feed-schema.js";

export const IdentityKind = {
	Reader: "reader",
	Blocked: "blocked",
} as const;

export type IdentityResult =
	| {
			kind: typeof IdentityKind.Reader;
			/** The org-wide read key; `reader.close()` disposes it and nobody else does. */
			key: ReadKey;
			/** Reads as the org reader; closing it zeroes `key`. */
			reader: OrgSession;
			/** The process's one request budget, shared by the reader and the poller. */
			bucket: TokenBucket;
	  }
	| {
			kind: typeof IdentityKind.Blocked;
			code: typeof FeedErrorCode.NeedsOrgKey | typeof FeedErrorCode.NoIdentity;
	  };

/** Closes the org reader, which disposes the key; a blocked identity holds nothing. */
export async function releaseIdentity(identity: IdentityResult): Promise<void> {
	if (identity.kind === IdentityKind.Reader) await identity.reader.close();
}

/** What the view needs of the org reader. */
export type OrgSession = Pick<OrgReader, "read" | "close" | "org">;

export interface IdentityInput {
	configDir?: string;
	ownerDir?: string;
	apiUrl?: string;
	profile?: string;
}

/** The org id comes from the root itself, never from a server answer. */
export function resolveIdentity(input: IdentityInput = {}): IdentityResult {
	const configDir = input.configDir ?? resolveConfigDir();
	const ownerDir = input.ownerDir ?? resolveOwnerDir();
	if (hasRoot(ownerDir)) {
		const key = ReadKey.fromOwnerDir(ownerDir);
		const bucket = new TokenBucket();
		const reader = new OrgReader({
			key,
			apiUrl: input.apiUrl ?? resolveApiUrl(),
			bucket,
		});
		return { kind: IdentityKind.Reader, key, reader, bucket };
	}
	if (
		holdsBranchKeys(configDir) ||
		resolveAuth({ configDir, ownerDir }, input.profile) !== undefined
	) {
		return { kind: IdentityKind.Blocked, code: FeedErrorCode.NeedsOrgKey };
	}
	return { kind: IdentityKind.Blocked, code: FeedErrorCode.NoIdentity };
}
