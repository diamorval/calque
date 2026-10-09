import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@calque/slide-ui/styles.css";
import "./app.css";
import { App } from "./App.tsx";

if (import.meta.env.VITE_DEMO) await (await import("./demo.ts")).startDemo();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
