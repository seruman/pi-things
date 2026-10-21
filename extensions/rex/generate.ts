#!/usr/bin/env bun
// Regenerates rex-api.d.ts from the running Rex server's method list.
// Usage: bun extensions/rex/generate.ts [api-list.json]
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonSchema), z.record(jsonSchema)]),
)

// The JSON Schema subset Rex uses. Composition keywords are decoded only to reject them.
interface ObjectSchema {
	type?: string | string[]
	description?: string
	properties?: { [name: string]: Schema }
	required?: string[]
	additionalProperties?: Schema
	items?: Schema
	enum?: Json[]
	const?: Json
	$ref?: string
	$anchor?: string
	anyOf?: Json
	oneOf?: Json
	allOf?: Json
}

type Schema = boolean | ObjectSchema

const schemaSchema: z.ZodType<Schema> = z.lazy(() =>
	z.union([
		z.boolean(),
		z.object({
			type: z.union([z.string(), z.array(z.string())]).optional(),
			description: z.string().optional(),
			properties: z.record(schemaSchema).optional(),
			required: z.array(z.string()).optional(),
			additionalProperties: schemaSchema.optional(),
			items: schemaSchema.optional(),
			enum: z.array(jsonSchema).optional(),
			const: jsonSchema.optional(),
			$ref: z.string().optional(),
			$anchor: z.string().optional(),
			anyOf: jsonSchema.optional(),
			oneOf: jsonSchema.optional(),
			allOf: jsonSchema.optional(),
		}),
	]),
)

const apiListSchema = z.object({
	methods: z.array(
		z.object({
			name: z.string(),
			description: z.string().optional(),
			input_schema: schemaSchema.optional(),
			output_schema: schemaSchema.optional(),
		}),
	),
})

const output = join(import.meta.dirname, "rex-api.d.ts")

const source = process.argv[2]
	? readFileSync(process.argv[2], "utf8")
	: execFileSync("rex", ["api", "list", "--json"], { encoding: "utf8" })

const methods = apiListSchema.parse(JSON.parse(source)).methods

// Rex inlines shared definitions with $anchor and points back at them with "#anchor" refs.
const anchors = new Map<string, string>()

function pascal(name: string): string {
	return name
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("")
}

function key(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function doc(text: string | undefined, indent: string): string {
	if (!text?.trim()) return ""

	return `${indent}/** ${text.trim().replaceAll("*/", "*\\/").replaceAll("\n", `\n${indent} * `)} */\n`
}

function wrap(type: string): string {
	return type.includes("|") ? `(${type})` : type
}

function objectType(schema: ObjectSchema, indent: string): string {
	const properties = schema.properties ?? {}
	const required = new Set(schema.required ?? [])
	const extra = schema.additionalProperties
	const inner = `${indent}\t`

	const lines = Object.entries(properties).map(
		([name, property]) =>
			`${doc(property === true || property === false ? undefined : property.description, inner)}${inner}${key(name)}${required.has(name) ? "" : "?"}: ${toType(property, inner)}`,
	)

	if (extra !== undefined && extra !== true && extra !== false) {
		lines.push(`${inner}[key: string]: ${toType(extra, inner)}`)
	} else if (extra !== false && lines.length === 0) return "{ [key: string]: RexJson }"
	else if (extra !== false) lines.push(`${inner}[key: string]: RexJson`)

	if (lines.length === 0) return "Record<string, never>"

	return `{\n${lines.join("\n")}\n${indent}}`
}

function singleType(type: string, schema: ObjectSchema, indent: string): string {
	switch (type) {
		case "null":
			return "null"
		case "boolean":
			return "boolean"
		case "integer":
		case "number":
			return "number"
		case "string":
			return "string"
		case "array":
			return `${wrap(toType(schema.items ?? true, indent))}[]`
		case "object":
			return objectType(schema, indent)
		default:
			throw new Error(`Unsupported JSON Schema type: ${type}`)
	}
}

function toType(schema: Schema, indent = ""): string {
	if (schema === true) return "RexJson"

	if (schema === false) return "never"

	if (schema.$ref !== undefined) {
		const name = anchors.get(schema.$ref.replace(/^#/, ""))

		if (!name) throw new Error(`Unknown $ref: ${schema.$ref}`)

		return name
	}

	if (schema.$anchor !== undefined) {
		const anchor = schema.$anchor

		if (!anchors.has(anchor)) {
			const name = pascal(anchor)
			anchors.set(anchor, name)
			const { $anchor: _anchor, ...rest } = schema
			definitions.push(`${doc(schema.description, "")}export type ${name} = ${toType(rest)}`)
		}

		return anchors.get(anchor)!
	}

	if (schema.enum !== undefined) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")

	if ("const" in schema) return JSON.stringify(schema.const)

	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		if (schema[keyword] !== undefined) throw new Error(`Unsupported JSON Schema keyword: ${keyword}`)
	}

	const types = schema.type === undefined ? [] : [schema.type].flat()

	if (types.length === 0) return "RexJson"

	return types.map((type) => singleType(type, schema, indent)).join(" | ")
}

const definitions: string[] = []

const entries = methods
	.toSorted((a, b) => a.name.localeCompare(b.name))
	.map((method) => {
		const input = method.input_schema === undefined ? "{ [key: string]: RexJson }" : toType(method.input_schema, "\t\t")
		const result = method.output_schema === undefined ? "RexJson" : toType(method.output_schema, "\t\t")

		return `${doc(method.description, "\t")}\t${JSON.stringify(method.name)}: {\n\t\tinput: ${input}\n\t\toutput: ${result}\n\t}`
	})

writeFileSync(
	output,
	[
		"// Generated by extensions/rex/generate.ts from `rex api list --json`. Do not edit by hand.",
		"",
		"export type RexJson = null | boolean | number | string | RexJson[] | { [key: string]: RexJson }",
		"",
		...definitions.flatMap((definition) => [definition, ""]),
		"export interface RexMethods {",
		entries.join("\n"),
		"}",
		"",
	].join("\n"),
)

console.log(`Wrote ${methods.length} methods to ${output}`)
