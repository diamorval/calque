// Writes deckspec.schema.json, the contract the Python engine validates against.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSchema } from "./json-schema.ts";

const schema = jsonSchema();
const out = JSON.stringify(schema, null, 2) + "\n";
// Two copies of one generated file: the package export, and the engine's (Python reads it offline).
for (const target of ["../deckspec.schema.json", "../../../engine/src/calque_engine/schemas/deckspec.schema.json"])
  writeFileSync(join(import.meta.dirname, target), out);
