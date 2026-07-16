import { describe, expect, test } from "bun:test"
import { assertFixtureExecutable } from "./test-process"

describe("shell-leash process test guard", () => {
	test("rejects executable paths outside the guarded fixture root", () => {
		expect(() => assertFixtureExecutable("/private/tmp/shell-leash-test-abc", "/usr/bin/git")).toThrow(
			"outside guarded fixture root",
		)
	})
})
