import { z } from "zod";

export const CredentialsSchema = z.object({
  token: z.string().min(1),
  projectId: z.string().min(1),
});

export const CredentialsJsonSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_json" });
      return z.NEVER;
    }
  })
  .pipe(CredentialsSchema);

export const GoogleRpcErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const GoogleRpcErrorJsonSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_json" });
      return z.NEVER;
    }
  })
  .pipe(GoogleRpcErrorSchema);

const TextPartSchema = z
  .object({
    text: z.string().optional(),
  })
  .passthrough();

const GroundingChunkSchema = z
  .object({
    web: z
      .object({
        title: z.string().optional(),
        uri: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

const GroundingSupportSchema = z
  .object({
    segment: z
      .object({
        startIndex: z.number().optional(),
        endIndex: z.number().optional(),
        text: z.string().optional(),
      })
      .optional(),
    groundingChunkIndices: z.array(z.number()).optional(),
  })
  .passthrough();

const UrlMetadataItemSchema = z
  .object({
    urlRetrievalStatus: z.string().optional(),
    url_retrieval_status: z.string().optional(),
  })
  .passthrough();

const CandidateSchema = z
  .object({
    content: z
      .object({
        parts: z.array(TextPartSchema).optional(),
      })
      .optional(),
    groundingMetadata: z
      .object({
        groundingChunks: z.array(GroundingChunkSchema).optional(),
        groundingSupports: z.array(GroundingSupportSchema).optional(),
      })
      .optional(),
    urlContextMetadata: z
      .object({
        urlMetadata: z.array(UrlMetadataItemSchema).optional(),
      })
      .optional(),
    url_context_metadata: z
      .object({
        url_metadata: z.array(UrlMetadataItemSchema).optional(),
      })
      .optional(),
  })
  .passthrough();

const CloudCodeAssistPayloadSchema = z
  .object({
    candidates: z.array(CandidateSchema).optional(),
  })
  .passthrough();

const CloudCodeAssistEnvelopeSchema = z
  .object({
    response: CloudCodeAssistPayloadSchema,
    traceId: z.string().optional(),
  })
  .passthrough();

export type GeminiSubscriptionCredentials = z.infer<typeof CredentialsSchema>;
export type GroundingChunk = z.infer<typeof GroundingChunkSchema>;
export type GroundingSupport = z.infer<typeof GroundingSupportSchema>;
export type UrlMetadataItem = z.infer<typeof UrlMetadataItemSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type CloudCodeAssistPayload = z.infer<typeof CloudCodeAssistPayloadSchema>;

function schemaIssueSummary(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "unknown schema mismatch";
  const at = first.path.length ? ` at ${first.path.join(".")}` : "";
  return `${first.message}${at}`;
}

export function parseCloudCodeAssistPayload(value: unknown): CloudCodeAssistPayload {
  const envelope = CloudCodeAssistEnvelopeSchema.safeParse(value);
  if (envelope.success) return envelope.data.response;

  const direct = CloudCodeAssistPayloadSchema.safeParse(value);
  if (direct.success) return direct.data;

  throw new Error(
    `Invalid Cloud Code Assist response envelope: ${schemaIssueSummary(envelope.error)}; direct payload: ${schemaIssueSummary(direct.error)}`,
  );
}

export function extractGoogleRpcErrorMessage(bodyText: string): string {
  const validated = GoogleRpcErrorJsonSchema.safeParse(bodyText);
  return validated.success ? validated.data.error?.message ?? bodyText : bodyText;
}
