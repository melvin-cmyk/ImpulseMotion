import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  secret: process.env.AUTH_SECRET,
  session: {
    strategy: "database",
  },
  providers: [
    {
      id: "facebook",
      name: "Meta",
      type: "oauth",
      authorization: {
        url: "https://www.facebook.com/v18.0/dialog/oauth",
        params: {
          scope: "ads_read,ads_management",
          response_type: "code",
        },
      },
      token: "https://graph.facebook.com/v18.0/oauth/access_token",
      userinfo: "https://graph.facebook.com/v18.0/me?fields=id,name,email",
      clientId: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      profile(profile) {
        return {
          id: profile.id,
          name: profile.name,
          email: profile.email ?? null,
          image: profile.picture?.data?.url ?? null,
        };
      },
    },
    {
      id: "tiktok",
      name: "TikTok",
      type: "oauth",
      authorization: {
        url: "https://ads.tiktok.com/marketing_api/auth",
        params: {
          scope: "advertiser.read,reporting.read",
          response_type: "code",
        },
      },
      token: "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
      userinfo: "https://business-api.tiktok.com/open_api/v1.3/user/info/",
      clientId: process.env.TIKTOK_APP_ID,
      clientSecret: process.env.TIKTOK_APP_SECRET,
      profile(profile) {
        return {
          id: profile.data?.core_user_info?.user_id?.toString() ?? "",
          name: profile.data?.core_user_info?.display_name ?? "",
          email: null,
          image: null,
        };
      },
    },
  ],
  callbacks: {
    async session({ session, user }) {
      // Fetch all linked provider accounts for this user
      const accounts = await prisma.account.findMany({
        where: { userId: user.id },
      });
      const facebookAccount = accounts.find((a) => a.provider === "facebook");
      const tiktokAccount = accounts.find((a) => a.provider === "tiktok");
      return {
        ...session,
        userId: user.id,
        metaAccessToken: facebookAccount?.access_token ?? null,
        tiktokAccessToken: tiktokAccount?.access_token ?? null,
        metaProviderAccountId: facebookAccount?.providerAccountId ?? null,
        tiktokProviderAccountId: tiktokAccount?.providerAccountId ?? null,
      };
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});
