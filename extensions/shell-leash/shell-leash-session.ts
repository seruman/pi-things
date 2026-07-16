import type { RemoteEffect } from "./effects"
import type { EffectFinding } from "./findings"
import {
	type InvocationPermit,
	type RemoteDecision,
	type RemoteTargetScope,
	type RequestLease,
	createInvocationPermit,
	createRequestLease,
	decideRemoteEffects,
} from "./grants"

export class ShellLeashSession {
	#requestId: string | undefined
	#permits: InvocationPermit[] = []
	#leases: RequestLease[] = []

	beginRequest(requestId: string): void {
		this.#requestId = requestId
		this.#permits = []
		this.#leases = []
	}

	review(toolCallId: string, findings: readonly EffectFinding[]): RemoteDecision {
		return decideRemoteEffects({
			toolCallId,
			requestId: this.#requestId ?? "",
			findings,
			permits: this.#permits,
			leases: this.#leases,
		})
	}

	allowOnce(toolCallId: string, findings: readonly EffectFinding[]): void {
		this.#permits.push(
			createInvocationPermit(
				toolCallId,
				findings.map((finding) => finding.effect),
			),
		)
	}

	allowForRequest(operation: RemoteEffect["operation"], target: RemoteTargetScope): void {
		if (!this.#requestId) throw new Error("shell-leash request has not started")
		this.#leases.push(createRequestLease(this.#requestId, operation, target))
	}

	finishToolCall(toolCallId: string): void {
		this.#permits = this.#permits.filter((permit) => permit.toolCallId !== toolCallId)
	}

	currentRequestId(): string | undefined {
		return this.#requestId
	}

	activeRequestLeases(): readonly RequestLease[] {
		return [...this.#leases]
	}

	clearRequestLeases(): void {
		this.#leases = []
	}

	authorizationSnapshot(toolCallId: string): {
		readonly requestId: string
		readonly permit: InvocationPermit
		readonly leases: readonly RequestLease[]
	} {
		if (!this.#requestId) throw new Error("shell-leash request has not started")
		return {
			requestId: this.#requestId,
			permit:
				this.#permits.find((permit) => permit.toolCallId === toolCallId) ?? createInvocationPermit(toolCallId, []),
			leases: [...this.#leases],
		}
	}

	activeEffects(toolCallId: string): readonly RemoteEffect[] {
		return this.#permits.find((permit) => permit.toolCallId === toolCallId)?.effects ?? []
	}
}
