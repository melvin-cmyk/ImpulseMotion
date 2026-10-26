import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { aclVersion } from "@/lib/acl-version";
import { effectiveRole } from "@/lib/roles";
import { hasRoutinesAccess } from "@/lib/routines/access-rule";
import { clientIp, recordFailure, recordSuccess, signInLocked } from "@/lib/login-throttle";

/** How long a session token may keep its cached role before the database has
 *  the final word again. Bounds how long a revoked admin keeps their powers,
 *  and how long a consultant waits for a new role or a new account to show —
 *  short, so nobody has to sign out and in again after an admin's change. */
const ROLE_TTL_MS = 20 * 1000;

/** Role and accounts of a user, as the session carries them. */
/** Hash compared when the e-mail is unknown: the answer then takes as long as for a wrong password. */
const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8Q7u0wD3Yx9YQ1y6E0y0f5u5Yq0rW2";

async function readAccess(userId: string): Promise<{ role: string; acl: string; passwordChangedAt: Date | null } | null> {
  const db = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, passwordChangedAt: true, adAccounts: { select: { platform: true, accountId: true } } },
  });
  return db ? { role: db.role, acl: aclVersion(db.role, db.adAccounts), passwordChangedAt: db.passwordChangedAt } : null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  // A week of validity, renewed on use: a stolen token does not live a month.
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  trustHost: true,
  providers: [
    Credentials({
      id: "credentials",
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(creds, request) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;

        // Too many failures for this account or this address: refused like a wrong password (lib/login-throttle.ts).
        const ip = clientIp(request?.headers);
        if (await signInLocked(email, ip)) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        const ok = (await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH)) && !!user?.passwordHash;
        if (!user || !ok) {
          await recordFailure(email, ip);
          return null;
        }
        await recordSuccess(email);

        return {
          id: user.id,
          email: user.email ?? undefined,
          name: user.name ?? undefined,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.role = (user as { role?: string }).role ?? "client";
        token.roleCheckedAt = Date.now();
        token.issuedAt = Date.now();
        token.acl = (await readAccess(user.id as string).catch(() => null))?.acl;
        return token;
      }
      if (!token.userId) return token;

      // The role travels in the token, so demoting or deleting a user would
      // otherwise stay without effect until it expires. Re-read it from the
      // database at most every ROLE_TTL_MS (this callback runs on every
      // authenticated request, including the proxy).
      const checkedAt = (token.roleCheckedAt as number | undefined) ?? 0;
      if (token.role && Date.now() - checkedAt < ROLE_TTL_MS) return token;

      const db = await readAccess(token.userId as string);
      if (!db) {
        // Account deleted → drop the identity; the proxy and requireSession
        // then treat the request as anonymous.
        delete token.userId;
        delete token.role;
        delete token.acl;
        return token;
      }
      // A password change signs every other session of the account out.
      const issuedAt = (token.issuedAt as number | undefined) ?? 0;
      if (db.passwordChangedAt && issuedAt && db.passwordChangedAt.getTime() > issuedAt + 1000) {
        delete token.userId;
        delete token.role;
        delete token.acl;
        return token;
      }
      token.role = db.role;
      token.acl = db.acl;
      token.roleCheckedAt = Date.now();
      return token;
    },
    async session({ session, token }) {
      const role = effectiveRole(token.role as string | undefined);
      const baseRole = (token.role as string) ?? "client";
      return {
        ...session,
        userId: token.userId as string,
        // What the checks apply, and what the person really is (lib/roles.ts).
        role,
        baseRole,
        aclVersion: (token.acl as string | undefined) ?? "",
        // Decided here, on the server (ROUTINES_ACCESS): the menu shows « Routines » on this word alone.
        routinesAccess: hasRoutinesAccess({ userId: token.userId as string | undefined, role, baseRole }),
      };
    },
  },
  pages: { signIn: "/login", error: "/login" },
});
