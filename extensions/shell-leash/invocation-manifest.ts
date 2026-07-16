import { readFile, writeFile } from "node:fs/promises"
import { z } from "zod"
import { type GitHubOperation, isGitHubOperation } from "./github-operations"
import { type Result, err, ok } from "./result"

const knownRepositoryTargetSchema = z
	.object({
		kind: z.literal("repository"),
		host: z.string().min(1),
		owner: z.string().min(1),
		repository: z.string().min(1),
	})
	.strict()

const repositoryTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("unknown") }).strict(),
	knownRepositoryTargetSchema,
])

const knownGitRemoteTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("url"), url: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("implicit") }).strict(),
])

const gitRemoteTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("url"), url: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("implicit") }).strict(),
	z.object({ kind: z.literal("unknown"), source: z.string() }).strict(),
])

const gitRefspecSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("source"), source: z.string() }).strict(),
	z.object({ kind: z.literal("mapping"), source: z.string(), destination: z.string() }).strict(),
	z.object({ kind: z.literal("delete"), destination: z.string() }).strict(),
	z.object({ kind: z.literal("unknown"), source: z.string() }).strict(),
])

const gitPushEffectSchema = z
	.object({
		kind: z.literal("git-push"),
		operation: z.enum(["git.push", "git.push.force", "git.push.delete"]),
		remote: gitRemoteTargetSchema,
		refspecs: z.array(gitRefspecSchema).readonly(),
		repository: repositoryTargetSchema,
		details: z
			.object({
				force: z.enum(["none", "force", "force-with-lease"]),
				destination: z.enum(["implicit", "explicit"]),
				all: z.boolean(),
				mirror: z.boolean(),
				tags: z.boolean(),
				prune: z.boolean(),
			})
			.strict(),
	})
	.strict()

const githubTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("unknown") }).strict(),
	z
		.object({
			kind: z.literal("repository"),
			host: z.string().min(1),
			owner: z.string().min(1),
			repository: z.string().min(1),
		})
		.strict(),
])

const githubObjectSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("issue"), number: z.number().int().positive().optional() }).strict(),
	z.object({ kind: z.literal("pull-request"), number: z.number().int().positive().optional() }).strict(),
])

const githubDetailsSchema = z.union([
	z.object({ object: githubObjectSchema }).strict(),
	z.object({ api: z.object({ method: z.string().min(1), endpoint: z.string().min(1) }).strict() }).strict(),
	z
		.object({
			command: z
				.object({ group: z.string().min(1), action: z.string().min(1), arguments: z.array(z.string()).readonly() })
				.strict(),
		})
		.strict(),
])

const githubEffectSchema = z
	.object({
		kind: z.literal("github"),
		operation: z.custom<GitHubOperation>(isGitHubOperation),
		target: githubTargetSchema,
		details: githubDetailsSchema,
	})
	.strict()

const remoteEffectSchema = z.discriminatedUnion("kind", [gitPushEffectSchema, githubEffectSchema])

const invocationPermitSchema = z
	.object({
		toolCallId: z.string().min(1),
		effects: z.array(remoteEffectSchema).readonly(),
	})
	.strict()

const remoteTargetScopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("any") }).strict(),
	knownRepositoryTargetSchema,
	z
		.object({
			kind: z.literal("git-push-target"),
			repository: knownRepositoryTargetSchema,
			remote: knownGitRemoteTargetSchema,
		})
		.strict(),
])

const requestLeaseSchema = z
	.object({
		requestId: z.string().min(1),
		operation: z.union([
			z.enum(["git.push", "git.push.force", "git.push.delete"]),
			z.custom<GitHubOperation>(isGitHubOperation),
		]),
		target: remoteTargetScopeSchema,
	})
	.strict()

const invocationManifestSchema = z
	.object({
		version: z.literal(1),
		requestId: z.string().min(1),
		toolCallId: z.string().min(1),
		createdAt: z.string().datetime({ offset: true }),
		expiresAt: z.string().datetime({ offset: true }),
		realExecutables: z.object({ git: z.string().min(1), gh: z.string().min(1).optional() }).strict(),
		observationLog: z.string().min(1),
		permit: invocationPermitSchema,
		leases: z.array(requestLeaseSchema).readonly(),
	})
	.strict()

export type InvocationManifest = z.infer<typeof invocationManifestSchema>

export type InvocationManifestError = { readonly kind: "invalid-manifest"; readonly message: string }

export type InvocationManifestFileError =
	| { readonly kind: "read-failed"; readonly path: string; readonly message: string }
	| { readonly kind: "invalid-json"; readonly path: string; readonly message: string }
	| { readonly kind: "serialize-failed"; readonly path: string; readonly message: string }
	| { readonly kind: "write-failed"; readonly path: string; readonly message: string }
	| InvocationManifestError

export function parseInvocationManifest(
	input: unknown,
	options: { readonly now?: Date } = {},
): Result<InvocationManifest, InvocationManifestError> {
	const parsed = invocationManifestSchema.safeParse(input)
	if (!parsed.success) {
		return err({ kind: "invalid-manifest", message: parsed.error.issues.map((issue) => issue.message).join("; ") })
	}
	const manifest = parsed.data
	if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.createdAt)) {
		return err({ kind: "invalid-manifest", message: "expiresAt must be later than createdAt" })
	}
	if (options.now && Date.parse(manifest.expiresAt) <= options.now.getTime()) {
		return err({ kind: "invalid-manifest", message: "invocation manifest has expired" })
	}
	if (manifest.permit.toolCallId !== manifest.toolCallId) {
		return err({ kind: "invalid-manifest", message: "permit toolCallId does not match manifest" })
	}
	if (manifest.leases.some((lease) => lease.requestId !== manifest.requestId)) {
		return err({ kind: "invalid-manifest", message: "lease requestId does not match manifest" })
	}
	return ok(manifest)
}

export async function writeInvocationManifest(
	manifestPath: string,
	manifest: InvocationManifest,
): Promise<Result<undefined, InvocationManifestFileError>> {
	let source: string
	try {
		source = `${JSON.stringify(manifest)}\n`
	} catch (cause) {
		return err({ kind: "serialize-failed", path: manifestPath, message: errorMessage(cause) })
	}
	try {
		await writeFile(manifestPath, source, { encoding: "utf8", mode: 0o600, flag: "wx" })
		return ok(undefined)
	} catch (cause) {
		return err({ kind: "write-failed", path: manifestPath, message: errorMessage(cause) })
	}
}

export async function readInvocationManifest(
	manifestPath: string,
): Promise<Result<InvocationManifest, InvocationManifestFileError>> {
	let source: string
	try {
		source = await readFile(manifestPath, "utf8")
	} catch (cause) {
		return err({ kind: "read-failed", path: manifestPath, message: errorMessage(cause) })
	}
	let input: unknown
	try {
		input = JSON.parse(source)
	} catch (cause) {
		return err({ kind: "invalid-json", path: manifestPath, message: errorMessage(cause) })
	}
	return parseInvocationManifest(input, { now: new Date() })
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
