import type { TSchema } from "@earendil-works/pi-ai"
import type { EventBus } from "@earendil-works/pi-coding-agent"
import { Check } from "typebox/value"
import { z } from "zod"
import type { PeerMessage } from "./registry"
import {
	type ListResult,
	type SendParameters,
	type SendResult,
	type SpawnParameters,
	type SpawnResult,
	listParameters,
	sendParameters,
	spawnParameters,
} from "./schemas"

export const channels = {
	spawn: "peers:spawn",
	send: "peers:send",
	list: "peers:list",
	message: "peers:message",
} as const

export interface PeerOperations {
	list(): ListResult
	send(params: SendParameters): SendResult
	spawn(params: SpawnParameters): Promise<SpawnResult>
}

type Response<Result> = { result: Result } | { error: string }

const requestSchema = z.object({
	params: z.unknown(),
	reply: z.function().args(z.unknown()).returns(z.void()),
	// Called synchronously on receipt, so callers can tell a slow reply from a missing listener.
	accepted: z.function().returns(z.void()).optional(),
})

function serve<Params, Result>(
	events: EventBus,
	channel: string,
	schema: TSchema,
	run: (params: Params) => Result | Promise<Result>,
): void {
	events.on(channel, async (data) => {
		const { params, reply, accepted } = requestSchema.parse(data)
		accepted?.()

		// EventBus only logs listener exceptions, so every failure goes back to the caller.
		try {
			if (!Check(schema, params)) throw new Error(`Invalid ${channel} parameters`)
			// SAFETY: Check just validated params against the schema this channel serves.
			reply({ result: await run(params as Params) } satisfies Response<Result>)
		} catch (error) {
			reply({ error: error instanceof Error ? error.message : String(error) } satisfies Response<Result>)
		}
	})
}

/** Same-process API for other extensions. Requests carry `{ params, reply }`; replies are `{ result } | { error }`. */
export function registerPeersApi(events: EventBus, operations: PeerOperations): void {
	serve(events, channels.list, listParameters, () => operations.list())
	serve(events, channels.send, sendParameters, (params: SendParameters) => operations.send(params))
	serve(events, channels.spawn, spawnParameters, (params: SpawnParameters) => operations.spawn(params))
}

interface Requests {
	"peers:list": { params: Record<string, never>; result: ListResult }
	"peers:send": { params: SendParameters; result: SendResult }
	"peers:spawn": { params: SpawnParameters; result: SpawnResult }
}

/** Caller side of registerPeersApi, for extensions in this repo and for tests. */
export function requestPeers<Channel extends keyof Requests>(
	events: EventBus,
	channel: Channel,
	params: Requests[Channel]["params"],
): Promise<Requests[Channel]["result"]> {
	return new Promise((resolve, reject) => {
		let accepted = false
		events.emit(channel, {
			params,
			reply: (response: Response<Requests[Channel]["result"]>) => {
				if ("error" in response) reject(new Error(response.error))
				else resolve(response.result)
			},
			accepted: () => {
				accepted = true
			},
		})

		if (!accepted) reject(new Error("peers is not installed in this session"))
	})
}

export interface MessageEvent {
	message: PeerMessage
	/** Call synchronously from the listener to take the message away from the model. */
	claim(): void
}

/** Offers a message to other extensions. True when one of them claimed it. */
export function offerMessage(events: EventBus, peerMessage: PeerMessage): boolean {
	let claimed = false
	events.emit(channels.message, {
		message: peerMessage,
		claim: () => {
			claimed = true
		},
	} satisfies MessageEvent)

	return claimed
}
