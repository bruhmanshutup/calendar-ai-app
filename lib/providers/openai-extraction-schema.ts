import { z } from "zod";
import { extractionResultSchema } from "../domain/extraction-schema";

type JsonSchema = Record<string, unknown>;

// Structured Outputs requires every property to be required. Represent absent
// optional fields with null; provider normalization removes those nulls before
// the domain validator applies its cross-field rules.
function strictSchema(schema: JsonSchema): JsonSchema {
  const result = { ...schema };
  delete result.$schema;
  if (schema.properties) {
    const required = new Set((schema.required ?? []) as string[]);
    const properties = schema.properties as Record<string, JsonSchema>;
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => {
        const child = strictSchema(property);
        return [name, required.has(name) ? child : { anyOf: [child, { type: "null" }] }];
      }),
    );
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  if (schema.items) result.items = strictSchema(schema.items as JsonSchema);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) result[key] = schema[key].map(strictSchema);
  }
  // Zod emits oneOf for disjoint discriminated unions; the API supports anyOf.
  if (result.oneOf) {
    result.anyOf = result.oneOf;
    delete result.oneOf;
  }
  return result;
}

export const OPENAI_EXTRACTION_SCHEMA = (() => {
  const schema = strictSchema(z.toJSONSchema(extractionResultSchema, { target: "draft-7" }));
  const task = ((schema.properties as Record<string, JsonSchema>).tasks.items as JsonSchema);
  // Only the app can attach a local file; never ask the model to invent one.
  delete (task.properties as Record<string, JsonSchema>).sourceDocument;
  // Classification is derived by the app after validation; do not ask the
  // provider to repeat the same semantics in a second tree.
  delete (task.properties as Record<string, JsonSchema>).classification;
  task.required = (task.required as string[]).filter((key) => key !== "sourceDocument" && key !== "classification");
  return schema;
})();

/**
 * The first pass of the optional verifier does not need app-maintained
 * provenance or lifecycle counters. Removing those fields keeps the draft
 * compact while leaving every semantic extraction field available to the
 * second pass.
 */
export const COMPACT_OPENAI_EXTRACTION_SCHEMA = (() => {
  const schema = structuredClone(OPENAI_EXTRACTION_SCHEMA);
  const root = schema.properties as Record<string, JsonSchema>;
  delete root.interpretation;
  schema.required = (schema.required as string[]).filter((key) => key !== "interpretation");
  const task = (root.tasks.items as JsonSchema);
  const taskProperties = task.properties as Record<string, JsonSchema>;
  const omitted = [
    "approved",
    "completed",
    "completedAt",
    "completedMinutes",
    "cancelled",
    "cancelledAt",
    "sourceSpan",
    "fieldProvenance",
  ];
  omitted.forEach((key) => delete taskProperties[key]);
  task.required = (task.required as string[]).filter((key) => !omitted.includes(key));
  return schema;
})();
