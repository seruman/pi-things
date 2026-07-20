import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_CAPABILITIES, analyseShellCommand } from "./shell-capabilities"

test("detects direct destructive git, gh, and rm commands", () => {
	const result = analyseShellCommand("git push origin main && gh pr create --fill && rm -rf build")
	assert.deepEqual(
		result.hits.map((hit) => hit.capability),
		["git.push", "gh.pr.create", "fs.rm"],
	)
})

test("detects git checkout and restore path-discarding forms", () => {
	const checkout = analyseShellCommand("git checkout -- package.json")
	assert.equal(checkout.hits[0]?.capability, "git.checkout")
	assert.equal(checkout.hits[0]?.rule, "git.checkout.path")
	assert.equal(checkout.hits[0]?.command, "git checkout -- package.json")

	const restore = analyseShellCommand("git restore --source=HEAD -- package.json")
	assert.equal(restore.hits[0]?.capability, "git.restore")
	assert.equal(restore.hits[0]?.rule, "git.restore.source")
	assert.equal(restore.hits[0]?.command, "git restore --source=HEAD -- package.json")

	const restoreSplit = analyseShellCommand("git restore --source HEAD -- package.json")
	assert.equal(restoreSplit.hits[0]?.capability, "git.restore")
	assert.equal(restoreSplit.hits[0]?.rule, "git.restore.source")
	assert.equal(restoreSplit.hits[0]?.command, "git restore --source HEAD -- package.json")
})

test("detects nested bash -c and bash -lc commands", () => {
	const result = analyseShellCommand("bash -lc 'git reset --hard && git status' && bash -c 'git push origin main'")
	assert.deepEqual(
		result.hits.map((hit) => [hit.capability, hit.source, hit.command]),
		[
			["git.reset.hard", "top-level > bash -lc", "git reset --hard"],
			["git.push", "top-level > bash -c", "git push origin main"],
		],
	)
})

test("detects commands inside pipelines and command substitutions", () => {
	const pipeline = analyseShellCommand("echo hi | rm -rf build")
	assert.deepEqual(
		pipeline.hits.map((hit) => hit.capability),
		["fs.rm"],
	)

	const substitution = analyseShellCommand('echo "$(git push origin main)"')
	assert.deepEqual(
		substitution.hits.map((hit) => [hit.capability, hit.source]),
		[["git.push", "top-level > command-substitution"]],
	)
})

test("returns parse issues for unsupported syntax instead of pretending success", () => {
	const result = analyseShellCommand("cat <(git push origin main)")
	assert.equal(result.hits.length, 0)
	assert.equal(result.issues.length, 1)
	assert.match(result.issues[0]?.error ?? "", /Expected redirection target/)
})

test("detects more git discard and force-push forms", () => {
	for (const [input, capability, rule] of [
		["git checkout HEAD~1 -- file.txt", "git.checkout", "git.checkout.path"],
		["git checkout -- .", "git.checkout", "git.checkout.path"],
		["git checkout --ours -- file.txt", "git.checkout", "git.checkout.ours"],
		["git checkout --theirs -- file.txt", "git.checkout", "git.checkout.theirs"],
		["git restore .", "git.restore", "git.restore.path"],
		["git restore --staged file.txt", "git.restore", "git.restore.staged"],
		["git restore --source=HEAD~1 -- file.txt", "git.restore", "git.restore.source"],
		["git restore --source HEAD~1 -- file.txt", "git.restore", "git.restore.source"],
		["git reset --soft HEAD~1", "git.reset", "git.reset.soft"],
		["git reset --mixed HEAD~1", "git.reset", "git.reset.mixed"],
		["git reset --hard HEAD~1", "git.reset.hard", "git.reset.hard"],
		["git clean -f", "git.clean", "git.clean"],
		["git clean -fx", "git.clean", "git.clean"],
		["git config --global user.name Selman", "git.config.global", "git.config.global"],
		["git config --global --unset user.name", "git.config.global", "git.config.global"],
		["git push --force", "git.push.force", "git.push.force"],
		["git push -f", "git.push.force", "git.push.force"],
		["git push --force-with-lease", "git.push.force", "git.push.force-with-lease"],
		["git commit --amend", "git.commit.amend", "git.commit.amend"],
	] as const) {
		const result = analyseShellCommand(input)
		assert.equal(result.hits[0]?.capability, capability, input)
		assert.equal(result.hits[0]?.rule, rule, input)
		assert.equal(result.hits[0]?.command, input, input)
	}
})

test("detects more gh argv shapes and rm variants", () => {
	for (const [input, capability] of [
		["gh pr merge 123", "gh.pr.merge"],
		["gh pr comment 123 --body x", "gh.pr.comment"],
		["gh pr create --title x --body y", "gh.pr.create"],
		["gh issue create --title x --body y", "gh.issue.create"],
		["gh issue comment 123 --body x", "gh.issue.comment"],
		["rm file.txt", "fs.rm"],
		["rm -r build", "fs.rm"],
		["rm -rf build tmp", "fs.rm"],
	] as const) {
		const result = analyseShellCommand(input)
		assert.equal(result.hits[0]?.capability, capability, input)
	}
})

