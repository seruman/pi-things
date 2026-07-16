import type { RemoteEffect } from "./effects"

export type CommandSourceKind =
	| "top-level"
	| "subshell"
	| "command-substitution"
	| "process-substitution"
	| "function"
	| "nested-shell"
	| "embedded-script"
	| "child-command"

export type EffectEvidence = {
	readonly analyzer: "git" | "github"
	readonly argv: readonly string[]
	readonly source?: {
		readonly kind: CommandSourceKind
		readonly startByte?: number
		readonly endByte?: number
	}
}

export type EffectFinding = {
	readonly effect: RemoteEffect
	readonly evidence: EffectEvidence
	readonly certainty: "exact" | "partial"
}

export type AnalysisObservation =
	| { readonly kind: "parser-failure"; readonly stage: "initialization" | "parse"; readonly message: string }
	| { readonly kind: "recursion-limit"; readonly source: string }
	| {
			readonly kind: "dynamic-executable"
			readonly source: string
			readonly startByte: number
			readonly endByte: number
	  }
	| { readonly kind: "dynamic-argument"; readonly source: string; readonly index: number }
	| { readonly kind: "embedded-dynamic"; readonly interpreter: string; readonly source: string }
	| { readonly kind: "unknown-git"; readonly argv: readonly string[] }
	| { readonly kind: "git-scope-override"; readonly setting: string; readonly value: string }
	| { readonly kind: "unknown-github"; readonly argv: readonly string[] }
	| { readonly kind: "github-graphql-unknown"; readonly source: string }
	| {
			readonly kind: "shell-syntax"
			readonly issue: "syntax-error" | "missing-syntax"
			readonly text: string
			readonly startByte: number
			readonly endByte: number
	  }

export type CommandAnalysis = {
	readonly findings: readonly EffectFinding[]
	readonly observations: readonly AnalysisObservation[]
}
