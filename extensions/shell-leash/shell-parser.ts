import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Language, type Node, Parser } from "web-tree-sitter"
import { type Result, err, ok } from "./result"
import type { StaticWord, StaticWordPart } from "./static-word"

export type SourceRange = {
	readonly startByte: number
	readonly endByte: number
	readonly start: { readonly row: number; readonly column: number }
	readonly end: { readonly row: number; readonly column: number }
}

export type ParsedShellWord = {
	readonly value: StaticWord
	readonly range: SourceRange
}

export type ParsedShellAssignment = {
	readonly name: string
	readonly value: ParsedShellWord
	readonly range: SourceRange
	readonly scopes: readonly string[]
}

export type ParsedShellCommand = {
	readonly words: readonly ParsedShellWord[]
	readonly assignments: readonly ParsedShellAssignment[]
	readonly range: SourceRange
	readonly scopes: readonly string[]
}

export type ParsedShellFunction = {
	readonly name: string
	readonly commands: readonly ParsedShellCommand[]
}

export type ShellSyntaxIssue = {
	readonly kind: "syntax-error" | "missing-syntax"
	readonly text: string
	readonly range: SourceRange
}

export type ParsedShell = {
	readonly commands: readonly ParsedShellCommand[]
	readonly assignments: readonly ParsedShellAssignment[]
	readonly functions: readonly ParsedShellFunction[]
	readonly issues: readonly ShellSyntaxIssue[]
}

export type ShellParserError = { readonly kind: "initialization" | "parse"; readonly message: string }

export interface ShellParser {
	parse(source: string): Promise<Result<ParsedShell, ShellParserError>>
}

let languagePromise: Promise<Language> | undefined

async function parseWithTreeSitter(source: string): Promise<Result<ParsedShell, ShellParserError>> {
	let language: Language
	try {
		language = await loadBashLanguage()
	} catch (cause) {
		return err({ kind: "initialization", message: errorMessage(cause) })
	}

	const parser = new Parser()
	try {
		parser.setLanguage(language)
		const tree = parser.parse(source)
		if (!tree) return err({ kind: "parse", message: "tree-sitter returned no syntax tree" })
		try {
			const commands = tree.rootNode
				.descendantsOfType("command")
				.filter((node) => !hasAncestor(node, "function_definition"))
				.flatMap(commandFromNode)
			const assignments = tree.rootNode
				.descendantsOfType("variable_assignment")
				.filter((node) => !hasAncestor(node, "command") && !hasAncestor(node, "function_definition"))
				.flatMap(assignmentFromNode)
			const functions = tree.rootNode.descendantsOfType("function_definition").flatMap(functionFromNode)
			const issues: ShellSyntaxIssue[] = []
			collectIssues(tree.rootNode, issues)
			return ok({ commands, assignments, functions, issues })
		} finally {
			tree.delete()
		}
	} catch (cause) {
		return err({ kind: "parse", message: errorMessage(cause) })
	} finally {
		parser.delete()
	}
}

export const shellParser: ShellParser = { parse: parseWithTreeSitter }

export function parseShell(source: string): Promise<Result<ParsedShell, ShellParserError>> {
	return shellParser.parse(source)
}

async function loadBashLanguage(): Promise<Language> {
	languagePromise ??= (async () => {
		await Parser.init()
		const wasmUrl = import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm")
		return Language.load(await readFile(fileURLToPath(wasmUrl)))
	})()
	return languagePromise
}

function functionFromNode(node: Node): readonly ParsedShellFunction[] {
	const name = node.childForFieldName("name")
	const body = node.childForFieldName("body")
	if (!name || !body) return []
	return [
		{
			name: literalNodeText(name),
			commands: body
				.descendantsOfType("command")
				.filter((command) => !hasNestedFunctionAncestor(command, node))
				.flatMap(commandFromNode),
		},
	]
}

function hasNestedFunctionAncestor(node: Node, owner: Node): boolean {
	let ancestor = node.parent
	while (ancestor && !ancestor.equals(owner)) {
		if (ancestor.type === "function_definition") return true
		ancestor = ancestor.parent
	}
	return false
}

function hasAncestor(node: Node, type: string): boolean {
	let ancestor = node.parent
	while (ancestor) {
		if (ancestor.type === type) return true
		ancestor = ancestor.parent
	}
	return false
}

function commandFromNode(node: Node): readonly ParsedShellCommand[] {
	const name = node.childForFieldName("name")
	if (!name) return []
	return [
		{
			words: [staticWordFromNode(name), ...node.childrenForFieldName("argument").map(staticWordFromNode)],
			assignments: node.namedChildren
				.filter((child) => child.type === "variable_assignment")
				.flatMap(assignmentFromNode),
			range: sourceRange(node),
			scopes: commandScopes(node),
		},
	]
}

