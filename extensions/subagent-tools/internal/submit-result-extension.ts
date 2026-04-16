import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

const Params = Type.Object(
	{
		status: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("aborted")])),
		data: Type.Optional(Type.Unknown({ description: "Structured result payload" })),
		error: Type.Optional(Type.String({ description: "Error details for aborted status" })),
	},
	{ additionalProperties: false },
)

type SubmitStatus = "success" | "aborted"

type SubmitResultDetails = {
	status: SubmitStatus
	data?: unknown
	error?: string
}

function formatPreview(details: SubmitResultDetails) {
	if (details.status === "aborted") {
		return `submit_result: aborted${details.error ? ` (${details.error})` : ""}`
	}
	if (details.data === undefined || details.data === null) {
		return "submit_result: success"
	}
	if (typeof details.data === "string") {
		return `submit_result: success (${details.data.slice(0, 120)})`
	}
	return "submit_result: success (structured data)"
}

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof Params, SubmitResultDetails>({
		name: "submit_result",
		label: "Submit Result",
		description: "Finalize delegated subagent work with structured output. Call exactly once when done.",
		parameters: Params,
		async execute(_toolCallId, params) {
			const status: SubmitStatus = params.status === "aborted" ? "aborted" : "success"
			const details: SubmitResultDetails = {
				status,
				...(params.data !== undefined ? { data: params.data } : {}),
				...(params.error ? { error: params.error } : {}),
			}

			if (status === "aborted" && !details.error) {
				return {
					content: [{ type: "text", text: "submit_result aborted requires error" }],
					details,
					isError: true,
				}
			}

			return {
				content: [{ type: "text", text: formatPreview(details) }],
				details,
			}
		},
	})
}
