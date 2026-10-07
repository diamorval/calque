import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@diametral/design-system/css/diametral.css";
import "@calque/slide-ui/styles.css";
import "./app.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
