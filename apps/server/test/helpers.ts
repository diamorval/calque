import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeckSpec } from "@calque/deckspec";
import { createApp } from "../src/app.ts";
import { REPO } from "../src/engine.ts";

export const ENGINE_TIMEOUT = 120_000;

/** A fresh app on an in-memory PGlite and a temp data dir. */
export async function testApp() {
  const data = mkdtempSync(join(tmpdir(), "calque-"));
  return createApp({ data, db: "memory://", publicUrl: "http://calque.test" });
}

/** The acme-test golden deck: cover, divider, chart, diagram, composition, closing. */
export function acmeDeck(): DeckSpec {
  return JSON.parse(readFileSync(join(REPO, "packs/acme-test/tests/golden/basics-en.json"), "utf8"));
}

export const LOCAL = { id: "local", teams: [], local: true };
