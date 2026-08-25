export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export const str = (description: string) => ({ type: "string", description });
export const int = (description: string) => ({ type: "integer", description });
export const bool = (description: string) => ({ type: "boolean", description });
export const enumOf = (values: string[], description: string) => ({
  type: "string",
  enum: values,
  description,
});
export const nullableStr = (description: string) => ({
  type: ["string", "null"],
  description,
});
export const strArray = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
});

/** An id of one kind, with the prefix stated in the schema so an agent sees it. */
export const id = (prefix: string, what: string) => ({
  type: "string",
  pattern: `^${prefix}_`,
  description: `${what} id, prefixed "${prefix}_"`,
});

/** Every write tool accepts this; it is added by `obj` rather than repeated. */
const IDEMPOTENCY = {
  idempotency_key: str("Optional. Replaying the same key with the same input returns the original result."),
};

export function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
  options: { idempotent?: boolean } = {}
): JsonSchema {
  return {
    type: "object",
    properties: options.idempotent ? { ...properties, ...IDEMPOTENCY } : properties,
    required,
    additionalProperties: false,
  };
}
