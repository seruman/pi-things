import { expect, mock, test } from "bun:test"
import { type RexExec, resolveRexSession } from "./rex"

const location = { session_id: "session:actual", block: { block_id: "block:parent" } }

type LocationResponse = { session_id?: string | null; block?: { block_id: string } }

const ok = (value: LocationResponse) => ({ code: 0, stderr: "", stdout: JSON.stringify(value) })

test("resolves the actual session by inspecting the explicit block", async () => {
	const exec = mock<RexExec>(async () => ok(location))
	const signal = new AbortController().signal
	expect(await resolveRexSession(exec, "block:parent", signal)).toBe("session:actual")
	expect(exec).toHaveBeenCalledWith("rex", ["block", "inspect", "block:parent", "--json"], signal)
})

test.each(["", "block:", "block: ", "parent", "session:parent"])(
	"refuses an invalid block target: %s",
	async (block) => {
		const exec = mock<RexExec>(async () => ok(location))
		await expect(resolveRexSession(exec, block)).rejects.toThrow("full Rex block ID")
		expect(exec).not.toHaveBeenCalled()
	},
)

test.each([
	{},
	{ ...location, session_id: null },
	{ ...location, session_id: "session:" },
	{ ...location, session_id: "block:parent" },
	{ ...location, block: { block_id: "block:other" } },
])("refuses missing or mismatched location data: %j", async (response) => {
	await expect(resolveRexSession(async () => ok(response), "block:parent")).rejects.toThrow()
})

test("propagates lookup errors without falling back to another session", async () => {
	const exec: RexExec = async () => ({ code: 1, stderr: "block not found", stdout: "" })

	await expect(resolveRexSession(exec, "block:parent")).rejects.toThrow("block not found")

	await expect(
		resolveRexSession(async () => ({ code: 0, stderr: "", stdout: "not json" }), "block:parent"),
	).rejects.toThrow()
})

test("honors cancellation before and during lookup", async () => {
	const controller = new AbortController()

	const exec = mock<RexExec>(async () => {
		controller.abort()

		return ok(location)
	})

	await expect(resolveRexSession(exec, "block:parent", controller.signal)).rejects.toThrow()
	expect(exec).toHaveBeenCalledTimes(1)
	await expect(resolveRexSession(exec, "block:parent", controller.signal)).rejects.toThrow()
	expect(exec).toHaveBeenCalledTimes(1)
})
