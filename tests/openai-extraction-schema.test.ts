import { describe, expect, it } from "vitest";
import { extractionResultSchema } from "../lib/domain/extraction-schema";
import {
  COMPACT_OPENAI_EXTRACTION_SCHEMA,
  OPENAI_EXTRACTION_SCHEMA,
} from "../lib/providers/openai-extraction-schema";
import { normalizeProviderExtractionOutput } from "../lib/providers/provider-output-normalization";

describe("OpenAI structured extraction contract", () => {
  type JsonObject = Record<string, unknown>;
  const object = (value: unknown) => value as JsonObject;
  const props = (value: unknown) => object(object(value).properties);

  it("makes every nested object strict and uses supported unions", () => {
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach(visit);
      const node = value as Record<string, unknown>;
      expect(node).not.toHaveProperty("oneOf");
      if (node.properties) {
        expect(node.additionalProperties).toBe(false);
        expect(node.required).toEqual(Object.keys(node.properties));
      }
      Object.values(node).forEach(visit);
    }
    visit(OPENAI_EXTRACTION_SCHEMA);
  });

  it("allows null only for optional fields without weakening domain validation", () => {
    const properties = object(OPENAI_EXTRACTION_SCHEMA.properties);
    const task = props(object(properties.tasks).items);
    expect(object(task.dueDate).anyOf).toContainEqual({ type: "null" });
    expect(object(task.title).anyOf).toBeUndefined();
    expect(object(props(task.fieldConfidence).taskType).anyOf).toBeUndefined();
    const input = { currentLocalDate: "2026-09-15", timeZone: "America/Los_Angeles", text: "Meet at 11 AM." };
    const output = { tasks: [{
      title: "Meet", taskType: "fixed_time", dueDate: null,
      fixedStartAt: "2026-09-15T11:00:00-07:00", fixedEndAt: "2026-09-15T12:00:00-07:00",
      priority: "medium", category: "personal", energyDemand: "low", splittable: false,
      confidence: 0.9, fieldConfidence: { title: 0.9, taskType: 0.9, dueDate: null },
      missingInformation: [], sourceText: input.text,
    }], ignoredStatements: [], planningRules: null };
    const normalized = normalizeProviderExtractionOutput(output, input);
    expect(extractionResultSchema.parse(normalized).tasks[0].dueDate).toBeUndefined();
    output.tasks[0].fixedEndAt = output.tasks[0].fixedStartAt;
    expect(extractionResultSchema.safeParse(normalizeProviderExtractionOutput(output, input)).success).toBe(false);
  });

  it("keeps semantic field guidance in the provider schema", () => {
    const properties = object(OPENAI_EXTRACTION_SCHEMA.properties);
    const task = props(object(properties.tasks).items);
    const description = (field: unknown) => {
      const value = object(field);
      if (typeof value.description === "string") return value.description;
      const variants = Array.isArray(value.anyOf) ? value.anyOf : [];
      return variants.map((entry) => object(entry).description).find((entry) => typeof entry === "string");
    };
    expect(description(task.dueDate)).toMatch(/latest completion date/i);
    expect(description(task.estimatedMinutes)).toMatch(/one recurring occurrence/i);
    expect(description(task.dependencies)).toMatch(/ordering links/i);
    expect(description(task.schedulingConstraints)).toMatch(/partial-day restrictions/i);
  });

  it("keeps the compact verifier schema strict while retaining semantic fields", () => {
    const properties = object(COMPACT_OPENAI_EXTRACTION_SCHEMA.properties);
    const task = object(object(properties.tasks).items);
    expect(properties).not.toHaveProperty("interpretation");
    expect(task.properties).toHaveProperty("durationRange");
    expect(task.properties).toHaveProperty("dependencies");
    expect(task.properties).not.toHaveProperty("fieldProvenance");
    expect(task.additionalProperties).toBe(false);
    expect(task.required).toEqual(Object.keys(object(task.properties)));
  });
});
