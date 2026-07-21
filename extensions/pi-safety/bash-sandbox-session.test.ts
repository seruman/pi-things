import { describe, expect, test } from "bun:test"
import { BashSandboxSession } from "./bash-sandbox-session"

describe("BashSandboxSession", () => {
	test("starts enabled and remains disabled until the session resets", () => {
		const session = BashSandboxSession.create()

		expect(session.mode()).toBe("enabled")
		expect(session.isEnabled()).toBe(true)

		session.disableForSession()
		expect(session.mode()).toBe("disabled-for-session")
		expect(session.isEnabled()).toBe(false)

		session.reset()
		expect(session.mode()).toBe("enabled")
		expect(session.isEnabled()).toBe(true)
	})
})
