import { env } from "cloudflare:workers";
import { getUser, signInPath, signOutPath } from "./auth";
import { ConnectionPanel } from "../components/connection-panel";
import { SignInCard } from "../components/sign-in-card";
export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await getUser();
  if (!user) return <SignInCard signInUrl={signInPath("/")} authProvider={env.DEPLOYMENT_TARGET === "cloudflare" ? "GitHub" : "OpenAI"} />;
  return <ConnectionPanel key={user.userId} accountId={user.userId} signOutUrl={signOutPath()} />;
}
