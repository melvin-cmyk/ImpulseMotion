import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

/** How long a session token may keep its cached role before the database has
 *  the final word again. Bounds how long a revoked admin keeps their powers. */
const ROLE_TTL_MS = 5 * 60 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [
    Credentials({
      id: "credentials",
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

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
        return token;
      }
      if (!token.userId) return token;

      // The role travels in the token, so demoting or deleting a user would
      // otherwise stay without effect until it expires. Re-read it from the
      // database at most every ROLE_TTL_MS (this callback runs on every
      // authenticated request, including the proxy).
      const checkedAt = (token.roleCheckedAt as number | undefined) ?? 0;
      if (token.role && Date.now() - checkedAt < ROLE_TTL_MS) return token;

      const db = await prisma.user.findUnique({
        where: { id: token.userId as string },
        select: { role: true },
      });
      if (!db) {
        // Account deleted → drop the identity; the proxy and requireSession
        // then treat the request as anonymous.
        delete token.userId;
        delete token.role;
        return token;
      }
      token.role = db.role;
      token.roleCheckedAt = Date.now();
      return token;
    },
    async session({ session, token }) {
      return {
        ...session,
        userId: token.userId as string,
        role: (token.role as string) ?? "client",
      };
    },
  },
  pages: { signIn: "/login", error: "/login" },
});
