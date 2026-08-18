import { FunctionHttpTransport } from "@get-air/http"
import { Effect, Schema } from "effect"

import {
  InvalidTranscodeOriginError,
  TranscodeHttpStatusError,
  TranscodeInvalidJsonError,
  type TranscodeClientError,
  TranscodeResponseValidationError,
  TranscodeTimeoutError,
  TranscodeTransportError,
  SourceRateLimitedError,
} from "./Errors.js"
import {
  TranscodeCapabilities as TranscodeCapabilitiesSchema,
  TranscodeMetrics as TranscodeMetricsSchema,
  TranscodeSession as TranscodeSessionSchema,
  RegisteredSource as RegisteredSourceSchema,
  WarmAudioResult as WarmAudioResultSchema,
} from "./Schemas.js"
import type {
  CreateSessionRequest,
  RegisteredSource,
  TranscodeSource,
  TranscodeCallOptions,
  TranscodeCapabilities,
  TranscodeClientOptions,
  TranscodeMetrics,
  TranscodeSession,
  WarmAudioResult,
} from "./Types.js"

const DEFAULT_TIMEOUT_MILLIS = 30_000

class TimeoutMarker extends Error {}

interface NormalizedOptions {
  readonly origin: URL
  readonly transport: NonNullable<TranscodeClientOptions["transport"]>
  readonly timeoutMillis: number
  readonly headers: Readonly<Record<string, string>>
}

const parseErrorPayload = (text: string): {
  error?: { code?: string; message?: string; retry_after_seconds?: number }
} => {
  try {
    return JSON.parse(text) as {
      error?: { code?: string; message?: string; retry_after_seconds?: number }
    }
  } catch {
    return {}
  }
}

export interface TranscodeClientShape {
  readonly origin: string
  capabilities(options?: TranscodeCallOptions): Effect.Effect<TranscodeCapabilities, TranscodeClientError>
  metrics(options?: TranscodeCallOptions): Effect.Effect<TranscodeMetrics, TranscodeClientError>
  registerSource(source: TranscodeSource, options?: TranscodeCallOptions): Effect.Effect<RegisteredSource, TranscodeClientError>
  getSource(id: string, options?: TranscodeCallOptions): Effect.Effect<RegisteredSource, TranscodeClientError>
  releaseSource(id: string, options?: TranscodeCallOptions): Effect.Effect<void, TranscodeClientError>
  createSession(
    request: CreateSessionRequest,
    options?: TranscodeCallOptions,
  ): Effect.Effect<TranscodeSession, TranscodeClientError>
  getSession(
    id: string,
    options?: TranscodeCallOptions,
  ): Effect.Effect<TranscodeSession, TranscodeClientError>
  deleteSession(id: string, options?: TranscodeCallOptions): Effect.Effect<void, TranscodeClientError>
  warmAudio(id: string, positionSeconds: number, options?: TranscodeCallOptions): Effect.Effect<WarmAudioResult, TranscodeClientError>
  masterUrl(session: Pick<TranscodeSession, "master_url">): string
  relayUrl(source: Pick<RegisteredSource, "relay_url">): string
}

const normalizeOptions = Effect.fn("TranscodeClient.normalizeOptions")(
  function* (options: TranscodeClientOptions) {
    const origin = yield* Effect.try({
      try: () => {
        const url = new URL(options.origin)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("Transcode origins must use HTTP or HTTPS")
        }
        if (url.username !== "" || url.password !== "") {
          throw new Error("Credentials in the transcode origin are not allowed")
        }
        url.pathname = "/"
        url.search = ""
        url.hash = ""
        return url
      },
      catch: (cause) => new InvalidTranscodeOriginError({
        origin: String(options.origin),
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    })
    return {
      origin,
      transport: options.transport ?? FunctionHttpTransport.global(),
      timeoutMillis: options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS,
      headers: options.headers ?? {},
    } satisfies NormalizedOptions
  },
)

const requestText = Effect.fn("TranscodeClient.requestText")(
  function* (
    options: NormalizedOptions,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    callOptions: TranscodeCallOptions,
  ) {
    const url = new URL(path, options.origin)
    const response = yield* Effect.tryPromise({
      try: async () => {
        const controller = new AbortController()
        let timedOut = false
        const abort = () => controller.abort(callOptions.signal?.reason)
        callOptions.signal?.addEventListener("abort", abort, { once: true })
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort(new TimeoutMarker())
        }, options.timeoutMillis)
        try {
          const headers = new Headers(options.headers)
          headers.set("accept", "application/json")
          if (body !== undefined) headers.set("content-type", "application/json")
          return await options.transport.fetch(new Request(url, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
          }))
        } catch (cause) {
          if (timedOut) throw new TimeoutMarker()
          throw cause
        } finally {
          clearTimeout(timer)
          callOptions.signal?.removeEventListener("abort", abort)
        }
      },
      catch: (cause) => cause instanceof TimeoutMarker
        ? new TranscodeTimeoutError({
            url: url.toString(),
            timeoutMillis: options.timeoutMillis,
            message: `Transcode request timed out after ${options.timeoutMillis}ms`,
          })
        : new TranscodeTransportError({
            url: url.toString(),
            message: cause instanceof Error ? cause.message : String(cause),
            retryable: callOptions.signal?.aborted !== true,
          }),
    })
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new TranscodeTransportError({
        url: url.toString(),
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      }),
    })
    if (!response.ok) {
      const payload = parseErrorPayload(text)
      if (response.status === 429 && payload.error?.code === "rate_limited") {
        return yield* new SourceRateLimitedError({
          url: url.toString(),
          message: payload.error.message ?? "Source is rate limited",
          ...(payload.error.retry_after_seconds === undefined
            ? {}
            : { retryAfterSeconds: payload.error.retry_after_seconds }),
        })
      }
      return yield* new TranscodeHttpStatusError({
        url: url.toString(),
        status: response.status,
        ...(payload.error?.code === undefined ? {} : { code: payload.error.code }),
        message: payload.error?.message ?? `Transcode request failed with HTTP ${response.status}`,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      })
    }
    return { url, text }
  },
)

