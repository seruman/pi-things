import * as fs from "node:fs"
import * as path from "node:path"
import { type Result, err, ok } from "./result"

export interface ProjectSafetyConfiguration {
	readonly additionalNoAccessPatterns: readonly string[]
}

export type SafetyConfigurationError = {
	readonly kind: "invalid-project-configuration"
	readonly path: string
	readonly message: string
}

export function loadProjectSafetyConfiguration(
	cwd: string,
): Result<ProjectSafetyConfiguration, SafetyConfigurationError> {
	const configurationPath = path.join(cwd, ".pi", "pi-safety.json")
	if (!fs.existsSync(configurationPath)) return ok({ additionalNoAccessPatterns: [] })
	let input: unknown
	try {
		input = JSON.parse(fs.readFileSync(configurationPath, "utf8"))
	} catch (cause) {
		return invalid(configurationPath, cause instanceof Error ? cause.message : String(cause))
	}
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return invalid(configurationPath, "expected an object")
	}
	const keys = Object.keys(input).sort()
	if (keys.length !== 2 || keys[0] !== "protectedPaths" || keys[1] !== "version") {
		return invalid(configurationPath, "expected exactly version and protectedPaths")
	}
	if (!("version" in input) || input.version !== 1) return invalid(configurationPath, "expected version 1")
	if (!("protectedPaths" in input) || !Array.isArray(input.protectedPaths)) {
		return invalid(configurationPath, "protectedPaths must be an array")
	}
	const patterns: string[] = []
	for (const [index, pattern] of input.protectedPaths.entries()) {
		if (typeof pattern !== "string" || pattern.length === 0) {
			return invalid(configurationPath, `protectedPaths[${index}] must be a non-empty string`)
		}
		patterns.push(pattern)
	}
	return ok(Object.freeze({ additionalNoAccessPatterns: Object.freeze(patterns) }))
}

function invalid(pathname: string, message: string): Result<never, SafetyConfigurationError> {
	return err({ kind: "invalid-project-configuration", path: pathname, message })
}
