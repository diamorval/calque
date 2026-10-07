import { z } from "zod";
import { DeckSpec } from "./schema.ts";

export const jsonSchema = () => z.toJSONSchema(DeckSpec, { target: "draft-2020-12", io: "input" });
