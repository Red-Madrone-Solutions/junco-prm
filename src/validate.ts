import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { ToolError } from "./errors";
import type { JsonSchema } from "./tools/schema";

/**
 * Real JSON Schema, not a reimplementation of the parts we happen to use.
 *
 * An earlier draft walked the six keywords `src/tools/schema.ts` emits. Its
 * failure mode was that a keyword it did not recognize was silently ignored,
 * which is the same defect this module exists to fix, one level up. This
 * library validates without code generation, which is why it works under
 * workerd where Ajv's `new Function` does not.
 *
 * `shortcircuit: false` so a caller is told everything that is wrong in one
 * refusal rather than discovering problems one round trip at a time.
 */
const provider = new CfWorkerJsonSchemaValidator({ shortcircuit: false });
const validators = new Map<string, ReturnType<typeof provider.getValidator>>();

/**
 * `pattern` is REMOVED before validation, and that is deliberate.
 *
 * `id("p", "Person")` puts `^p_` in the schema so an agent reading tools/list
 * sees the prefix. Enforcing it here would turn `person_id: "re_1"` into
 * `invalid_input`, when `src/ids.ts` reports it as `invalid_id` with a next
 * step naming promote_roster_entry. That distinction is the error design, it
 * is asserted by tests/mcp.test.ts, and the boundary must not flatten it.
 *
 * Type is still enforced, so a non-string id is still refused here.
 */
function withoutPatterns(schema: JsonSchema): JsonSchema {
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (spec !== null && typeof spec === "object" && "pattern" in spec) {
      const { pattern, ...rest } = spec as Record<string, unknown>;
      properties[key] = rest;
    } else {
      properties[key] = spec;
    }
  }
  return { ...schema, properties };
}

function validatorFor(toolName: string, schema: JsonSchema) {
  let validator = validators.get(toolName);
  if (!validator) {
    validator = provider.getValidator(withoutPatterns(schema) as never);
    validators.set(toolName, validator);
  }
  return validator;
}

/**
 * Turns one library error into a sentence a model can act on.
 *
 * The real shape, observed from `result.errorMessage`, is `instanceLocation:
 * message` entries joined by `"; "`, but each property violation appears at
 * least twice: once at `#` ("Property \"x\" does not match schema.") and once
 * at `#/x` (the actual reason) or deeper (`#/x/0` for an array item). The `#`
 * entries are dropped here because they never name the failing key; the top
 * level segment of every other location does, which is also why an item
 * mismatch inside an array (`#/tags/0`) still resolves to `tags`, not `0`,
 * matching this module's top-level-only scope. What a caller needs is the
 * property name and what the schema would have accepted, so the message is
 * built from the schema rather than passed through. It never contains a
 * value: refusals reach the model, and echoing a note or a name into one is
 * how personal data ends up somewhere nobody expected.
 */
function describe(schema: JsonSchema, key: string): string {
  const spec = schema.properties[key] as { type?: string | string[]; enum?: string[] } | undefined;
  if (!spec) {
    const declared = Object.keys(schema.properties).slice().sort().join(", ");
    return `unknown argument ${key}; accepted arguments are ${declared}`;
  }
  if (spec.enum) return `${key} must be one of ${spec.enum.join(", ")}`;
  const types = Array.isArray(spec.type) ? spec.type.join(" or ") : spec.type;
  return `${key} must be ${types ?? "of the declared type"}`;
}

export function validateInput(toolName: string, schema: JsonSchema, input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolError(
      "invalid_input",
      `${toolName}: arguments must be an object`,
      `call ${toolName} again with an object of arguments`
    );
  }

  // undefined is absence, not a wrong value. JSON cannot express it, but a
  // client building arguments in JavaScript can, and `{query: undefined}`
  // means a call with no query.
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== undefined) cleaned[key] = value;
  }

  const result = validatorFor(toolName, schema)(cleaned);
  if (result.valid) return;

  const seen = new Set<string>();
  for (const part of result.errorMessage.split("; ")) {
    const location = part.split(":")[0] ?? "";
    const key = location.replace(/^#\/?/, "").split("/")[0];
    if (!key) continue;
    seen.add(describe(schema, key));
  }
  // Missing required properties are reported by the library against the object
  // itself rather than against the property, so name them explicitly.
  for (const key of schema.required ?? []) {
    if (!(key in cleaned)) seen.add(`${key} is required`);
  }

  throw new ToolError(
    "invalid_input",
    `${toolName}: ${[...seen].join("; ")}`,
    `call tools/list to see ${toolName}'s arguments`
  );
}
