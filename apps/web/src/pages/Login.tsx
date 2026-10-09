import { LogIn } from "lucide-react";
import { Button, Mark } from "../ui.tsx";

/** No session: the API refuses everything, sign-in goes through the company's SSO. */
export function Login() {
  const back = `${location.pathname}${location.search}`;
  return (
    <main className="cq-login">
      <div className="cq-login-card cq-card">
        <span className="cq-login-mark">
          <Mark size={36} />
        </span>
        <h1>Sign in to Calque</h1>
        <p>Build and edit decks with an agent, on your company's template. Use your company account.</p>
        <Button variant="primary" size="lg" onClick={() => location.assign(`/auth/login?return=${encodeURIComponent(back)}`)}>
          <LogIn /> Sign in with SSO
        </Button>
      </div>
    </main>
  );
}
