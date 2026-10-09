import { useEffect, useState, type MouseEvent } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, ""); // "" unless served under a sub-path (the demo)
const here = () => location.pathname.slice(BASE.length) || "/";

// Five routes: history.pushState is enough, no router.
export function navigate(path: string) {
  history.pushState(null, "", BASE + path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(here);
  useEffect(() => {
    const on = () => setPath(here());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}

/** An in-app link's click: pushState for a plain click, the browser's way for a new tab. */
export function go(e: MouseEvent, href: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(href);
}
