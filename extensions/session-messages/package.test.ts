import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

test("package loads messaging directly and includes focused verification scripts", () => {
	const manifest = z
		.object({ pi: z.object({ extensions: z.array(z.string()) }), scripts: z.record(z.string()) })
		.parse(JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")))

	expect(manifest.pi.extensions.filter((path) => path === "./extensions/session-messages/index.ts")).toHaveLength(1)
	expect(manifest.scripts["test:session-messages"]).toContain("extensions/session-messages/*.test.ts")
	expect(manifest.scripts.typecheck).toContain("typecheck:session-messages")
})