function assignmentFromNode(node: Node): readonly ParsedShellAssignment[] {
	const name = node.childForFieldName("name")
	if (!name) return []
	const value = node.namedChildren.find((child) => !child.equals(name))
	if (!value) return []
	return [{ name: name.text, value: staticWordFromNode(value), range: sourceRange(node), scopes: commandScopes(node) }]
}

const ISOLATED_SCOPE_TYPES = new Set(["subshell", "command_substitution", "process_substitution"])

function commandScopes(node: Node): readonly string[] {
	const scopes: string[] = []
	let ancestor = node.parent
	while (ancestor) {
		if (ISOLATED_SCOPE_TYPES.has(ancestor.type))
			scopes.push(`${ancestor.type}:${ancestor.startIndex}:${ancestor.endIndex}`)
		ancestor = ancestor.parent
	}
	return scopes.reverse()
}

const DYNAMIC_NODE_TYPES = [
	"simple_expansion",
	"expansion",
	"command_substitution",
	"arithmetic_expansion",
	"process_substitution",
	"brace_expansion",
	"glob",
] as const

function staticWordFromNode(node: Node): ParsedShellWord {
	const candidates = node.descendantsOfType([...DYNAMIC_NODE_TYPES])
	if (DYNAMIC_NODE_TYPES.includes(node.type as (typeof DYNAMIC_NODE_TYPES)[number])) candidates.unshift(node)
	const dynamicNodes = candidates.filter(
		(candidate) =>
			!candidates.some(
				(other) =>
					!other.equals(candidate) && other.startIndex <= candidate.startIndex && other.endIndex >= candidate.endIndex,
			),
	)
	if (dynamicNodes.length === 0)
		return { value: { kind: "literal", value: literalNodeText(node) }, range: sourceRange(node) }
	const text = node.text
	const quoted = text.startsWith('"') && text.endsWith('"')
	const contentStart = quoted ? 1 : 0
	const contentEnd = quoted ? text.length - 1 : text.length
	const parts: StaticWordPart[] = []
	let cursor = contentStart
	for (const dynamic of dynamicNodes) {
		const start = Math.max(contentStart, dynamic.startIndex - node.startIndex)
		const end = Math.min(contentEnd, dynamic.endIndex - node.startIndex)
		if (start > cursor) parts.push({ kind: "literal", value: text.slice(cursor, start) })
		parts.push(dynamicPart(dynamic))
		cursor = Math.max(cursor, end)
	}
	if (cursor < contentEnd) parts.push({ kind: "literal", value: text.slice(cursor, contentEnd) })
	const first = parts[0]
	const last = parts[parts.length - 1]
	return {
		value: {
			kind: "composite",
			source: node.text,
			parts,
			knownPrefix: first?.kind === "literal" ? first.value : "",
			knownSuffix: last?.kind === "literal" ? last.value : "",
		},
		range: sourceRange(node),
	}
}

function dynamicPart(node: Node): StaticWordPart {
	switch (node.type) {
		case "simple_expansion":
		case "expansion":
			return { kind: "parameter", source: node.text }
		case "command_substitution":
			return { kind: "command-substitution", source: node.text }
		case "arithmetic_expansion":
			return { kind: "arithmetic", source: node.text }
		case "glob":
			return { kind: "glob", source: node.text }
		default:
			return { kind: "other-dynamic", source: node.text }
	}
}

function literalNodeText(node: Node): string {
	if (node.type === "command_name" && node.namedChildCount === 1) {
		const child = node.namedChild(0)
		if (child) return literalNodeText(child)
	}
	if (node.type === "raw_string" && node.text.startsWith("'") && node.text.endsWith("'")) {
		return node.text.slice(1, -1)
	}
	if (node.type === "string" && node.text.startsWith('"') && node.text.endsWith('"')) {
		return node.text.slice(1, -1)
	}
	return node.text
}

function collectIssues(node: Node, output: ShellSyntaxIssue[]): void {
	if (node.isError || node.isMissing) {
		output.push({
			kind: node.isMissing ? "missing-syntax" : "syntax-error",
			text: node.text,
			range: sourceRange(node),
		})
	}
	for (const child of node.children) collectIssues(child, output)
}

function sourceRange(node: Node): SourceRange {
	return {
		startByte: node.startIndex,
		endByte: node.endIndex,
		start: node.startPosition,
		end: node.endPosition,
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
