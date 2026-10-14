import { expect, test } from "bun:test"
import { createEventBus } from "@earendil-works/pi-coding-agent"
import { getChildPolicyArgs } from "./child-policy"
import { policyFlags, shellLeashHost } from "./test-host"

test("default parent asks; allow once does not change its child policy", async () => {
	const parent = shellLeashHost()
	parent.start()
	parent.choices.push("Allow once")
	expect(await parent.bash("rm -rf rs")).toBeUndefined()
	expect(parent.prompts).toHaveLength(1)
	expect(parent.signal.aborted).toBe(false)
	const args = getChildPolicyArgs(parent.events)
	expect(args).toContain("--extension")
	const child = shellLeashHost(policyFlags(args))
	child.start()
	expect(await child.bash("rm -rf rs")).toMatchObject({ block: true })
	expect(child.prompts).toHaveLength(0)
	expect(child.signal.aborted).toBe(true)
})

test("children inherit flag and session allows, explicit denies, and ask becomes deny", async () => {
	const parent = shellLeashHost({
		"shell-leash-allow": "git.switch,git.push",
		"shell-leash-deny": "git.push",
	})

	parent.start()
	parent.choices.push("Allow fs.rm for session")
	await parent.bash("rm -rf rs")
	const child = shellLeashHost(policyFlags(getChildPolicyArgs(parent.events)))
	child.start()

	expect(await child.bash("rm -rf rs && git switch topic")).toBeUndefined()
	expect(await child.bash("git push")).toMatchObject({ block: true })
	expect(await child.bash("git checkout main")).toMatchObject({ block: true })
	expect(await child.bash("git status && gh api repos/owner/repo")).toBeUndefined()
	expect(child.prompts).toHaveLength(0)

	// Resetting parent approvals affects later children, not an already spawned snapshot.
	parent.start()
	const next = shellLeashHost(policyFlags(getChildPolicyArgs(parent.events)))
	expect(await next.bash("rm -rf rs")).toMatchObject({ block: true })
	expect(await child.bash("rm -rf rs")).toBeUndefined()
})

test("deny takes precedence over allow, without prompting for other hits", async () => {
	const host = shellLeashHost({ "shell-leash-allow": "fs.rm", "shell-leash-deny": "fs.rm" })
	expect(await host.bash("git checkout main && rm -rf rs")).toMatchObject({ block: true })
	expect(host.prompts).toHaveLength(0)
	expect(host.signal.aborted).toBe(true)
})

test("default deny permits explicit allows and ordinary commands", async () => {
	const host = shellLeashHost({ "shell-leash-default": "deny", "shell-leash-allow": " git.switch , git.checkout " })
	expect(await host.bash("git switch topic && git checkout main")).toBeUndefined()
	expect(await host.bash("git push")).toMatchObject({ block: true })
	expect(await host.bash("git status")).toBeUndefined()
	expect(host.prompts).toHaveLength(0)
})

test.each(["Deny", undefined])("denying or dismissing an ask does not approve future calls: %s", async (choice) => {
	const host = shellLeashHost()
	host.choices.push(choice, choice)
	expect(await host.bash("rm -rf rs")).toMatchObject({ block: true })
	expect(await host.bash("rm -rf rs")).toMatchObject({ block: true })
	expect(host.prompts).toHaveLength(2)
	expect(host.signal.aborted).toBe(true)
	expect(host.notifications[0]).toContain("current run has been stopped")
})

test.each([
	["shell-leash-default", "allow"],
	["shell-leash-allow", "fs.rmm"],
	["shell-leash-deny", "fs.rm,"],
	["shell-leash-allow", "git.*"],
])("invalid policy cannot silently permit tools or child spawns: %s=%s", async (flag, value) => {
	const host = shellLeashHost({ [flag]: value })
	expect(() => host.start()).toThrow()
	expect(await host.bash("rm -rf rs")).toMatchObject({ block: true })
	expect(host.signal.aborted).toBe(true)
	expect(() => getChildPolicyArgs(host.events)).toThrow()
})

test("headless sessions enforce policy and deny asks rather than silently allowing", async () => {
	const host = shellLeashHost({ "shell-leash-allow": "git.switch", "shell-leash-deny": "git.push" })
	host.ctx.hasUI = false
	host.ctx.mode = "print"
	expect(await host.bash("git switch topic")).toBeUndefined()
	expect(await host.bash("git push")).toMatchObject({ block: true })
	expect(await host.bash("rm -rf rs")).toMatchObject({ block: true })
	expect(host.prompts).toHaveLength(0)
	expect(host.signal.aborted).toBe(true)
})

const denialCases: { name: string; flags: Record<string, string>; hasUI: boolean; choice?: string }[] = [
	{ name: "explicit deny", flags: { "shell-leash-deny": "fs.rm" }, hasUI: true, choice: "Allow once" },
	{ name: "default deny", flags: { "shell-leash-default": "deny" }, hasUI: true, choice: "Allow once" },
	{ name: "headless ask", flags: {}, hasUI: false, choice: "Allow once" },
	{ name: "user deny", flags: {}, hasUI: true, choice: "Deny" },
	{ name: "dismissed prompt", flags: {}, hasUI: true, choice: undefined },
]

test.each(denialCases)("each denial aborts a fresh run: $name", async ({ flags, hasUI, choice }) => {
	const host = shellLeashHost(flags)
	host.ctx.hasUI = hasUI
	host.choices.push(choice)
	expect(host.signal.aborted).toBe(false)
	expect(await host.bash("rm -f")).toMatchObject({ block: true })
	expect(host.signal.aborted).toBe(true)
})

test("approval UI failures stop the run rather than leaving a recoverable tool error", async () => {
	const host = shellLeashHost()
	// No queued choice makes the fake UI throw.
	expect(await host.bash("rm -f")).toMatchObject({
		block: true,
		reason: expect.stringContaining("Unexpected approval prompt"),
	})
	expect(host.signal.aborted).toBe(true)
})

test("allowed and unguarded commands do not stop the run", async () => {
	const host = shellLeashHost({ "shell-leash-allow": "fs.rm" })
	expect(await host.bash("rm -f")).toBeUndefined()
	expect(await host.bash("git status")).toBeUndefined()
	expect(host.signal.aborted).toBe(false)
})

test("without shell-leash installed, the parent adds no shell-leash flags", () => {
	expect(getChildPolicyArgs(createEventBus())).toEqual([])
})

test("only bash calls are guarded", async () => {
	const host = shellLeashHost({ "shell-leash-default": "deny" })
	expect(
		await host.tool({ type: "tool_call", toolCallId: "read", toolName: "read", input: { path: "README.md" } }),
	).toBeUndefined()
	expect(host.signal.aborted).toBe(false)
})
