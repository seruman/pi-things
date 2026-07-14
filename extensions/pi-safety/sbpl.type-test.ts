import type { CanonicalExecutable, CanonicalPath } from "./canonical-path"
import {
	type Rule,
	allowFileExtensionIssues,
	allowWebKitBrokerExtension,
	fileRule,
	fileRuleExceptProcess,
	literal,
	pathRegex,
	unixConnectRule,
} from "./sbpl"

function compileTimeFixtures(path: CanonicalPath, executable: CanonicalExecutable): void {
	// @ts-expect-error A file rule requires at least one operation.
	fileRule({ effect: "allow", operations: [], matchers: [literal(path)] })

	// @ts-expect-error A file rule requires at least one matcher.
	fileRule({ effect: "allow", operations: ["file-read*"], matchers: [] })

	// @ts-expect-error An except-process rule cannot exist without its precise exception.
	fileRuleExceptProcess({ effect: "deny", operations: ["file-write*"], matchers: [literal(path)] })

	// @ts-expect-error Raw paths cannot enter the DSL without canonical or lexical parsing.
	literal("/tmp")

	// @ts-expect-error Raw regular expressions cannot enter the DSL.
	pathRegex("^/tmp/.*$")

	// @ts-expect-error File path matchers are not valid Unix-socket endpoint matchers.
	unixConnectRule({ effect: "allow", matchers: [literal(path)] })

	// @ts-expect-error File-extension issuance must be scoped to an executable.
	allowFileExtensionIssues({
		grants: [{ extensionClass: "com.apple.app-sandbox.read", matchers: [literal(path)] }],
	})

	// @ts-expect-error Broker extension classes are a closed, source-derived set.
	allowWebKitBrokerExtension("arbitrary", executable)

	// @ts-expect-error Rules cannot be constructed as loose records outside the DSL.
	const forgedRule: Rule = { kind: "file", effect: "allow", operations: ["file-read*"], matchers: [literal(path)] }
	void forgedRule
}

void compileTimeFixtures
