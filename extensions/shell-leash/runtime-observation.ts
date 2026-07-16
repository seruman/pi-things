import { readFile } from "node:fs/promises"
import { z } from "zod"
import { analysisObservationSchema } from "./observation-schema"
import { type Result, err, ok } from "./result"

const runtimeObservationEntrySchema = z
	.object({
		version: z.literal(1),
		source: z.literal("shim"),
		createdAt: z.string().datetime({ offset: true }),
		argv: z.array(z.string()).readonly(),
		observation: analysisObservationSchema,
	})
	.strict()

export type RuntimeObservationEntry = z.infer<typeof runtimeObservationEntrySchema>

export type RuntimeObservationError =
	| { readonly kind: "read-failed"; readonly path: string; readonly message: string }
	| { readonly kind: "invalid-json"; readonly path: string; readonly line: number; readonly message: string }
	| { readonly kind: "invalid-entry"; readonly path: string; readonly line: number; readonly message: string }

export async function readRuntimeObservations(
	logPath: string,
): Promise<Result<readonly RuntimeObservationEntry[], RuntimeObservationError>> {
	let source: string
	try {
		source = await readFile(logPath, "utf8")
	} catch (cause) {
		if (isNodeError(cause) && cause.code === "ENOENT") return ok([])
		return err({ kind: "read-failed", path: logPath, message: errorMessage(cause) })
	}
	const entries: RuntimeObservationEntry[] = []
	const lines = source.split("\n")
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]
		if (!line) continue
		let input: unknown
		try {
			input = JSON.parse(line)
		} catch (cause) {
			return err({ kind: "invalid-json", path: logPath, line: index + 1, message: errorMessage(cause) })
		}
		const parsed = runtimeObservationEntrySchema.safeParse(input)
		if (!parsed.success) {
			return err({
				kind: "invalid-entry",
				path: logPath,
				line: index + 1,
				message: parsed.error.issues.map((issue) => issue.message).join("; "),
			})
		}
		entries.push(parsed.data)
	}
	return ok(entries)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
