import { type SessionEntry, VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import { ROUTER_PROVIDER, persistedStateSchema } from "./router"

export const MODE_ENTRY = "model-router.mode"

export const STATE_ENTRY = "model-router.state"

const modeSchema = z.discriminatedUnion("enabled", [
	z.object({ version: z.literal(1), enabled: z.literal(true), preset: z.string().min(1) }),
	z.object({ version: z.literal(1), enabled: z.literal(false), preset: z.string().min(1).optional() }),
])

const savedStateSchema = z.object({ version: z.literal(1), preset: z.string(), state: persistedStateSchema })

const legacyStateSchema = z.object({
	provider: z.literal(ROUTER_PROVIDER),
	modelId: z.string().startsWith("auto-"),
	state: persistedStateSchema,
})

export type RouterMode = z.infer<typeof modeSchema>

/** Only current ancestry counts, including states for inactive presets on this branch. */
export function readRoutingBranch(branch: readonly SessionEntry[]) {
	let mode: RouterMode | undefined
	let legacyPreset: string | undefined
	const states = new Map<string, z.infer<typeof persistedStateSchema>>()

	for (const entry of branch) {
		if (entry.type === "model_change") {
			legacyPreset =
				entry.provider === ROUTER_PROVIDER && entry.modelId.startsWith("auto-") ? entry.modelId.slice(5) : undefined
		}

		if (entry.type !== "custom") continue

		if (entry.customType === MODE_ENTRY) {
			const parsed = modeSchema.safeParse(entry.data)

			if (parsed.success) mode = parsed.data
		} else if (entry.customType === STATE_ENTRY) {
			const parsed = savedStateSchema.safeParse(entry.data)

			if (parsed.success) states.set(parsed.data.preset, parsed.data.state)
		} else if (entry.customType === VIRTUAL_MODEL_STATE_ENTRY) {
			const parsed = legacyStateSchema.safeParse(entry.data)

			if (parsed.success) states.set(parsed.data.modelId.slice(5), parsed.data.state)
		}
	}

	return {
		mode: mode ?? (legacyPreset ? { version: 1, enabled: true, preset: legacyPreset } : { version: 1, enabled: false }),
		states,
	} satisfies { mode: RouterMode; states: typeof states }
}
