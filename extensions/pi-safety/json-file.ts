import * as fs from "node:fs"
import type { z } from "zod"
import { type Result, err, ok } from "./result"

export type JsonFileError = {
	readonly kind: "json-file"
	readonly path: string
	readonly message: string
}

export type JsonFileSchemaError =
	| JsonFileError
	| {
			readonly kind: "json-file-schema"
			readonly path: string
			readonly message: string
			readonly cause: z.ZodError
	  }

export function readJsonFile<Schema extends z.ZodTypeAny>(
	path: string,
	schema: Schema,
): Result<z.infer<Schema>, JsonFileSchemaError>
export function readJsonFile(path: string): Result<unknown, JsonFileError>
export function readJsonFile(path: string, schema?: z.ZodTypeAny): Result<unknown, JsonFileSchemaError> {
	let input: unknown
	try {
		input = JSON.parse(fs.readFileSync(path, "utf8"))
	} catch (cause) {
		return err({
			kind: "json-file",
			path,
			message: cause instanceof Error ? cause.message : String(cause),
		})
	}
	if (!schema) return ok(input)
	const decoded = schema.safeParse(input)
	if (decoded.success) return ok(decoded.data)
	return err({
		kind: "json-file-schema",
		path,
		message: decoded.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; "),
		cause: decoded.error,
	})
}
