import type { EventBus } from "@earendil-works/pi-coding-agent"
import { z } from "zod"

const channel = "shell-leash:child-policy"

const responseSchema = z.union([z.object({ args: z.array(z.string()) }), z.object({ error: z.string() })])

const requestSchema = z.object({ reply: z.function().args(responseSchema).returns(z.void()) })

/** Same-process extension exchange, not a model-callable permission API. Replies are synchronous. */
export function registerChildPolicy(events: EventBus, getArgs: () => string[]): void {
	events.on(channel, (data) => {
		const { reply } = requestSchema.parse(data)

		try {
			reply({ args: getArgs() })
		} catch (error) {
			// EventBus logs listener exceptions; return policy failures so spawn cannot silently ignore them.
			reply({ error: error instanceof Error ? error.message : String(error) })
		}
	})
}

interface PolicyReply {
	response?: z.infer<typeof responseSchema>
}

export function getChildPolicyArgs(events: EventBus): string[] {
	const result: PolicyReply = {}
	events.emit(channel, {
		reply: (value: z.infer<typeof responseSchema>) => {
			result.response = value
		},
	})

	// No listener means shell-leash is not installed in this parent.
	if (!result.response) return []

	if ("error" in result.response) throw new Error(result.response.error)

	return result.response.args
}
