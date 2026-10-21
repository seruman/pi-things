import { type Static, StringEnum, Type } from "@earendil-works/pi-ai"

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

const peerInfoSchema = Type.Object({
	peerId: Type.String(),
	label: Type.Optional(Type.String()),
	namespace: Type.Optional(Type.String()),
	state: StringEnum(["idle", "busy"] as const),
	cwd: Type.String(),
	rex: Type.Union([Type.Object({ sessionId: Type.String(), blockId: Type.String() }), Type.Null()]),
})

export type PeerInfo = Static<typeof peerInfoSchema>

export const listParameters = Type.Object({})

export const listResultSchema = Type.Object({ self: peerInfoSchema, peers: Type.Array(peerInfoSchema) })

export type ListResult = Static<typeof listResultSchema>

export const sendParameters = Type.Object({
	to: Type.String({ minLength: 1, description: "Peer id, unique label, or the peer's Rex block id." }),
	text: Type.String({ minLength: 1 }),
	kind: StringEnum(["request", "note"] as const, {
		description: "request wakes the target and asks it to act. note never starts a turn.",
	}),
	steer: Type.Optional(
		Type.Boolean({ description: "Requests only: interrupt a busy target instead of queueing after its turn." }),
	),
	replyTo: Type.Optional(Type.String({ description: "Id of the message this answers." })),
})

export type SendParameters = Static<typeof sendParameters>

export const sendResultSchema = Type.Object({ messageId: Type.String(), to: Type.String() })

export type SendResult = Static<typeof sendResultSchema>

const nullableName = (description: string) => Type.Optional(Type.Union([Type.String(), Type.Null()], { description }))

export const spawnParameters = Type.Object({
	prompt: Type.String({ minLength: 1, description: "First message, delivered to the new peer as a request." }),
	label: Type.Optional(Type.String({ description: "Display name, 1 to 64 characters on one line." })),
	namespace: nullableName(
		"Defaults to this session's namespace. null puts the new peer in the open pool. A peer in another namespace cannot answer you.",
	),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String({ description: 'Model pattern, e.g. "provider/id". Defaults to pi\'s default.' })),
	thinkingLevel: Type.Optional(StringEnum(thinkingLevels)),
	placement: Type.Optional(
		Type.Object({
			rexSession: Type.Optional(Type.String({ description: "Rex session id. Defaults to this session's." })),
			window: Type.Optional(
				Type.String({ description: '"new" (default) for a new unfocused window, or a window id to split.' }),
			),
			splitBeside: Type.Optional(Type.String({ description: "Block id to split beside, instead of a window." })),
		}),
	),
})

export type SpawnParameters = Static<typeof spawnParameters>

export const spawnResultSchema = Type.Object({
	peerId: Type.String(),
	blockId: Type.String(),
	windowId: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
	namespace: Type.Optional(Type.String()),
})

export type SpawnResult = Static<typeof spawnResultSchema>

export const setParameters = Type.Object({
	label: nullableName("New label. null clears it, falling back to the session name."),
	namespace: nullableName("New namespace. null moves this session to the open pool."),
})

export type SetParameters = Static<typeof setParameters>

export const setResultSchema = Type.Object({
	peerId: Type.String(),
	label: Type.Optional(Type.String()),
	namespace: Type.Optional(Type.String()),
})

export type SetResult = Static<typeof setResultSchema>
