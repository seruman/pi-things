import { afterEach, beforeEach, expect, test } from "bun:test"
import { z } from "zod"
import { type Exec, newBlock, showBlock } from "./rex"

const requestSchema = z
	.object({
		session_id: z.string(),
		window_id: z.string().optional(),
		block_id: z.string().optional(),
		layer_id: z.string().optional(),
		state: z.enum(["normal", "minimized"]).optional(),
		focus: z.boolean().optional(),
		bounds: z.array(z.number()).optional(),
		layout: z
			.object({
				block: z.object({
					flavor: z.string(),
					label: z.string(),
					options: z.object({ cwd: z.string(), command: z.array(z.string()) }),
				}),
			})
			.optional(),
	})
	.strict()

let savedSession: string | undefined

let savedBlock: string | undefined

let calls: { method: string; args: z.infer<typeof requestSchema>; signal?: AbortSignal }[]

let failMinimize: boolean

let failClose: boolean

let onCreate: (() => void) | undefined

let windows: {
	window_id: string
	layers: { layer_id: string; kind: string; blocks: { block_id: string }[] }[]
}[]

const exec: Exec = async (_command, argv, signal) => {
	if (argv[0] === "block" && argv[1] === "inspect") {
		expect(argv).toEqual(["block", "inspect", "block:parent", "--json"])

		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify({ session_id: "session:parent", block: { block_id: "block:parent" } }),
		}
	}

	expect(argv[3]).toBe("session:parent")
	const method = argv[4]!
	const args = requestSchema.parse(JSON.parse(argv[5]!))
	calls.push({ method, args, signal })
	signal?.throwIfAborted()

	const response = () => {
		switch (method) {
			case "session.view":
				return { active_window_id: "window:other", windows }
			case "session.new_layer":
				onCreate?.()

				return { layer_id: "layer:child", block_ids: ["block:child"], revision: 1 }
			case "session.set_layer_state":
				if (failMinimize) throw new Error("minimize failed")

				return { revision: 2 }
			case "session.focus_block":
				return { revision: 3 }
			case "block.close":
				if (failClose) throw new Error("close failed")

				return { block_id: args.block_id, revision: 3 }
			default:
				throw new Error(`Unexpected Rex operation: ${method}`)
		}
	}

	return { code: 0, stderr: "", stdout: JSON.stringify(response()) }
}

beforeEach(() => {
	savedSession = process.env.REX_SESSION
	savedBlock = process.env.REX_BLOCK
	Reflect.deleteProperty(process.env, "REX_SESSION")
	process.env.REX_BLOCK = "block:parent"
	calls = []
	failMinimize = false
	failClose = false
	onCreate = undefined
	windows = [
		{
			window_id: "window:parent",
			layers: [
				{ layer_id: "layer:parent", kind: "tiled", blocks: [{ block_id: "block:parent" }] },
				{ layer_id: "layer:child", kind: "floating", blocks: [{ block_id: "block:child" }] },
			],
		},
	]
})

afterEach(() => {
	if (savedSession === undefined) Reflect.deleteProperty(process.env, "REX_SESSION")
	else process.env.REX_SESSION = savedSession

	if (savedBlock === undefined) Reflect.deleteProperty(process.env, "REX_BLOCK")
	else process.env.REX_BLOCK = savedBlock
})

test.each([undefined, "session:stale"])(
	"creates in the resolved session without focus, then minimizes (REX_SESSION: %s)",
	async (legacySession) => {
		if (legacySession) process.env.REX_SESSION = legacySession
		expect(await newBlock(exec, "/project", "abc123", ["pi", "prompt"])).toBe("block:child")
		expect(calls.map(({ method }) => method)).toEqual(["session.view", "session.new_layer", "session.set_layer_state"])
		expect(calls[1]?.args).toEqual({
			session_id: "session:parent",
			window_id: "window:parent",
			bounds: [0.1, 0.1, 0.8, 0.8],
			focus: false,
			layout: {
				block: {
					flavor: "com.superlogical.terminal.shell",
					label: "subagent abc123",
					options: { cwd: "/project", command: ["pi", "prompt"] },
				},
			},
		})
		expect(calls[2]?.args).toEqual({
			session_id: "session:parent",
			layer_id: "layer:child",
			state: "minimized",
		})
	},
)

test.each(["missing env", "unplaced block"])("does not fall back to the active window: %s", async (reason) => {
	if (reason === "missing env") Reflect.deleteProperty(process.env, "REX_BLOCK")
	else windows = []
	await expect(newBlock(exec, "/project", "abc123", ["pi"])).rejects.toThrow()
	expect(calls.some(({ method }) => method === "session.new_layer")).toBe(false)
})

test("restores the current floating layer and focuses the specific child without moving it", async () => {
	windows[0]!.layers[1]!.layer_id = "layer:moved"
	await showBlock(exec, "block:child")
	expect(calls.map(({ method }) => method)).toEqual(["session.view", "session.set_layer_state", "session.focus_block"])
	expect(calls[1]?.args).toMatchObject({ layer_id: "layer:moved", state: "normal", focus: true })
	expect(calls[2]?.args).toMatchObject({ block_id: "block:child" })
})

test("respects a child manually docked into the tiled layout", async () => {
	windows[0]!.layers[1]!.kind = "tiled"
	await showBlock(exec, "block:child")
	expect(calls.map(({ method }) => method)).toEqual(["session.view", "session.focus_block"])
})

test.each([false, true])("closes the created terminal if minimizing fails (cancelled: %s)", async (cancelled) => {
	const controller = new AbortController()

	if (cancelled) onCreate = () => controller.abort()
	else failMinimize = true
	await expect(newBlock(exec, "/project", "abc123", ["pi"], controller.signal)).rejects.toThrow()
	expect(calls.at(-1)).toEqual({
		method: "block.close",
		args: { session_id: "session:parent", block_id: "block:child" },
		signal: undefined,
	})
})

test("identifies the child when both minimizing and cleanup fail", async () => {
	failMinimize = true
	failClose = true
	await expect(newBlock(exec, "/project", "abc123", ["pi"])).rejects.toThrow("block:child")
})
