/** What survives `JSON.stringify`. `undefined` is allowed as an object value
 * because optional fields are dropped, which deep-equality treats as absent.
 * `null` is only here to model JSON; projected state never produces it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue | undefined };

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.values(value).every(
        (v) => v === undefined || isJsonValue(v),
      );
    default:
      return false;
  }
}
