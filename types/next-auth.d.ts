import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    userId: string;
    role: string;
  }
  interface User {
    role?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: string;
    /** Epoch ms of the last time `role` was re-read from the database. */
    roleCheckedAt?: number;
  }
}
