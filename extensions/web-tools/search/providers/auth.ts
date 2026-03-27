import type { ExtensionContext } from "@mariozechner/pi-coding-agent"

export type ModelAuthResult = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>

export type ResolvedModelAuth = {
	apiKey?: string
	headers: Record<string, string>
}

export async function getModelAuth(
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
): Promise<ModelAuthResult> {
	const model = ctx.modelRegistry.find(provider, modelId)
	if (!model) return { ok: false, error: `model not found: ${provider}/${modelId}` }
	return ctx.modelRegistry.getApiKeyAndHeaders(model)
}

export function normalizeModelAuth(auth: { apiKey?: string; headers?: Record<string, string> }): ResolvedModelAuth {
	return {
		apiKey: auth.apiKey,
		headers: { ...(auth.headers ?? {}) },
	}
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
	const needle = name.toLowerCase()
	return Object.keys(headers).some((key) => key.toLowerCase() === needle)
}

export function setHeaderIfMissing(headers: Record<string, string>, name: string, value: string) {
	if (!hasHeader(headers, name)) headers[name] = value
}

export function hasUsableAuth(auth: ResolvedModelAuth): boolean {
	return Boolean(auth.apiKey?.trim()) || hasHeader(auth.headers, "authorization")
}
