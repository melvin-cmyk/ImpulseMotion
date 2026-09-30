/** STUB (lot 0) — replaced by lot B. The signatures are the contract: keep them. */
import type { SlackIdentity } from "@/lib/client-alerts/types";

/** The n8n webhook of the private messages is set. */
export function dmConfigured(): boolean {
  return false;
}

/** null = Slack knows nobody with this address. Throws when n8n or Slack fails. */
export async function lookupSlackUser(_email: string): Promise<{ id: string; name: string | null } | null> {
  throw new Error("not implemented");
}

export async function sendSlackDm(_slackUserId: string, _text: string): Promise<void> {
  throw new Error("not implemented");
}

/** Pure: what the columns of User say. */
export function slackIdentityOf(_user: { email: string | null; slackEmail: string | null; slackUserId: string | null; slackCheckedAt: Date | null }): SlackIdentity {
  throw new Error("not implemented");
}

/**
 * Reads User, looks the address up in Slack when it has never been found (at most once a day when unknown,
 * always with `force`), stores the result. `email` replaces User.slackEmail first.
 */
export async function resolveSlackIdentity(_userId: string, _opts: { force?: boolean; email?: string | null } = {}): Promise<SlackIdentity> {
  throw new Error("not implemented");
}
