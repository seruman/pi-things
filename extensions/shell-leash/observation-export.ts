import { writeFile } from "node:fs/promises"
import * as path from "node:path"
import { type Result, err, ok } from "./result"

export type ObservationExportError = {
	readonly kind: "invalid-path" | "write-failed"
	readonly path: string
	readonly message: string
}

export async function writeObservationExport(
	outputPath: string,
	entries: readonly unknown[],
): Promise<Result<undefined, ObservationExportError>> {
	if (!path.isAbsolute(outputPath)) {
		return err({ kind: "invalid-path", path: outputPath, message: "observation export path must be absolute" })
	}
	try {
		await writeFile(
			outputPath,
			`${JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries }, null, 2)}\n`,
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		)
		return ok(undefined)
	} catch (cause) {
		return err({
			kind: "write-failed",
			path: outputPath,
			message: cause instanceof Error ? cause.message : String(cause),
		})
	}
}
