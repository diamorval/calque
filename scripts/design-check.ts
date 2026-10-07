// pnpm design:check: per pack, list template-theme vs tokens.json gaps and fail on any that
// pack.yaml does not arbitrate; also fail when DESIGN.md is stale.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { designMd, readPack, reconcile } from "@calque/design";

const packsDir = resolve(import.meta.dirname, "..", "packs");
let failed = false;
for (const id of readdirSync(packsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const pack = readPack(join(packsDir, id));
  const gaps = reconcile(pack);
  console.log(`${id}: ${gaps.length} gap(s)`);
  for (const g of gaps) {
    console.log(`  ${g.arbitrated ? "ok  " : "FAIL"} ${g.slot}: template ${g.template ?? "-"} / tokens ${g.tokens ?? "-"}${g.arbitrated ? ` (${g.arbitrated})` : ""}`);
    failed ||= !g.arbitrated;
  }
  if (readFileSync(join(pack.dir, "DESIGN.md"), "utf8") !== designMd(pack)) {
    console.log(`  FAIL DESIGN.md is stale: run pnpm pack:sync ${id}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
