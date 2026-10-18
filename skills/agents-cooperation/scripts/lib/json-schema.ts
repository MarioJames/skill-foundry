/** Minimal JSON Schema (draft 2020-12 subset) validator for the keywords our schemas use. */
export interface Issue { path: string; message: string }
export type Schema = { [key: string]: any };

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "$defs", "title", "description", "default", "examples"]);
const APPLICATORS = new Set(["type", "properties", "required", "additionalProperties", "enum", "const", "pattern", "minimum", "minLength", "minItems", "uniqueItems", "items", "$ref", "if", "then", "propertyNames"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const child = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "null": return value === null;
    default: throw new Error(`unsupported type: ${type}`);
  }
}
function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/$defs/")) throw new Error(`unsupported $ref: ${ref}`);
  const definitions = Object.hasOwn(root, "$defs") ? root.$defs : undefined;
  const name = ref.slice("#/$defs/".length);
  const target = definitions && Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  if (!target) throw new Error(`unresolved $ref: ${ref}`);
  return target;
}
/** Throw when a schema uses a keyword this validator does not implement. */
export function lintSchema(schema: Schema, where = "#"): void {
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !APPLICATORS.has(key)) throw new Error(`unsupported schema keyword ${key} at ${where}`);
  }
  const sub = (s: unknown, at: string) => { if (s && typeof s === "object") lintSchema(s as Schema, at); };
  for (const [name, s] of Object.entries(schema.$defs ?? {})) sub(s, `${where}/$defs/${name}`);
  for (const [name, s] of Object.entries(schema.properties ?? {})) sub(s, `${where}/properties/${name}`);
  for (const key of ["additionalProperties", "items", "if", "then", "propertyNames"]) sub(schema[key], `${where}/${key}`);
}
function check(schema: Schema, value: unknown, path: string, root: Schema, out: Issue[]): void {
  const add = (message: string, at = path) => out.push({ path: at, message });
  if (schema.$ref !== undefined) check(resolveRef(root, schema.$ref), value, path, root, out);
  if (schema.type !== undefined && !typeMatches(schema.type, value)) { add(`expected ${schema.type}`); return; }
  if (schema.const !== undefined && !same(schema.const, value)) add(`must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((option: unknown) => same(option, value))) add(`must be one of ${schema.enum.join("|")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) add(`must have at least ${schema.minLength} character(s)`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) add(`must match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) add(`must be >= ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`must have at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      value.forEach((item, i) => { const k = JSON.stringify(item); if (seen.has(k)) add("duplicate item", child(path, i)); seen.add(k); });
    }
    if (schema.items) value.forEach((item, i) => check(schema.items, item, child(path, i), root, out));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) add("required property missing", child(path, key));
    for (const [key, item] of Object.entries(object)) {
      const declared = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (declared) check(declared, item, child(path, key), root, out);
      else if (schema.additionalProperties === false) add("unknown property", child(path, key));
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") check(schema.additionalProperties, item, child(path, key), root, out);
      if (schema.propertyNames) {
        const names: Issue[] = [];
        check(schema.propertyNames, key, child(path, key), root, names);
        for (const issue of names) add(`property name ${issue.message}`, issue.path);
      }
    }
  }
  if (schema.if && schema.then && validate(schema.if, value, root).length === 0) check(schema.then, value, path, root, out);
}
export function validate(schema: Schema, value: unknown, root: Schema = schema): Issue[] {
  const issues: Issue[] = [];
  check(schema, value, "$", root, issues);
  return issues;
}
