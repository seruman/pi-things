import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { parseFrontmatter } from "@mariozechner/pi-coding-agent"

export type AgentScope = "user" | "project" | "both"

export interface AgentConfig {
	name: string
	description: string
	tools?: string[]
	systemPrompt: string
	source: "bundled" | "user" | "project"
	filePath: string
}

export interface AgentDiscovery {
	agents: AgentConfig[]
	projectAgentsDir: string | null
}

type Frontmatter = {
	name?: string
	description?: string
	tools?: string
}

function readAgents(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	if (!fs.existsSync(dir)) return []
	let entries: fs.Dirent[] = []
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}

	return entries
		.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.flatMap((entry) => {
			const filePath = path.join(dir, entry.name)
			let text = ""
			try {
				text = fs.readFileSync(filePath, "utf-8")
			} catch {
				return []
			}

			const { frontmatter, body } = parseFrontmatter<Frontmatter>(text)
			if (!frontmatter.name || !frontmatter.description) return []

			const tools = frontmatter.tools
				?.split(",")
				.map((tool) => tool.trim())
				.filter(Boolean)

			const agent: AgentConfig = {
				name: frontmatter.name,
				description: frontmatter.description,
				tools: tools && tools.length > 0 ? tools : undefined,
				systemPrompt: body,
				source,
				filePath,
			}
			return [agent]
		})
}

function nearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd
	while (true) {
		const candidate = path.join(dir, ".pi", "agents")
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate
		} catch {
			// ignore
		}
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

function bundledAgentsDir() {
	const file = fileURLToPath(import.meta.url)
	return path.join(path.dirname(file), "agents")
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscovery {
	const bundled = readAgents(bundledAgentsDir(), "bundled")
	const user = scope === "project" ? [] : readAgents(path.join(os.homedir(), ".pi", "agent", "agents"), "user")
	const projectAgentsDir = nearestProjectAgentsDir(cwd)
	const project = scope === "user" || !projectAgentsDir ? [] : readAgents(projectAgentsDir, "project")

	const byName = new Map<string, AgentConfig>()
	for (const agent of bundled) byName.set(agent.name, agent)
	for (const agent of user) byName.set(agent.name, agent)
	for (const agent of project) byName.set(agent.name, agent)

	return {
		agents: Array.from(byName.values()),
		projectAgentsDir,
	}
}
