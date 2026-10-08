import "server-only";

/**
 * WHO MAY USE CHAT BOSS (/chat).
 *
 * Chat Boss used to be a staff tool: any staff session could open any client
 * with a typed reason. Staff access is off (2026-10-07) and stays off; Paolo's
 * decision of 2026-10-08 brings Chat Boss back for named people only:
 *
 *   * the addresses in CHAT_BOSS_EMAILS on the app service — a deliberate
 *     list, empty (nobody) by default, changed only by whoever controls the
 *     service's variables, like OPERATOR_EMAILS on the login host;
 *   * on the business they have open, and only one they are a member of with
 *     a role that can read its jobs — the central authorization function
 *     decides that, every request (lib/auth/authorize.ts, requireChatBoss*).
 *
 * There is no house workspace and no way to open another client from here:
 * reaching a business you do not belong to waits for agency grants.
 */
export function chatBossEmails(): Set<string> {
  return new Set(
    (process.env.CHAT_BOSS_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@")),
  );
}

export function mayUseChatBoss(email: string | null | undefined): boolean {
  return !!email && chatBossEmails().has(email.trim().toLowerCase());
}
