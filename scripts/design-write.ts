// pnpm design:write <pack-id>: regenerate a pack's DESIGN.md (pack:sync does it for synced packs).
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { designMd, readPack } from "@calque/design";

const id = process.argv[2];
if (!id) throw new Error("usage: pnpm design:write <pack-id>");
const dir = join(resolve(import.meta.dirname, "..", "packs"), id);
writeFileSync(join(dir, "DESIGN.md"), designMd(readPack(dir)));
console.log(`wrote packs/${id}/DESIGN.md`);
