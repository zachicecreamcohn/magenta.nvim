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
