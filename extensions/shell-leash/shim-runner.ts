import { spawn } from "node:child_process"
import { constants as osConstants } from "node:os"
import * as path from "node:path"
import { parseGitHubRepositoryTarget } from "./analyze-command"
import type { AnalysisObservation } from "./findings"
import { isFixtureExecutable } from "./fixture-executable"
import { gitEnvironmentCwd, gitInvocationCwd } from "./git-context"
import type { InvocationManifest } from "./invocation-manifest"
import { resolveRepositoryContext } from "./repository-target"
import { decideShimInvocation } from "./shim-decision"

export type ShimRunOptions = {
	readonly cwd: string
	readonly env: Readonly<NodeJS.ProcessEnv>
} & (
	| { readonly captureOutput: false }
	| { readonly captureOutput: true; readonly fixtureRoot: string; readonly stdin?: string }
)

export type ShimRunResult =
	| {
			readonly kind: "blocked"
			readonly exitCode: 126
			readonly stderr: string
			readonly observations: readonly AnalysisObservation[]
	  }
	| {
			readonly kind: "delegated"
			readonly exitCode: number
			readonly stdout: string
			readonly stderr: string
			readonly signal?: NodeJS.Signals
			readonly observations: readonly AnalysisObservation[]
	  }
	| {
			readonly kind: "spawn-failed"
			readonly exitCode: 126
			readonly stderr: string
			readonly observations: readonly AnalysisObservation[]
	  }

export async function runShim(
	manifest: InvocationManifest,
	argv: readonly string[],
	options: ShimRunOptions,
): Promise<ShimRunResult> {
	const tool = path.basename(argv[0] ?? "")
	if (tool !== "git" && tool !== "gh") {
		return { kind: "blocked", exitCode: 126, stderr: "shell-leash: unsupported shim tool", observations: [] }
	}
	const realExecutable = manifest.realExecutables[tool]
	if (!realExecutable) {
		return {
			kind: "blocked",
			exitCode: 126,
			stderr: `shell-leash: no real ${tool} executable is configured`,
			observations: [],
		}
	}
	if (options.captureOutput && !isFixtureExecutable(options.fixtureRoot, realExecutable)) {
		return {
			kind: "blocked",
			exitCode: 126,
			stderr: `shell-leash test guard: executable is outside guarded fixture root: ${realExecutable}`,
			observations: [],
		}
	}
	const environmentCwd = gitEnvironmentCwd(options.cwd, options.env.GIT_WORK_TREE, options.env.GIT_DIR)
	const resolvedContext = await resolveRepositoryContext(gitInvocationCwd(argv, environmentCwd))
	const repository = resolvedContext.ok ? resolvedContext.value.repository : { kind: "unknown" as const }
	const gitRemotes = resolvedContext.ok ? resolvedContext.value.remotes : new Map<string, string>()
	const githubRepository = options.env.GH_REPO ? parseGitHubRepositoryTarget(options.env.GH_REPO) : undefined
	const decision = decideShimInvocation(
		manifest,
		argv,
		options.cwd,
		repository,
		githubRepository,
		gitRemotes,
		resolvedContext.ok ? resolvedContext.value.currentBranch : undefined,
	)
	if (decision.kind === "block") {
		return { kind: "blocked", exitCode: 126, stderr: decision.reason, observations: decision.observations }
	}

	return new Promise((resolve) => {
		const child = spawn(realExecutable, argv.slice(1), {
			cwd: options.cwd,
			env: { ...options.env },
			stdio: options.captureOutput ? ["pipe", "pipe", "pipe"] : "inherit",
			shell: false,
		})
		let stdout = ""
		let stderr = ""
		if (options.captureOutput) {
			child.stdin?.end(options.stdin ?? "")
			child.stdout?.setEncoding("utf8")
			child.stderr?.setEncoding("utf8")
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk
			})
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk
			})
		}
		child.once("error", (cause) => {
			resolve({
				kind: "spawn-failed",
				exitCode: 126,
				stderr: `shell-leash: could not start real executable: ${cause.message}`,
				observations: decision.observations,
			})
		})
		child.once("close", (code, signal) => {
			const signalNumber = signal ? osConstants.signals[signal] : undefined
			const exitCode = code ?? (signalNumber ? 128 + signalNumber : 126)
			resolve({
				kind: "delegated",
				exitCode,
				stdout,
				stderr,
				...(signal ? { signal } : {}),
				observations: decision.observations,
			})
		})
	})
}
