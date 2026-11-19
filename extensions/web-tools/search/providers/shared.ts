import type { JsonValue } from "@earendil-works/pi-ai"

export function isRetryableStatus(status: number): boolean {
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

export function isRetryableNetworkError(error: Error): boolean {
	const msg = error.message.toLowerCase()

	return (
		msg.includes("fetch failed") ||
		msg.includes("network") ||
		msg.includes("timeout") ||
		msg.includes("timed out") ||
		msg.includes("connection")
	)
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"))

			return
		}

		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)

		const onAbort = () => {
			clearTimeout(timer)
			reject(new Error("aborted"))
		}

		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

export function parseJson(value: string): JsonValue {
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

export async function withExponentialRetries<T>(options: {
	maxRetries: number
	baseDelayMs: number
	signal?: AbortSignal
	run: (attempt: number) => Promise<T>
	shouldRetry: (error: Error) => boolean
	onRetry?: (attempt: number, maxRetries: number, reason?: string) => void
}): Promise<T> {
	let lastError: Error | null = null

	for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
		try {
			return await options.run(attempt)
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error))

			if (err.message === "aborted" || err.name === "AbortError") throw err
			lastError = err

			if (attempt >= options.maxRetries || !options.shouldRetry(err)) {
				throw err
			}

			const retryAttempt = attempt + 1
			options.onRetry?.(retryAttempt, options.maxRetries, err.message)
			await sleep(options.baseDelayMs * 2 ** attempt, options.signal)
		}
	}

	throw lastError || new Error("request failed after retries")
}
