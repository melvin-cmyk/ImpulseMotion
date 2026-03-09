import NextAuth from "next-auth";

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  providers: [
    {
      id: "facebook",
      name: "Meta",
      type: "oauth",
      authorization: {
        url: "https://www.facebook.com/v18.0/dialog/oauth",
        params: {
          scope: "ads_read,ads_management,read_insights",
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
          email: profile.email,
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
        };
      },
    },
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.provider = account.provider;
        token.providerAccountId = account.providerAccountId;
      }
      return token;
    },
    async session({ session, token }) {
      return {
        ...session,
        accessToken: token.accessToken as string,
        provider: token.provider as string,
        providerAccountId: token.providerAccountId as string,
      };
    },
  },
  pages: {
    signIn: "/settings",
  },
});
