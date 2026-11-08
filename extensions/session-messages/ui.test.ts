import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { messageSchema } from "../lib/session-delivery/mailbox"
import { card, safeLabel, safeText } from "../lib/session-delivery/ui"

const message = messageSchema.parse({
	version: 2,
	route: {
		kind: "pool",
		pool: "test",
		senderGeneration: "00000000-0000-4000-8000-000000000001",
		recipientGeneration: "00000000-0000-4000-8000-000000000002",
	},
	id: randomUUID(),
	from: { sessionId: "sender-full-routing-id", instanceId: randomUUID(), name: "helper" },
	to: { sessionId: "recipient-full-routing-id", instanceId: randomUUID() },
	delivery: "steer",
	createdAt: 1,
	text:
		"  first line\n\n    界🙂é second line\n" +
		Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") +
		"\nFINAL BODY",
})

for (const name of ["dark", "light"]) {
	for (const mode of ["truecolor", "256color"] as const) {
		test(`${name} ${mode} cards fit narrow widths and expand without changing model body`, () => {
			const theme = loadThemeFromPath(
				fileURLToPath(
					new URL(`./modes/interactive/theme/${name}.json`, import.meta.resolve("@earendil-works/pi-coding-agent")),
				),
				mode,
			)

			const original = JSON.stringify(message)

			for (const width of [1, 2, 3, 8, 20, 80]) {
				for (const expanded of [true, false]) {
					for (const pad of [0, 1, 2]) {
						const rows = card(message, expanded, pad, theme).render(width)
						expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)

						if (!expanded) expect(rows.length).toBeLessThanOrEqual(8)
					}
				}
			}

			const incomingRows = card(message, false, 1, theme).render(100)
			const outgoingRows = card(message, false, 1, theme, "queued").render(100)
			expect(outgoingRows[0]).not.toBe(incomingRows[0])
			expect(stripTerminalSequences(incomingRows.join("\n"))).toContain("← From helper · received · steer")
			expect(stripTerminalSequences(outgoingRows.join("\n"))).toContain(
				"→ To recipient-full-routing-id · queued · steer",
			)
			const full = stripTerminalSequences(card(message, true, 1, theme).render(100).join("\n"))
			expect(full).toContain("FINAL BODY")
			expect(full).toContain("    界🙂é second line")
			expect(full).toContain("reply to sender-full-routing-id")
			const outgoing = stripTerminalSequences(card(message, true, 1, theme, "queued").render(100).join("\n"))
			expect(outgoing).toContain("sent to recipient-full-routing-id")
			expect(outgoing).not.toContain("reply to sender")
			const named = messageSchema.parse({ ...message, to: { ...message.to, name: "Queue helper" } })
			const namedRows = card(named, false, 1, theme, "queued").render(100)
			expect(stripTerminalSequences(namedRows.join("\n"))).toContain("→ To Queue helper · queued · steer")
			// oxlint-disable-next-line no-control-regex -- Verify that the identity retains its bold SGR style.
			expect(namedRows.join("\n")).toMatch(/\x1b\[(?:\d+;)*1(?:;|m)/)
			expect(JSON.stringify(message)).toBe(original)
		})
	}
}

test("pool provenance precedes long identities in incoming, outgoing and interrupted cards", () => {
	const theme = loadThemeFromPath(
		fileURLToPath(
			new URL("./modes/interactive/theme/dark.json", import.meta.resolve("@earendil-works/pi-coding-agent")),
		),
	)

	for (const pool of ["review", "x".repeat(64)]) {
		const named = messageSchema.parse({
			...message,
			route: { ...message.route, pool },
			from: { ...message.from, name: "sender".repeat(40) },
			to: { ...message.to, name: "recipient".repeat(28) },
		})

		const original = JSON.stringify(named)

		for (const direction of ["received", "queued", "interrupted · aborted"]) {
			for (const expanded of [false, true]) {
				for (const width of [1, 8, 24, 40, 80, 160]) {
					const rows = card(named, expanded, 1, theme, direction).render(width)
					expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
					const plain = rows.map((row) => stripTerminalSequences(row).trim()).filter(Boolean)

					if (width >= pool.length + 4) expect(plain[0]).toStartWith(`[${pool}]`)

					if (expanded) expect(plain.join("")).toContain(`[${pool}]`)
				}
			}
		}

		expect(JSON.stringify(named)).toBe(original)
	}
})

test("private family and completion card headings stay unchanged", () => {
	const theme = loadThemeFromPath(
		fileURLToPath(
			new URL("./modes/interactive/theme/dark.json", import.meta.resolve("@earendil-works/pi-coding-agent")),
		),
	)

	for (const route of [
		{ kind: "family", relation: randomUUID(), handle: "child", direction: "delegate" },
		{ kind: "family", relation: randomUUID(), handle: "child", direction: "reply" },
		{ kind: "completion", relation: randomUUID(), handle: "child", sequence: 1 },
	]) {
		const privateMessage = messageSchema.parse({ ...message, route })

		for (const direction of ["received", "queued", "interrupted · aborted"]) {
			const heading = stripTerminalSequences(card(privateMessage, false, 0, theme, direction).render(160)[1]!).trim()
			expect(heading).toBe(
				direction === "queued"
					? "→ To recipient-full-routing-id · queued · steer"
					: `← From helper · ${direction} · steer`,
			)
		}
	}
})

test("UI escapes terminal and bidi controls without modifying body data", () => {
	const body = "hello\x1b[2J\x07\r\u009b31m\u202eunsafe\nnormal\tindent"
	expect(safeText(body)).toBe("hello\\u001b[2J\\u0007\\u000d\\u009b31m\\u202eunsafe\nnormal    indent")
	expect(safeLabel("A\nB\r\v\f\u0085\u2028\u2029")).toBe("A B\\u000d\\u000b\\u000c\\u0085\\u2028\\u2029")
})
