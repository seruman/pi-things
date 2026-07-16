import * as path from "node:path"

export function isFixtureExecutable(fixtureRoot: string, executable: string): boolean {
	const root = path.resolve(fixtureRoot)
	const candidate = path.resolve(executable)
	const relative = path.relative(root, candidate)
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function assertFixtureExecutable(fixtureRoot: string, executable: string): void {
	if (!isFixtureExecutable(fixtureRoot, executable)) {
		throw new TypeError(`test executable is outside guarded fixture root: ${path.resolve(executable)}`)
	}
}
