/**
 * The one sender-key operation the CLI's own commands reach for, re-exported
 * from core so `messages-send-seal.ts` has a module-shaped seam to mock a send
 * against.
 *
 * It re-exports only what a command imports: a re-export nobody imports is a
 * second name for a function, and a test that mocks the second name while the
 * code calls the first is green and measuring nothing.
 */
export { getOrCreateSenderKey } from "@rine-network/core";
