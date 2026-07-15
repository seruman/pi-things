import { z } from "zod"
import { readJsonFile } from "./json-file"

const unknownResult = readJsonFile("/tmp/value.json")
if (unknownResult.ok) {
	// @ts-expect-error Reading without a schema returns unknown.
	const value: string = unknownResult.value
	void value
}

const typedResult = readJsonFile("/tmp/value.json", z.object({ name: z.string() }))
if (typedResult.ok) {
	const name: string = typedResult.value.name
	// @ts-expect-error Schema output preserves its field types.
	const invalid: number = typedResult.value.name
	void name
	void invalid
}
