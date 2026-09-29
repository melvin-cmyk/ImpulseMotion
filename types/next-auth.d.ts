import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    userId: string;
    role: string;
    /** Role of the person in the database; `role` is the one applied (lib/roles.ts). */
    baseRole: string;
    /** Fingerprint of the role and the ad accounts (lib/acl-version.ts). */
    aclVersion: string;
    /** The person may enter the space of the routines (lib/routines/access-rule.ts), decided on the server. */
    routinesAccess: boolean;
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
