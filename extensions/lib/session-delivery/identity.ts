import { z } from "zod"

export const sessionIdSchema = z.string().brand<"SessionId">()

export type SessionId = z.infer<typeof sessionIdSchema>

export const instanceIdSchema = z.string().uuid().brand<"InstanceId">()

export type InstanceId = z.infer<typeof instanceIdSchema>

export const relationIdSchema = z.string().uuid().brand<"RelationId">()

export type RelationId = z.infer<typeof relationIdSchema>

export const runHandleSchema = z.string().brand<"RunHandle">()

export type RunHandle = z.infer<typeof runHandleSchema>

export const messageIdSchema = z.string().uuid().brand<"MessageId">()

export type MessageId = z.infer<typeof messageIdSchema>

export const membershipGenerationSchema = z.string().uuid().brand<"MembershipGeneration">()

export type MembershipGeneration = z.infer<typeof membershipGenerationSchema>
