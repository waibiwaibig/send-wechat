export const SESSION_RENEWAL_AFTER_MS = 23 * 60 * 60 * 1000;
export const SESSION_BLOCK_AFTER_MS = 24 * 60 * 60 * 1000;

/** Keep command recognition identical to the gateway's user-facing syntax. */
export function isRecoverCommand(text: string): boolean {
  return text.trim().replace(/^／/u, "/") === "/recover";
}
