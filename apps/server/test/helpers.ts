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

/** The smallest OpenType file a font reader accepts: one `name` table naming the family. */
export function fakeFont(family: string): Buffer {
  const name = Buffer.from(family, "utf16le").swap16();
  const head = Buffer.alloc(12 + 16 + 18);
  head.writeUInt32BE(0x00010000, 0); // sfnt version
  head.writeUInt16BE(1, 4); // one table
  head.write("name", 12, "latin1");
  head.writeUInt32BE(28, 20); // table offset
  head.writeUInt32BE(18 + name.length, 24);
  head.writeUInt16BE(1, 30); // one record
  head.writeUInt16BE(18, 32); // strings offset
  [3, 1, 0x409, 1, name.length, 0].forEach((v, i) => head.writeUInt16BE(v, 34 + 2 * i)); // Windows, en-US, family
  return Buffer.concat([head, name]);
}

export const LOCAL ={ id: "local", teams: [], local: true };
