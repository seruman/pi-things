import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Run a test inside a uniquely named direct child of the OS temp directory.
 * Cleanup refuses to recurse unless the path still has exactly that shape.
 */
function createGuardedTestDirectory(
	prefix: string,
	parent: string = fs.realpathSync.native(os.tmpdir()),
): { readonly root: string; readonly cleanup: () => void } {
	assert.match(prefix, /^[A-Za-z0-9-]+-$/)
	const tempRoot = fs.realpathSync.native(parent)
	const root = fs.mkdtempSync(path.join(tempRoot, prefix))
	return {
		root,
		cleanup: () => {
			assert.equal(path.dirname(root), tempRoot)
			assert.ok(path.basename(root).startsWith(prefix))
			fs.rmSync(root, { recursive: true, force: true })
		},
	}
}

export function withTestTempDirectory<T>(prefix: string, run: (root: string) => T): T {
	const directory = createGuardedTestDirectory(prefix)
	try {
		return run(directory.root)
	} finally {
		directory.cleanup()
	}
}

export function withPrivateTmpDirectory<T>(prefix: string, run: (root: string) => T): T {
	const directory = createGuardedTestDirectory(prefix, "/private/tmp")
	try {
		return run(directory.root)
	} finally {
		directory.cleanup()
	}
}

export async function withTestTempDirectoryAsync<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
	const directory = createGuardedTestDirectory(prefix)
	try {
		return await run(directory.root)
	} finally {
		directory.cleanup()
	}
}
