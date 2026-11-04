import { GOOGLE_SIGN_IN } from "@/auth";
import LoginFormPage from "./login-form";

// The Google button depends on the server's configuration (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET).
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <LoginFormPage google={GOOGLE_SIGN_IN} />;
}
