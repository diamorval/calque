// An assistant reply. The one that just arrived reveals word by word (the agent returns its whole
// text at the end, so this is presentation only); older ones, and reduced motion, show at once.
// Adapted from beautifului.dev (MIT): StreamingText.
import { useEffect, useState } from "react";

const MAX_MS = 1500; // the whole reveal, however long the reply
const TICK_MS = 30;

export function StreamingText({ text, animate }: { text: string; animate?: boolean }) {
  // words with their trailing spaces, so a slice keeps the line breaks
  const words = text.match(/\S+\s*/g) ?? [];
  const still = !animate || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = useState(still ? words.length : 0);
  useEffect(() => {
    if (shown >= words.length) return;
    const step = Math.max(1, Math.ceil(words.length / (MAX_MS / TICK_MS)));
    const id = setTimeout(() => setShown((n) => n + step), TICK_MS);
    return () => clearTimeout(id);
  }, [shown, words.length]);
  return <p>{shown >= words.length ? text : words.slice(0, shown).join("")}</p>;
}
