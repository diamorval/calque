import { Button } from "diametral-ds/button";
import { Card } from "diametral-ds/card";
import { LogIn } from "lucide-react";
import type { Branding } from "../api.ts";
import { t } from "../i18n.ts";
import { Logo } from "../ui.tsx";

/** No session: the API refuses everything, sign-in goes through the company's SSO. */
export function Login({ brand }: { brand: Branding }) {
  const back = `${location.pathname}${location.search}`;
  return (
    <main className="cq-login">
      <Card className="cq-login-card">
        <span className="cq-login-mark">
          <Logo brand={brand} size={36} />
        </span>
        <h1>{t("Sign in to {name}", { name: brand.name })}</h1>
        <p>{t("Build and edit decks with an agent, on your company's template. Use your company account.")}</p>
        <Button size="lg" onClick={() => location.assign(`/auth/login?return=${encodeURIComponent(back)}`)}>
          <LogIn /> {t("Sign in with SSO")}
        </Button>
      </Card>
    </main>
  );
}
