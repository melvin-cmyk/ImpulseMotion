import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    userId?: string;
    metaAccessToken?: string | null;
    tiktokAccessToken?: string | null;
    metaProviderAccountId?: string | null;
    tiktokProviderAccountId?: string | null;
  }
}
