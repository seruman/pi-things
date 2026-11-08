import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { messageSchema } from "../lib/session-delivery/mailbox"
import { testDirectory } from "../session-messages/fixtures/sdk"
import { completionSchema } from "./completion"
import { readMetadata, readRunIdentity } from "./runs"

const relation = "123e4567-e89b-42d3-a456-426614174000"

const other = "123e4567-e89b-42d3-a456-426614174001"

test("legacy short IDs and synthetic completion addresses round-trip without normalization", () => {
	const message = {
		version: 2,
		route: { kind: "completion", relation, handle: "h", sequence: 1 },
		id: relation,
		from: { sessionId: "c", instanceId: other },
		to: { sessionId: "p", instanceId: other },
		text: "done",
		delivery: "followUp",
		createdAt: 0,
	}

	const parsed = messageSchema.parse(message)
	expect(JSON.stringify(parsed)).toBe(JSON.stringify(message))
	expect(Object.isFrozen(parsed.route)).toBe(true)
	expect(
		completionSchema.parse({
			relation,
			handle: "h",
			parentSessionId: "p",
			childSessionId: "c",
			sequence: 1,
			outcome: "success",
			sessionFile: "f",
			response: { kind: "none" },
		}),
	).toMatchObject({ handle: "h", parentSessionId: "p", childSessionId: "c" })
})

test("persisted identity and legacy metadata keep their distinct acceptance rules", () => {
	const root = testDirectory()
	const identityPath = join(root, "identity.json")
	const metadataPath = join(root, "metadata.json")
	writeFileSync(identityPath, JSON.stringify({ handle: "h", relation, parentSessionId: "p" }))
	expect(readRunIdentity(root)).toMatchObject({ handle: "h", relation, parentSessionId: "p" })
	writeFileSync(identityPath, JSON.stringify({ handle: "h-unsafe", relation, parentSessionId: "p" }))
	expect(readRunIdentity(root)).toBeUndefined()

	const metadata = {
		version: 1,
		handle: "",
		parentSessionId: "",
		blockId: "",
		sessionFile: "",
		cwd: "",
		provider: "",
		model: "",
		thinking: "off",
		launchArgs: [],
		createdAt: "",
	}

	writeFileSync(metadataPath, JSON.stringify(metadata))
	expect(readMetadata(root)).toMatchObject(metadata)
})
