import type { ChildProcess } from "node:child_process"

export type SubagentStatus = "running" | "completed" | "failed" | "timeout" | "stopped"

export interface SubagentEntry {
	agentId: string
	pid: number
	taskId?: string
	process: ChildProcess
	status: SubagentStatus
	exitCode?: number
	stdout: string
	stderr: string
	startedAt: number
	endedAt?: number
	timeout: number
	timeoutTimer?: ReturnType<typeof setTimeout>
	model?: string
	/** Path to output file on disk */
	outputFile?: string
}

export type SubagentAction = "spawn" | "status" | "output" | "stop" | "list"

export interface SubagentSpawnInput {
	action: "spawn"
	prompt: string
	taskId?: string
	background?: boolean
	systemPrompt?: string
	model?: string
	thinking?: string
	maxTurns?: number
	timeout?: number
}

export interface SubagentStatusInput {
	action: "status"
	agentId: string
}

export interface SubagentOutputInput {
	action: "output"
	agentId: string
	block?: boolean
	timeout?: number
}

export interface SubagentStopInput {
	action: "stop"
	agentId: string
}

export interface SubagentListInput {
	action: "list"
}

export type SubagentToolInput =
	| SubagentSpawnInput
	| SubagentStatusInput
	| SubagentOutputInput
	| SubagentStopInput
	| SubagentListInput

export interface SubagentSpawnBlockingResult {
	action: "spawn"
	agentId: string
	pid: number
	exitCode: number
	output: string
	error?: string
	durationMs: number
	taskId?: string
	outputFile?: string
}

export interface SubagentSpawnBackgroundResult {
	action: "spawn"
	agentId: string
	pid: number
	taskId?: string
	status: "running"
	outputFile?: string
}

export interface SubagentStatusResult {
	action: "status"
	agentId: string
	status: SubagentStatus
	exitCode?: number
	durationMs?: number
	taskId?: string
	pid: number
	outputFile?: string
}

export interface SubagentOutputResult {
	action: "output"
	agentId: string
	status: SubagentStatus
	output: string
	error?: string
	exitCode?: number
	ready: boolean
	pid: number
	outputFile?: string
}

export interface SubagentStopResult {
	action: "stop"
	agentId: string
	status: "stopped"
	output?: string
	pid: number
}

export interface SubagentListResult {
	action: "list"
	agents: Array<{
		agentId: string
		status: SubagentStatus
		taskId?: string
		durationMs?: number
		exitCode?: number
		pid: number
		model?: string
	}>
}

export interface SubagentErrorResult {
	action: SubagentAction
	error: string
}

export type SubagentToolResult =
	| SubagentSpawnBlockingResult
	| SubagentSpawnBackgroundResult
	| SubagentStatusResult
	| SubagentOutputResult
	| SubagentStopResult
	| SubagentListResult
	| SubagentErrorResult
