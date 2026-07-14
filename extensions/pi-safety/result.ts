export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error }
}

export function unwrap<T, E>(result: Result<T, E>): T {
	if (result.ok) return result.value
	throw new Error(`called unwrap on an error result: ${JSON.stringify(result.error)}`)
}
