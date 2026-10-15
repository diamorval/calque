// Writes deckspec.schema.json and designspec.schema.json, the contracts the Python engine validates against.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { designJsonSchema, jsonSchema } from "./json-schema.ts";

// Two copies of each generated file: the package export, and the engine's (Python reads it offline).
for (const [name, schema] of [["deckspec", jsonSchema()], ["designspec", designJsonSchema()]] as const) {
  const out = JSON.stringify(schema, null, 2) + "\n";
  for (const target of [`../${name}.schema.json`, `../../../engine/src/calque_engine/schemas/${name}.schema.json`])
    writeFileSync(join(import.meta.dirname, target), out);
}