const decodeResponse = <A, I>(
  schema: Schema.Schema<A, I, never>,
  url: URL,
  text: string,
): Effect.Effect<A, TranscodeInvalidJsonError | TranscodeResponseValidationError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new TranscodeInvalidJsonError({
      url: url.toString(),
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknown(schema)(value).pipe(
      Effect.catchTag("ParseError", (cause) => Effect.fail(new TranscodeResponseValidationError({
        url: url.toString(),
        message: String(cause),
      }))),
    )),
  )

export const makeTranscodeClient = Effect.fn("TranscodeClient.make")(
  function* (clientOptions: TranscodeClientOptions) {
    const options = yield* normalizeOptions(clientOptions)
    const requestJson = <A, I>(
      method: "GET" | "POST",
      path: string,
      schema: Schema.Schema<A, I, never>,
      body: unknown,
      callOptions: TranscodeCallOptions = {},
    ) => requestText(options, method, path, body, callOptions).pipe(
      Effect.flatMap(({ url, text }) => decodeResponse(schema, url, text)),
    )

    const capabilities = Effect.fn("TranscodeClient.capabilities")(
      (callOptions: TranscodeCallOptions = {}) => requestJson(
        "GET",
        "/v1/capabilities",
        TranscodeCapabilitiesSchema,
        undefined,
        callOptions,
      ),
    )
    const metrics = Effect.fn("TranscodeClient.metrics")(
      (callOptions: TranscodeCallOptions = {}) => requestJson(
        "GET",
        "/v1/metrics",
        TranscodeMetricsSchema,
        undefined,
        callOptions,
      ),
    )
    const registerSource = Effect.fn("TranscodeClient.registerSource")(
      (source: TranscodeSource, callOptions: TranscodeCallOptions = {}) => requestJson(
        "POST",
        "/v1/sources",
        RegisteredSourceSchema,
        source,
        callOptions,
      ),
    )
    const getSource = Effect.fn("TranscodeClient.getSource")(
      (id: string, callOptions: TranscodeCallOptions = {}) => requestJson(
        "GET",
        `/v1/sources/${encodeURIComponent(id)}`,
        RegisteredSourceSchema,
        undefined,
        callOptions,
      ),
    )
    const releaseSource = Effect.fn("TranscodeClient.releaseSource")(
      (id: string, callOptions: TranscodeCallOptions = {}) => requestText(
        options,
        "DELETE",
        `/v1/sources/${encodeURIComponent(id)}`,
        undefined,
        callOptions,
      ).pipe(Effect.asVoid),
    )
    const createSession = Effect.fn("TranscodeClient.createSession")(
      (request: CreateSessionRequest, callOptions: TranscodeCallOptions = {}) => requestJson(
        "POST",
        "/v1/sessions",
        TranscodeSessionSchema,
        request,
        callOptions,
      ),
    )
    const getSession = Effect.fn("TranscodeClient.getSession")(
      (id: string, callOptions: TranscodeCallOptions = {}) => requestJson(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}`,
        TranscodeSessionSchema,
        undefined,
        callOptions,
      ),
    )
    const deleteSession = Effect.fn("TranscodeClient.deleteSession")(
      (id: string, callOptions: TranscodeCallOptions = {}) => requestText(
        options,
        "DELETE",
        `/v1/sessions/${encodeURIComponent(id)}`,
        undefined,
        callOptions,
      ).pipe(Effect.asVoid),
    )
    const warmAudio = Effect.fn("TranscodeClient.warmAudio")(
      (id: string, positionSeconds: number, callOptions: TranscodeCallOptions = {}) => requestJson(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/warm-audio`,
        WarmAudioResultSchema,
        { position_seconds: positionSeconds },
        callOptions,
      ),
    )
    const masterUrl = (session: Pick<TranscodeSession, "master_url">): string =>
      new URL(session.master_url, options.origin).toString()
    const relayUrl = (source: Pick<RegisteredSource, "relay_url">): string =>
      new URL(source.relay_url, options.origin).toString()

    return {
      origin: options.origin.origin,
      capabilities,
      metrics,
      registerSource,
      getSource,
      releaseSource,
      createSession,
      getSession,
      deleteSession,
      warmAudio,
      masterUrl,
      relayUrl,
    } satisfies TranscodeClientShape
  },
)
