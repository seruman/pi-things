import type { ExtensionContext } from "@mariozechner/pi-coding-agent"

export type SearchProviderId = "openai" | "exa"

export type SearchSource = {
	url: string
	title?: string
}

export type SearchResult = {
	provider: SearchProviderId
	text: string
	sources: SearchSource[]
	model?: string
}

export type SearchProgressEvent =
	| {
			type: "status"
			provider: SearchProviderId
			phase: "auth" | "request" | "streaming" | "finalizing"
			message?: string
	  }
	| { type: "partial"; provider: SearchProviderId; text: string }
	| { type: "retry"; provider: SearchProviderId; attempt: number; maxRetries: number; reason?: string }

export type SearchRunInput = {
	query: string
	signal?: AbortSignal
	live?: boolean
	debug?: boolean
	onEvent?: (event: SearchProgressEvent) => void
}

export type SearchProvider = {
	id: SearchProviderId
	isAvailable(ctx: ExtensionContext): Promise<boolean>
	run(ctx: ExtensionContext, input: SearchRunInput): Promise<SearchResult>
}

export type SearchAttemptFailure = {
	provider: SearchProviderId
	error: string
}