test("detects double-quoted nested shell forms and mixed nesting contexts", () => {
	for (const [input, expected] of [
		['bash -c "git checkout -- file.txt"', [["git.checkout", "top-level > bash -c", "git checkout -- file.txt"]]],
		['sh -c "git reset --hard"', [["git.reset.hard", "top-level > sh -c", "git reset --hard"]]],
		['bash -lc "gh pr create --fill"', [["gh.pr.create", "top-level > bash -lc", "gh pr create --fill"]]],
		['env X=1 bash -c "git push origin main"', [["git.push", "top-level > bash -c", "git push origin main"]]],
		['command bash -c "git reset --hard"', [["git.reset.hard", "top-level > bash -c", "git reset --hard"]]],
		["echo hi && bash -c 'rm -rf build'", [["fs.rm", "top-level > bash -c", "rm -rf build"]]],
		[
			'echo "$(git checkout -- file.txt)"',
			[["git.checkout", "top-level > command-substitution", "git checkout -- file.txt"]],
		],
		['echo "$(gh pr create --fill)"', [["gh.pr.create", "top-level > command-substitution", "gh pr create --fill"]]],
	] as const) {
		const result = analyseShellCommand(input)
		assert.deepEqual(
			result.hits.map((hit) => [hit.capability, hit.source, hit.command]),
			expected,
			input,
		)
	}
})

test("produces correct argv from glob, tilde, escaped, and brace word parts", () => {
	const glob = analyseShellCommand("rm *.txt")
	assert.equal(glob.hits[0]?.capability, "fs.rm")
	assert.equal(glob.hits[0]?.command, "rm *.txt")

	const tilde = analyseShellCommand("rm ~/tmp")
	assert.equal(tilde.hits[0]?.capability, "fs.rm")
	assert.equal(tilde.hits[0]?.command, "rm ~/tmp")

	const escaped = analyseShellCommand("rm my\\ file.txt")
	assert.equal(escaped.hits[0]?.capability, "fs.rm")
	assert.equal(escaped.hits[0]?.command, "rm my file.txt")

	const braces = analyseShellCommand("rm {a,b}.txt")
	assert.equal(braces.hits[0]?.capability, "fs.rm")
	assert.equal(braces.hits[0]?.command, "rm {...}.txt")
})

test("unparsable or partially understood commands do not block execution", () => {
	// Completely broken syntax — parse fails, no hits, only issues
	const broken = analyseShellCommand("if then else fi ((( {{{")
	assert.equal(broken.hits.length, 0)
	assert.ok(broken.issues.length > 0)

	// Unknown commands — parseable but not guarded, no hits
	for (const input of [
		"curl -X DELETE https://example.com/api/thing",
		"python -c 'import shutil; shutil.rmtree(\"/tmp/x\")'",
		'node -e \'require("fs").rmSync("/tmp/x", {recursive:true})\'',
		"rsync --delete src/ dst/",
		"docker rm -f container",
		"kubectl delete pod foo",
	]) {
		const result = analyseShellCommand(input)
		assert.equal(result.hits.length, 0, input)
		assert.equal(result.issues.length, 0, input)
	}

	// Dynamic/variable commands — argv contains placeholders, not real commands
	for (const input of ['"$CMD" --force', "${TOOL} push origin main"]) {
		const result = analyseShellCommand(input)
		assert.equal(result.hits.length, 0, input)
	}

	// Nested unparsable script — outer parses fine, nested bash -c content fails
	const nestedBroken = analyseShellCommand("bash -c 'if then else fi'")
	assert.equal(nestedBroken.hits.length, 0)
	assert.ok(nestedBroken.issues.length > 0)
	assert.match(nestedBroken.issues[0]?.source ?? "", /bash -c/)
})

test("does not flag read-only git and gh commands or plain strings", () => {
	for (const input of [
		"git status",
		"git diff",
		"git show HEAD",
		"git log --oneline",
		"git config user.name",
		"git config user.name Selman",
		"git config --local user.name Selman",
		"gh pr view 123",
		"gh issue view 123",
		"echo git push",
		"printf 'rm -rf build\n'",
	]) {
		const result = analyseShellCommand(input)
		assert.equal(result.hits.length, 0, input)
	}
})

test("default capability set stays focused on the current narrow scope", () => {
	assert.deepEqual(
		DEFAULT_CAPABILITIES.map((entry) => entry.id),
		[
			"fs.rm",
			"git.commit.amend",
			"git.checkout",
			"git.switch",
			"git.restore",
			"git.reset",
			"git.reset.hard",
			"git.clean",
			"git.config.global",
			"git.push",
			"git.push.force",
			"gh.pr.create",
			"gh.pr.comment",
			"gh.pr.merge",
			"gh.issue.create",
			"gh.issue.comment",
		],
	)
})
