import { expect, test } from "bun:test"
import type { InstanceId, RelationId, RunHandle, SessionId } from "../lib/session-delivery/identity"
import type { FamilyRoute, Message, SessionMailbox } from "../lib/session-delivery/mailbox"
import { workStatus } from "../lib/session-delivery/mailbox"
import type { DeliveryService } from "../lib/session-delivery/runtime"
import { readCompletion, type Completion, type CompletionInvocation } from "./completion"
import { ownedRun } from "./family"

type Assert<T extends true> = T

type Assignable<A, B> = [A] extends [B] ? true : false

type Not<T extends boolean> = T extends true ? false : true

type Owner = Parameters<typeof ownedRun>[0]

type Target = Parameters<DeliveryService["send"]>[0]

type MailboxTarget = Parameters<SessionMailbox["send"]>[0]

type StatusInstance = NonNullable<Parameters<typeof workStatus>[0]["instanceId"]>

type CompletionMessage = Extract<Message, { route: { kind: "completion" } }>

type OrdinaryMessage = Extract<Message, { route: { kind: "pool" | "family" } }>

type Stage = Parameters<DeliveryService["stageCompletion"]>[0]

type Proof = [
	Assert<Assignable<RunHandle, Owner["handle"]>>,
	Assert<Assignable<SessionId, Owner["parentSessionId"]>>,
	Assert<Not<Assignable<SessionId, Owner["handle"]>>>,
	Assert<Not<Assignable<RunHandle, Owner["parentSessionId"]>>>,
	Assert<Assignable<SessionId, Target>>,
	Assert<Not<Assignable<RunHandle, Target>>>,
	Assert<Not<Assignable<RelationId, MailboxTarget>>>,
	Assert<Assignable<InstanceId, StatusInstance>>,
	Assert<Not<Assignable<RelationId, StatusInstance>>>,
	Assert<Not<Assignable<InstanceId, FamilyRoute["relation"]>>>,
	Assert<Not<Assignable<SessionId, Completion["handle"]>>>,
	Assert<Not<Assignable<InstanceId, Completion["relation"]>>>,
	Assert<Not<Assignable<SessionId, Parameters<CompletionInvocation["reserve"]>[0]>>>,
	Assert<Assignable<RelationId, CompletionMessage["from"]["instanceId"]>>,
	Assert<Assignable<OrdinaryMessage["from"]["instanceId"], StatusInstance>>,
	Assert<Not<Assignable<InstanceId, CompletionMessage["from"]["instanceId"]>>>,
	Assert<Not<Assignable<CompletionMessage["from"]["instanceId"], StatusInstance>>>,
	Assert<Not<Assignable<"instanceId", keyof Stage["from"]>>>,
]

const proof: Proof = [
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
]

function positiveCalls(
	owner: Owner,
	service: DeliveryService,
	mailbox: SessionMailbox,
	target: SessionId,
	instance: InstanceId,
	route: FamilyRoute,
	completion: Completion,
	invocation: CompletionInvocation,
	stage: Stage,
) {
	ownedRun(owner)
	service.send(target, "hello", "steer", route)
	mailbox.send(target, "hello", "steer", route)
	workStatus({ sessionId: target, instanceId: instance })
	readCompletion(completion)
	invocation.reserve(completion.handle)
	service.stageCompletion(stage)
}

test("identity API types retain distinct categories", () => {
	expect(proof.every(Boolean)).toBe(true)
	expect(positiveCalls).toBeFunction()
})
