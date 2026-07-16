import { writeFile } from "node:fs/promises"
import * as path from "node:path"
import { assertFixtureExecutable } from "./fixture-executable"

export { assertFixtureExecutable } from "./fixture-executable"

export async function writeDenyNetworkFixtureExecutable(
	fixtureRoot: string,
	name: string,
	body: string,
): Promise<string> {
	const bodyPath = path.join(fixtureRoot, `${name}-body`)
	const launcherPath = path.join(fixtureRoot, name)
	assertFixtureExecutable(fixtureRoot, bodyPath)
	assertFixtureExecutable(fixtureRoot, launcherPath)
	await writeFile(bodyPath, `#!/bin/sh\n${body}`, { mode: 0o700, flag: "wx" })
	const profile = "(version 1) (allow default) (deny network*)"
	await writeFile(
		launcherPath,
		`#!/bin/sh\nexec /usr/bin/sandbox-exec -p '${profile}' '${shellQuote(bodyPath)}' \"$@\"\n`,
		{ mode: 0o700, flag: "wx" },
	)
	return launcherPath
}

function shellQuote(value: string): string {
	return value.replaceAll("'", `'"'"'`)
}
