import { Schema } from "effect"

export class InvalidTranscodeOriginError extends Schema.TaggedError<InvalidTranscodeOriginError>()(
  "InvalidTranscodeOriginError",
  { origin: Schema.String, message: Schema.String },
) {}

export class TranscodeTransportError extends Schema.TaggedError<TranscodeTransportError>()(
  "TranscodeTransportError",
  { url: Schema.String, message: Schema.String, retryable: Schema.Boolean },
) {}

export class TranscodeTimeoutError extends Schema.TaggedError<TranscodeTimeoutError>()(
  "TranscodeTimeoutError",
  { url: Schema.String, timeoutMillis: Schema.Number, message: Schema.String },
) {}

export class TranscodeHttpStatusError extends Schema.TaggedError<TranscodeHttpStatusError>()(
  "TranscodeHttpStatusError",
  {
    url: Schema.String,
    status: Schema.Number,
    code: Schema.optional(Schema.String),
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export class SourceRateLimitedError extends Schema.TaggedError<SourceRateLimitedError>()(
  "SourceRateLimitedError",
  {
    url: Schema.String,
    message: Schema.String,
    retryAfterSeconds: Schema.optional(Schema.Number),
  },
) {}

export class TranscodeInvalidJsonError extends Schema.TaggedError<TranscodeInvalidJsonError>()(
  "TranscodeInvalidJsonError",
  { url: Schema.String, message: Schema.String },
) {}

export class TranscodeResponseValidationError extends Schema.TaggedError<TranscodeResponseValidationError>()(
  "TranscodeResponseValidationError",
  { url: Schema.String, message: Schema.String },
) {}

export type TranscodeClientError =
  | InvalidTranscodeOriginError
  | TranscodeTransportError
  | TranscodeTimeoutError
  | TranscodeHttpStatusError
  | SourceRateLimitedError
  | TranscodeInvalidJsonError
  | TranscodeResponseValidationError
