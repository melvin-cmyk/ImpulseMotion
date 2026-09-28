import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    userId: string;
    role: string;
    /** Fingerprint of the role and the ad accounts (lib/acl-version.ts). */
    aclVersion: string;
  }
  interface User {
    role?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: string;
    acl?: string;
    /** Epoch ms of the last time `role` was re-read from the database. */
    roleCheckedAt?: number;
  }
}
