import { expect, test } from "bun:test"
import { parseShell } from "./shell-parser"

test("ShellParser preserves literal prefixes, suffixes, and ordered dynamic word parts", async () => {
	const parsed = await parseShell('printf "%s\\n" "query=mutation Close($id)-tail"')
	expect(parsed.ok).toBe(true)
	if (!parsed.ok) return
	const word = parsed.value.commands[0]?.words[2]?.value
	expect(word).toEqual({
		kind: "composite",
		source: '"query=mutation Close($id)-tail"',
		parts: [
			{ kind: "literal", value: "query=mutation Close(" },
			{ kind: "parameter", source: "$id" },
			{ kind: "literal", value: ")-tail" },
		],
		knownPrefix: "query=mutation Close(",
		knownSuffix: ")-tail",
	})
})

test("ShellParser preserves dynamic part boundaries after multibyte literals", async () => {
	const parsed = await parseShell('printf "%s\\n" "pré-$id-fin"')
	expect(parsed.ok).toBe(true)
	if (!parsed.ok) return
	expect(parsed.value.commands[0]?.words[2]?.value).toMatchObject({
		knownPrefix: "pré-",
		knownSuffix: "-fin",
	})
})
