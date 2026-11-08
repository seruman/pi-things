import { sessionIdSchema } from "../../lib/session-delivery/identity"
import { PoolMailbox as SessionMailbox } from "./pool"

const root = process.argv[2]

if (!root) throw new Error("Mailbox root required")

const mailbox = new SessionMailbox({ sessionId: sessionIdSchema.parse("process-peer"), cwd: root }, root)

try {
	const deadline = Date.now() + 5000
	let received = false

	while (!received) {
		if (Date.now() > deadline) throw new Error("Peer timed out")

		for (const message of mailbox.receive((reason) => {
			throw new Error(reason)
		})) {
			mailbox.send(message.from.sessionId, `reply to ${message.id}`, "passive")
			mailbox.transition(message, { kind: "settled" })
			received = true
		}

		await Bun.sleep(5)
	}

	await Bun.stdin.text()
} finally {
	mailbox.dispose()
}
