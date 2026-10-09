// A deck end to end against a running server: built by the engine, slide 1 rendered by LibreOffice.
//   docker run -d --network host -e CALQUE_SECRET=… calque   (no issuer: it listens on loopback)
//   node scripts/docker-smoke.ts packs/diametral/tests/golden/data-fr.json
import { readFileSync } from "node:fs";

const api = process.env.CALQUE_URL ?? "http://127.0.0.1:8787";
const deck = JSON.parse(readFileSync(process.argv[2] ?? "packs/diametral/tests/golden/data-fr.json", "utf8"));
const res = await fetch(`${api}/api/tools/create_deck`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deck }),
});
const created = (await res.json()) as { deck_id?: string };
if (!res.ok || !created.deck_id) throw new Error(`create_deck ${res.status}: ${JSON.stringify(created)}`);
const png = await fetch(`${api}/decks/${created.deck_id}/slides/1.png`);
if (!png.ok || png.headers.get("content-type") !== "image/png") throw new Error(`render ${png.status}: ${await png.text()}`);
console.log(`deck ${created.deck_id}: built, slide 1 rendered (${(await png.arrayBuffer()).byteLength} bytes)`);
