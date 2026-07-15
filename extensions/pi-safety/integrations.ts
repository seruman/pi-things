import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import {
	type CanonicalExecutable,
	type CanonicalPath,
	parseCanonicalExecutable,
	parseCanonicalPath,
} from "./canonical-path"
import { readJsonFile } from "./json-file"
import { type Result, err, ok } from "./result"

export type SocketIntegration =
	| { readonly kind: "disabled" }
	| { readonly kind: "unix-socket"; readonly socket: CanonicalPath }
	| { readonly kind: "network" }

export type WbIntegration =
	| { readonly kind: "disabled" }
	| {
			readonly kind: "enabled"
			readonly executable: CanonicalExecutable
			readonly runtimeDirectory: CanonicalPath
			readonly socket: CanonicalPath
			readonly log: CanonicalPath
			readonly webKitState: CanonicalPath
			readonly cacheState: CanonicalPath
	  }

export interface BashIntegrations {
	readonly gitExecutable: CanonicalExecutable
	readonly sshAgent: SocketIntegration
	readonly docker: SocketIntegration
	readonly wb: WbIntegration
}

export interface RawIntegrationEnvironment {
	readonly path: string | undefined
	readonly sshAuthSock: string | undefined
	readonly dockerHost: string | undefined
	readonly dockerContext: string | undefined
}

type IntegrationName = "git" | "ssh-agent" | "docker" | "wb"

const dockerConfigurationSchema = z.object({ currentContext: z.string().min(1).optional() }).passthrough()
const dockerContextMetadataSchema = z
	.object({
		Name: z.string(),
		Endpoints: z
			.object({
				docker: z.object({ Host: z.string() }).passthrough(),
			})
			.passthrough(),
	})
	.passthrough()

export type IntegrationError =
	| {
			readonly kind: "invalid-integration-path"
			readonly integration: IntegrationName
			readonly input: string
			readonly message: string
	  }
	| {
			readonly kind: "integration-io"
			readonly operation: "prepare" | "cleanup"
			readonly path: string
			readonly message: string
	  }

export function parseBashIntegrations(input: {
	readonly environment: RawIntegrationEnvironment
	readonly home: CanonicalPath
}): Result<BashIntegrations, IntegrationError> {
	const discoveredGit = findExecutable("git", "git", input.environment.path)
	if (!discoveredGit.ok) return discoveredGit
	let git = discoveredGit.value
	if (git === undefined) {
		const systemGit = parseCanonicalExecutable("/usr/bin/git")
		if (!systemGit.ok) return integrationError("git", "/usr/bin/git", JSON.stringify(systemGit.error))
		git = systemGit.value
	}
	const sshAgent = parseOptionalSocket("ssh-agent", input.environment.sshAuthSock)
	if (!sshAgent.ok) return sshAgent
	const docker = parseDocker(input.environment.dockerHost, input.environment.dockerContext, input.home)
	if (!docker.ok) return docker
	const wbExecutable = findExecutable("wb", "wb", input.environment.path)
	if (!wbExecutable.ok) return wbExecutable
	let wb: WbIntegration = { kind: "disabled" }
	if (wbExecutable.value) {
		const uid = process.getuid?.() ?? 0
		const runtimeDirectory = parseIntegrationPath(
			"wb",
			path.join("/private/tmp", `pi-safety-wb-${uid}-${randomBytes(8).toString("hex")}`),
		)
		if (!runtimeDirectory.ok) return runtimeDirectory
		const socket = parseIntegrationPath("wb", path.join(runtimeDirectory.value, "wb.sock"))
		if (!socket.ok) return socket
		const log = parseIntegrationPath("wb", path.join(runtimeDirectory.value, "wb.log"))
		if (!log.ok) return log
		const webKitState = parseIntegrationPath("wb", path.join(input.home, "Library", "WebKit", "wb"))
		if (!webKitState.ok) return webKitState
		const cacheState = parseIntegrationPath("wb", path.join(input.home, "Library", "Caches", "wb"))
		if (!cacheState.ok) return cacheState
		wb = {
			kind: "enabled",
			executable: wbExecutable.value,
			runtimeDirectory: runtimeDirectory.value,
			socket: socket.value,
			log: log.value,
			webKitState: webKitState.value,
			cacheState: cacheState.value,
		}
	}
	return ok(Object.freeze({ gitExecutable: git, sshAgent: sshAgent.value, docker: docker.value, wb }))
}

export function prepareBashIntegrations(integrations: BashIntegrations): Result<undefined, IntegrationError> {
	if (integrations.wb.kind === "disabled") return ok(undefined)
	try {
		fs.mkdirSync(integrations.wb.runtimeDirectory, { mode: 0o700 })
		fs.mkdirSync(integrations.wb.webKitState, { recursive: true, mode: 0o700 })
		fs.mkdirSync(integrations.wb.cacheState, { recursive: true, mode: 0o700 })
		return ok(undefined)
	} catch (cause) {
		return err({
			kind: "integration-io",
			operation: "prepare",
			path: integrations.wb.runtimeDirectory,
			message: cause instanceof Error ? cause.message : String(cause),
		})
	}
}

