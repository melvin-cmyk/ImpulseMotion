import { timingSafeEqual } from "node:crypto";

/**
 * Bearer check of the Vercel cron routes (CRON_SECRET), in constant time.
 * Fail closed: no secret configured → every call is refused.
 */
export function checkCronAuth(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}
