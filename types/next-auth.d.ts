import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    accessToken?: string;
    provider?: string;
    providerAccountId?: string;
  }
}
