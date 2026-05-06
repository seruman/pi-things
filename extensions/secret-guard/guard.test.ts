import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, test } from "node:test"
import { loadSecretGuardConfig, matchProtectedRead } from "./guard"

const roots: string[] = []

function tempRoot() {
	const root = join(tmpdir(), `secret-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`)
	mkdirSync(root, { recursive: true })
	roots.push(root)
	return root
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("secret-guard", () => {
	test("protects default dotenv files", () => {
		const root = tempRoot()
		const config = loadSecretGuardConfig(root)

		assert.equal(matchProtectedRead(config, ".env").blocked, true)
		assert.equal(matchProtectedRead(config, ".env.local").blocked, true)
		assert.equal(matchProtectedRead(config, ".env.example").blocked, false)
	})

	test("loads project protection file with negation", () => {
		const root = tempRoot()
		mkdirSync(join(root, ".pi"), { recursive: true })
		writeFileSync(join(root, ".pi", "secret-guard.protect"), "config/*.json\n!config/example.json\n")

		const config = loadSecretGuardConfig(root)

		assert.equal(matchProtectedRead(config, "config/production.json").blocked, true)
		assert.equal(matchProtectedRead(config, "config/example.json").blocked, false)
	})

	test("uses nearest parent protect file as the project root", () => {
		const root = tempRoot()
		const nested = join(root, "packages", "app")
		mkdirSync(join(root, ".pi"), { recursive: true })
		mkdirSync(nested, { recursive: true })
		writeFileSync(join(root, ".pi", "secret-guard.protect"), "config/*.toml\n")

		const config = loadSecretGuardConfig(nested)

		assert.equal(config.projectRoot, root)
		assert.equal(matchProtectedRead(config, join(root, "config/app.toml")).blocked, true)
	})

	test("does not treat unrelated parent .pi directories as project config", () => {
		const root = tempRoot()
		const nested = join(root, "packages", "app")
		mkdirSync(join(root, ".pi"), { recursive: true })
		mkdirSync(nested, { recursive: true })

		const config = loadSecretGuardConfig(nested)

		assert.equal(config.projectRoot, nested)
		assert.equal(
			config.protectFiles.some((file) => file.startsWith(root)),
			false,
		)
	})

	test("protects default patterns outside the current working directory", () => {
		const root = tempRoot()
		const nested = join(root, "packages", "app")
		mkdirSync(nested, { recursive: true })

		const config = loadSecretGuardConfig(nested)

		assert.equal(matchProtectedRead(config, join(root, ".env")).blocked, true)
	})

	test("project negation does not unprotect default rules", () => {
		const root = tempRoot()
		mkdirSync(join(root, ".pi"), { recursive: true })
		writeFileSync(join(root, ".pi", "secret-guard.protect"), "!.env\n")

		const config = loadSecretGuardConfig(root)

		assert.equal(matchProtectedRead(config, ".env").blocked, true)
	})

	test("deduplicates matching patterns across rule sets", () => {
		const root = tempRoot()
		mkdirSync(join(root, ".pi"), { recursive: true })
		writeFileSync(join(root, ".pi", "secret-guard.protect"), ".env.*\n")

		const config = loadSecretGuardConfig(root)
		const match = matchProtectedRead(config, ".env.local")

		assert.deepEqual(match.matchedBy, [".env.*"])
	})
})
