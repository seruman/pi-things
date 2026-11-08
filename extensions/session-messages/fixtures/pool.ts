import { SessionMailbox } from "../../lib/session-delivery/mailbox"

export class PoolMailbox extends SessionMailbox {
	constructor(...args: ConstructorParameters<typeof SessionMailbox>) {
		super(...args)
		this.join("test")
	}
}