export function cleanupBashIntegrations(integrations: BashIntegrations): Result<undefined, IntegrationError> {
	if (integrations.wb.kind === "disabled") return ok(undefined)
	const parent = path.dirname(integrations.wb.runtimeDirectory)
	const name = path.basename(integrations.wb.runtimeDirectory)
	if (parent !== "/private/tmp" || !/^pi-safety-wb-\d+-[0-9a-f]{16}$/.test(name)) {
		return err({
			kind: "integration-io",
			operation: "cleanup",
			path: integrations.wb.runtimeDirectory,
			message: "refusing to remove an unguarded wb runtime directory",
		})
	}
	try {
		fs.rmSync(integrations.wb.runtimeDirectory, { recursive: true, force: true })
		return ok(undefined)
	} catch (cause) {
		return err({
			kind: "integration-io",
			operation: "cleanup",
			path: integrations.wb.runtimeDirectory,
			message: cause instanceof Error ? cause.message : String(cause),
		})
	}
}

function parseOptionalSocket(
	integration: "ssh-agent",
	input: string | undefined,
): Result<SocketIntegration, IntegrationError> {
	if (input === undefined || input.length === 0) return ok({ kind: "disabled" })
	const socket = parseIntegrationPath(integration, input)
	return socket.ok ? ok({ kind: "unix-socket", socket: socket.value }) : socket
}

function parseDocker(
	dockerHost: string | undefined,
	dockerContext: string | undefined,
	home: CanonicalPath,
): Result<SocketIntegration, IntegrationError> {
	if (dockerHost) return parseDockerEndpoint(dockerHost)
	const configuredContext = dockerContext ? ok(dockerContext) : readCurrentDockerContext(home)
	if (!configuredContext.ok) return configuredContext
	const contextName = configuredContext.value
	if (contextName !== undefined && contextName !== "default") {
		const endpoint = readDockerContextEndpoint(home, contextName)
		if (!endpoint.ok) return endpoint
		return parseDockerEndpoint(endpoint.value)
	}
	for (const candidate of [path.join(home, ".docker", "run", "docker.sock"), "/var/run/docker.sock"]) {
		if (!fs.existsSync(candidate)) continue
		const socket = parseIntegrationPath("docker", candidate)
		return socket.ok ? ok({ kind: "unix-socket", socket: socket.value }) : socket
	}
	return ok({ kind: "disabled" })
}

function parseDockerEndpoint(input: string): Result<SocketIntegration, IntegrationError> {
	let url: URL
	try {
		url = new URL(input)
	} catch (cause) {
		return integrationError("docker", input, cause)
	}
	if (url.protocol !== "unix:") {
		return ["tcp:", "http:", "https:", "ssh:"].includes(url.protocol)
			? ok({ kind: "network" })
			: integrationError("docker", input, `unsupported Docker endpoint protocol ${url.protocol}`)
	}
	let decodedPath: string
	try {
		decodedPath = decodeURIComponent(url.pathname)
	} catch (cause) {
		return integrationError("docker", input, cause)
	}
	const socket = parseIntegrationPath("docker", decodedPath)
	return socket.ok ? ok({ kind: "unix-socket", socket: socket.value }) : socket
}

function readCurrentDockerContext(home: CanonicalPath): Result<string | undefined, IntegrationError> {
	const config = path.join(home, ".docker", "config.json")
	if (!fs.existsSync(config)) return ok(undefined)
	const configuration = readJsonFile(config, dockerConfigurationSchema)
	return configuration.ok
		? ok(configuration.value.currentContext)
		: integrationError("docker", config, configuration.error.message)
}

function readDockerContextEndpoint(home: CanonicalPath, contextName: string): Result<string, IntegrationError> {
	const digest = createHash("sha256").update(contextName).digest("hex")
	const metadata = path.join(home, ".docker", "contexts", "meta", digest, "meta.json")
	const context = readJsonFile(metadata, dockerContextMetadataSchema)
	if (!context.ok) return integrationError("docker", metadata, context.error.message)
	if (context.value.Name !== contextName) {
		return integrationError("docker", metadata, "context metadata does not match the selected context")
	}
	return ok(context.value.Endpoints.docker.Host)
}

function findExecutable(
	name: string,
	integration: IntegrationName,
	pathValue: string | undefined,
): Result<CanonicalExecutable | undefined, IntegrationError> {
	for (const directory of (pathValue ?? "").split(path.delimiter)) {
		if (!directory) continue
		const candidate = path.join(directory, name)
		if (!fs.existsSync(candidate)) continue
		const stat = fs.statSync(candidate)
		if (!stat.isFile() || (stat.mode & 0o111) === 0) continue
		const parsed = parseCanonicalExecutable(candidate)
		return parsed.ok ? parsed : integrationError(integration, candidate, JSON.stringify(parsed.error))
	}
	return ok(undefined)
}

function parseIntegrationPath(integration: IntegrationName, input: string): Result<CanonicalPath, IntegrationError> {
	const parsed = parseCanonicalPath(input)
	return parsed.ok ? parsed : integrationError(integration, input, JSON.stringify(parsed.error))
}

function integrationError(
	integration: IntegrationName,
	input: string,
	cause: unknown,
): Result<never, IntegrationError> {
	return err({
		kind: "invalid-integration-path",
		integration,
		input,
		message: cause instanceof Error ? cause.message : String(cause),
	})
}
