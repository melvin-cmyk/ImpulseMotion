/**
 * Sign-in throttling — failed attempts counted by email and by IP in the
 * database (the only memory shared by every Vercel instance).
 *
 *   email  5 failures within 15 min → that account is locked 15 min
 *   ip     30 failures within 15 min → that address is locked 15 min
 *
 * A locked attempt is refused like a wrong password (no hint that the
 * account exists). A success clears the email's counter. Never throws: when
 * the database cannot be read, sign-in works as before.
 */

import { prisma } from "@/lib/prisma";

export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
export const LIMITS = { email: 5, ip: 30 } as const;

export interface ThrottleRow { failures: number; firstAt: Date; lockedUntil: Date | null }

/** Pure: is this key locked now? */
export function isLocked(row: ThrottleRow | null, now: Date): boolean {
  return !!row?.lockedUntil && row.lockedUntil.getTime() > now.getTime();
}

/** Pure: the row after one more failure. */
export function afterFailure(row: ThrottleRow | null, limit: number, now: Date): ThrottleRow {
  const fresh = !row || now.getTime() - row.firstAt.getTime() > WINDOW_MS;
  const failures = fresh ? 1 : row!.failures + 1;
  const firstAt = fresh ? now : row!.firstAt;
  return { failures, firstAt, lockedUntil: failures >= limit ? new Date(now.getTime() + LOCK_MS) : row?.lockedUntil ?? null };
}

const keys = (email: string, ip: string | null) => [
  { key: `email:${email}`, limit: LIMITS.email },
  ...(ip ? [{ key: `ip:${ip}`, limit: LIMITS.ip }] : []),
];

export function clientIp(headers: Headers | undefined | null): string | null {
  const raw = headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || headers?.get("x-real-ip") || "";
  return raw && raw.length <= 64 ? raw : null;
}

export async function signInLocked(email: string, ip: string | null, now = new Date()): Promise<boolean> {
  try {
    const rows = await prisma.loginThrottle.findMany({ where: { key: { in: keys(email, ip).map((k) => k.key) } } });
    return rows.some((r) => isLocked(r, now));
  } catch (e) {
    console.error("[login-throttle] unreadable", e);
    return false;
  }
}

export async function recordFailure(email: string, ip: string | null, now = new Date()): Promise<void> {
  try {
    for (const { key, limit } of keys(email, ip)) {
      const row = await prisma.loginThrottle.findUnique({ where: { key } });
      const next = afterFailure(row, limit, now);
      await prisma.loginThrottle.upsert({ where: { key }, create: { key, ...next }, update: next });
      if (next.lockedUntil && (!row?.lockedUntil || row.lockedUntil < now)) console.warn(`[login-throttle] ${key.startsWith("ip:") ? "adresse" : "compte"} bloqué 15 min après ${next.failures} échecs`);
    }
  } catch (e) {
    console.error("[login-throttle] not recorded", e);
  }
}

export async function recordSuccess(email: string): Promise<void> {
  await prisma.loginThrottle.deleteMany({ where: { key: `email:${email}` } }).catch(() => {});
}
