// Adapted from https://gist.github.com/badlogic/563f245975444dbeedd1a93de95a5e92

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"

type AssistantTextPart = { type: "text"; text: string }
type AssistantLike = {
	role: "assistant"
	stopReason?: string
	content: Array<{ type: string; text?: string }>
}

function getLastAssistantText(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]
		if (entry.type !== "message") {
			continue
		}

		const message = entry.message
		if (message.role !== "assistant") {
			continue
		}

		const assistant = message as AssistantLike
		if (assistant.stopReason !== "stop") {
			return undefined
		}

		const text = assistant.content
			.filter((part): part is AssistantTextPart => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim()

		return text || undefined
	}

	return undefined
}

function formatQuotedEditorText(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n")
}

function editWithExternalEditor(initialText: string): string {
	const editorCmd = process.env.VISUAL || process.env.EDITOR
	if (!editorCmd) {
		throw new Error("No editor configured. Set $VISUAL or $EDITOR environment variable.")
	}

	const tmpFile = path.join(os.tmpdir(), `pi-comment-${Date.now()}.md`)
	try {
		fs.writeFileSync(tmpFile, initialText, "utf8")
		const [editor, ...editorArgs] = editorCmd.split(" ")
		const result = spawnSync(editor, [...editorArgs, tmpFile], {
			stdio: "inherit",
			shell: process.platform === "win32",
		})

		if (result.status !== 0) {
			throw new Error(`Editor exited with status ${result.status ?? "unknown"}`)
		}

		return fs.readFileSync(tmpFile, "utf8").replace(/\n$/, "")
	} finally {
		try {
			fs.unlinkSync(tmpFile)
		} catch {
			// Best-effort temp file cleanup.
		}
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("comment", {
		description: "Open the last assistant message in $EDITOR and load the edited quote into the prompt editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/comment requires interactive mode", "error")
				return
			}

			const lastAssistantText = getLastAssistantText(ctx.sessionManager.getBranch())
			if (!lastAssistantText) {
				ctx.ui.notify("No completed assistant message found on the current branch", "error")
				return
			}

			try {
				const editedText = editWithExternalEditor(formatQuotedEditorText(lastAssistantText))
				ctx.ui.setEditorText(editedText)
				ctx.ui.notify("Loaded edited quoted assistant text into the editor", "info")
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
			}
		},
	})
}
