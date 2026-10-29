/**
 * Public address of the app, for links that leave it (Slack, e-mails).
 * NEXTAUTH_URL is not set in production (it would pin next-auth to one host;
 * trustHost serves impulsemotion.ai and impulsemotion.vercel.app alike).
 */
export const APP_URL_DEFAULT = "https://impulsemotion.ai";

export const appUrl = () => (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || APP_URL_DEFAULT).replace(/\/$/, "");
