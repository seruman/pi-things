import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import { readJsonFile } from "./json-file"
import { type Result, err, ok } from "./result"

export interface ProjectSafetyConfiguration {
	readonly additionalNoAccessPatterns: readonly string[]
}

export type SafetyConfigurationError = {
	readonly kind: "invalid-project-configuration"
	readonly path: string
	readonly message: string
}

const projectSafetyConfigurationSchema = z
	.object({
		version: z.literal(1),
		protectedPaths: z.array(z.string().min(1)),
	})
	.strict()

export function loadProjectSafetyConfiguration(
	cwd: string,
): Result<ProjectSafetyConfiguration, SafetyConfigurationError> {
	const configurationPath = path.join(cwd, ".pi", "pi-safety.json")
	if (!fs.existsSync(configurationPath)) return ok({ additionalNoAccessPatterns: [] })
	const configuration = readJsonFile(configurationPath, projectSafetyConfigurationSchema)
	if (!configuration.ok) return invalid(configurationPath, configuration.error.message)
	return ok(
		Object.freeze({
			additionalNoAccessPatterns: Object.freeze(configuration.value.protectedPaths),
		}),
	)
}

function invalid(pathname: string, message: string): Result<never, SafetyConfigurationError> {
	return err({ kind: "invalid-project-configuration", path: pathname, message })
}
