import { expect, test } from "bun:test"
import { createRexClient } from "./client"

test("the Rex client passes an explicit session and reports failures", async () => {
	const calls: string[][] = []

	const client = createRexClient(async (command, args) => {
		calls.push([command, ...args])

		if (args[4] === "block.close") return { code: 1, stdout: "", stderr: "Error: block not found\n" }

		if (args[4] === "session.new_window") {
			return { code: 0, stderr: "", stdout: JSON.stringify({ window_id: null, block_ids: [], revision: 1 }) }
		}

		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify({ blocks: [{ block_id: "block:1", label: "a", placement: "placed" }] }),
		}
	})

	expect(await client.listBlocks("session:s")).toEqual([{ block_id: "block:1", label: "a", placement: "placed" }])
	expect(calls[0]).toEqual(["rex", "api", "call", "-s", "session:s", "session.list_blocks", "{}"])
	await expect(client.closeBlock("session:s", "block:1")).rejects.toThrow("Error: block not found")
	await expect(client.newWindow("session:s", { cwd: "/", command: ["true"] })).rejects.toThrow(
		"session.new_window did not return a window id",
	)
	await expect(client.call("", "session.list_blocks", {})).rejects.toThrow("a Rex session id is required")
})
