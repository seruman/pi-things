import { type Result, err } from "./result"
import type { PublishedSnapshotRef, SnapshotError } from "./snapshot"

export type CheckpointError =
	| { readonly kind: "snapshot-failed"; readonly cause: SnapshotError }
	| { readonly kind: "creator-rejected"; readonly message: string }

export type CheckpointStatus =
	| { readonly kind: "not-started" }
	| { readonly kind: "creating" }
	| { readonly kind: "ready"; readonly snapshot: PublishedSnapshotRef }
	| { readonly kind: "failed"; readonly error: CheckpointError }

type CheckpointState =
	| { readonly kind: "not-started" }
	| { readonly kind: "creating"; readonly promise: Promise<Result<PublishedSnapshotRef, CheckpointError>> }
	| { readonly kind: "ready"; readonly snapshot: PublishedSnapshotRef }
	| { readonly kind: "failed"; readonly error: CheckpointError }

type SnapshotCreator = () => Promise<Result<PublishedSnapshotRef, SnapshotError>>

export interface CheckpointRun {
	status(): CheckpointStatus
	ensureCheckpoint(): Promise<Result<PublishedSnapshotRef, CheckpointError>>
}

class ManagedCheckpointRun implements CheckpointRun {
	readonly #createSnapshot: SnapshotCreator
	#state: CheckpointState = { kind: "not-started" }

	constructor(createSnapshot: SnapshotCreator) {
		this.#createSnapshot = createSnapshot
	}

	status(): CheckpointStatus {
		switch (this.#state.kind) {
			case "not-started":
				return { kind: "not-started" }
			case "creating":
				return { kind: "creating" }
			case "ready":
				return { kind: "ready", snapshot: this.#state.snapshot }
			case "failed":
				return { kind: "failed", error: this.#state.error }
		}
	}

	ensureCheckpoint(): Promise<Result<PublishedSnapshotRef, CheckpointError>> {
		switch (this.#state.kind) {
			case "creating":
				return this.#state.promise
			case "ready":
				return Promise.resolve({ ok: true, value: this.#state.snapshot })
			case "failed":
				return Promise.resolve(err(this.#state.error))
			case "not-started": {
				const promise = Promise.resolve()
					.then(() => this.#createSnapshot())
					.then(
						(result): Result<PublishedSnapshotRef, CheckpointError> =>
							result.ok ? result : err({ kind: "snapshot-failed", cause: result.error }),
						(cause: unknown): Result<PublishedSnapshotRef, CheckpointError> =>
							err({
								kind: "creator-rejected",
								message: cause instanceof Error ? cause.message : String(cause),
							}),
					)
					.then((result) => {
						this.#state = result.ok
							? { kind: "ready", snapshot: result.value }
							: { kind: "failed", error: result.error }
						return result
					})
				this.#state = { kind: "creating", promise }
				return promise
			}
		}
	}
}

export function createCheckpointRun(createSnapshot: SnapshotCreator): CheckpointRun {
	return new ManagedCheckpointRun(createSnapshot)
}
