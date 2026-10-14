import { z } from "zod";
import { DesignSpec } from "./design.ts";
import { DeckSpec } from "./schema.ts";

export const jsonSchema = () => z.toJSONSchema(DeckSpec, { target: "draft-2020-12", io: "input" });
export const designJsonSchema = () => z.toJSONSchema(DesignSpec, { target: "draft-2020-12", io: "input" });
