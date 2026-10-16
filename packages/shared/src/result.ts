export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function must<T>(result: Result<T, Error>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export function assertNever(value: never, message = "unreachable"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
