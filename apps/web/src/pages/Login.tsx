import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Wordmark } from "@diametral/design-system/react";

/** No session: the API refuses everything, sign-in goes through the company's SSO. */
export function Login() {
  const back = `${location.pathname}${location.search}`;
  return (
    <div className="cq-login">
      <Card>
        <CardHeader>
          <Wordmark variant="square" />
          <CardTitle>Sign in to Calque</CardTitle>
          <CardDescription>Use your company account.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="primary" block onClick={() => location.assign(`/auth/login?return=${encodeURIComponent(back)}`)}>
            Sign in with SSO
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
