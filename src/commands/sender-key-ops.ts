/**
 * The one sender-key operation the CLI's own commands reach for, re-exported
 * from core so `messages.ts` has a module-shaped seam to mock a send against.
 *
 * It used to carry `distributeSenderKey` and `fetchAndIngestPendingSKDistributions`
 * too, and neither was imported anywhere: the first for as long as this file has
 * existed, the second from the moment `message read` and `stream` stopped
 * hand-rolling the recovery dance and started calling core's
 * `decryptGroupMessageWithRecovery`. A re-export nobody imports is a second name
 * for a function, and a test that mocks the second name while the code calls the
 * first is green and measuring nothing.
 */
export { getOrCreateSenderKey } from "@rine-network/core";
