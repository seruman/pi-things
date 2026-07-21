export type BashSandboxMode = "enabled" | "disabled-for-session"

export class BashSandboxSession {
	#mode: BashSandboxMode = "enabled"

	private constructor() {}

	static create(): BashSandboxSession {
		return new BashSandboxSession()
	}

	mode(): BashSandboxMode {
		return this.#mode
	}

	isEnabled(): boolean {
		return this.#mode === "enabled"
	}

	disableForSession(): void {
		this.#mode = "disabled-for-session"
	}

	reset(): void {
		this.#mode = "enabled"
	}
}
