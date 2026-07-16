import { expect, test } from "bun:test"
import { githubOperationIds } from "./github-operations"
import { describeRemoteOperationPolicy } from "./operation-policy"

test("remote policy description includes every guarded operation in stable order", () => {
	const description = describeRemoteOperationPolicy()
	const operations = ["git.push", "git.push.force", "git.push.delete", ...githubOperationIds()]
	for (const operation of operations) expect(description).toContain(`  ${operation}`)
	for (let index = 1; index < operations.length; index++) {
		expect(description.indexOf(`  ${operations[index - 1]}`)).toBeLessThan(
			description.indexOf(`  ${operations[index]}`),
		)
	}
})
