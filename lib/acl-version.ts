/**
 * Fingerprint of what a user may see: their role and their ad accounts. It
 * travels in the session so that an open tab notices, without signing out,
 * that an admin changed the role or the accounts (components/acl-watcher.tsx).
 * Pure: no secret in it, only a short hash.
 */
export function aclVersion(role: string, accounts: Array<{ platform: string; accountId: string }>): string {
  const text = [role, ...accounts.map((a) => `${a.platform}:${a.accountId.replace(/^act_/, "")}`).sort()].join("|");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${accounts.length}-${h.toString(36)}`;
}

/** Browser event sent when the viewer's role or accounts changed. */
export const ACL_CHANGED_EVENT = "impulse:acl-changed";
