import { Button } from "diametral-ds/button";
import { Card } from "diametral-ds/card";
import { Wordmark } from "diametral-ds/wordmark";
import { LogIn } from "lucide-react";
import { Mark } from "../ui.tsx";

/** No session: the API refuses everything, sign-in goes through the company's SSO. */
export function Login() {
  const back = `${location.pathname}${location.search}`;
  return (
    <main className="cq-login">
      <Card className="cq-login-card">
        <span className="cq-login-mark">
          <Mark size={36} />
        </span>
        <h1>Sign in to Calque</h1>
        <p>Build and edit decks with an agent, on your company's template. Use your company account.</p>
        <Button size="lg" onClick={() => location.assign(`/auth/login?return=${encodeURIComponent(back)}`)}>
          <LogIn /> Sign in with SSO
        </Button>
        <Wordmark className="cq-login-by" label="Diametral" />
      </Card>
    </main>
  );
}
