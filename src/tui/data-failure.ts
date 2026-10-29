/**
 * What a failed read means to the poller: the feed's error code, how long to wait, and whether to
 * give up.
 */
import {
	MalformedPageError,
	ReaderNetworkError,
	RineApiError,
	retryAfterMsFromError,
} from "@rine-network/core";
import { FeedErrorCode } from "./feed-schema.js";

export const DEFAULT_RETRY_S = 30;
export const MAX_RETRY_S = 120;
const REFUSED_STATUSES: readonly number[] = [401, 403, 404];
const RATE_LIMITED_STATUS = 429;

export interface Failure {
	readonly code: FeedErrorCode;
	/** Null when the poller stops for good. */
	readonly retryS: number | null;
}

/**
 * A 429 honours Retry-After (30 s without one), then doubles on each further 429 up to two minutes;
 * `rateLimitedS` is the last wait. Anything this does not know is a defect and is thrown.
 */
export function classifyFailure(
	err: unknown,
	pollS: number,
	rateLimitedS: number,
): Failure {
	if (err instanceof RineApiError) {
		if (REFUSED_STATUSES.includes(err.status))
			return { code: FeedErrorCode.AuthRefused, retryS: null };
		if (err.status === RATE_LIMITED_STATUS) {
			const told = Math.ceil(retryAfterMsFromError(err) / 1000);
			const waitS =
				rateLimitedS === 0
					? told || DEFAULT_RETRY_S
					: Math.max(rateLimitedS * 2, told);
			return {
				code: FeedErrorCode.RateLimited,
				retryS: Math.min(MAX_RETRY_S, waitS),
			};
		}
		return { code: FeedErrorCode.Server, retryS: pollS };
	}
	if (err instanceof ReaderNetworkError)
		return { code: FeedErrorCode.Network, retryS: pollS };
	if (err instanceof MalformedPageError)
		return { code: FeedErrorCode.MalformedPage, retryS: pollS };
	throw err;
}
