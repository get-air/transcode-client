import { Effect, Either } from "effect"

import { makeTranscodeClient, type TranscodeClientShape } from "./Client.js"
import type { TranscodeClientError } from "./Errors.js"
import type {
  CreateSessionRequest,
  RegisteredSource,
  TranscodeSource,
  TranscodeCallOptions,
  TranscodeCapabilities,
  TranscodeClientOptions,
  TranscodeMetrics,
  TranscodeSession,
  WarmSessionResult,
} from "./Types.js"

export interface PublicTranscodeError extends Error {
  readonly _tag: TranscodeClientError["_tag"]
  readonly url?: string
  readonly status?: number
  readonly code?: string
  readonly retryable?: boolean
  readonly timeoutMillis?: number
  readonly retryAfterSeconds?: number
}

export const isTranscodeError = (value: unknown): value is PublicTranscodeError =>
  value instanceof Error && "_tag" in value && typeof value._tag === "string"

const publicError = (failure: TranscodeClientError): PublicTranscodeError => {
  const error = new Error(failure.message) as PublicTranscodeError
  error.name = failure._tag
  Object.assign(error, failure)
  return error
}

const run = async <A>(effect: Effect.Effect<A, TranscodeClientError>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect))
  if (Either.isLeft(result)) throw publicError(result.left)
  return result.right
}

/** Plain Promise facade over the Effect-native client. */
export class TranscodeClient {
  private constructor(private readonly client: TranscodeClientShape) {}

  static async connect(options: TranscodeClientOptions): Promise<TranscodeClient> {
    return new TranscodeClient(await run(makeTranscodeClient(options)))
  }

  get origin(): string { return this.client.origin }

  capabilities(options?: TranscodeCallOptions): Promise<TranscodeCapabilities> {
    return run(this.client.capabilities(options))
  }

  metrics(options?: TranscodeCallOptions): Promise<TranscodeMetrics> {
    return run(this.client.metrics(options))
  }

  registerSource(source: TranscodeSource, options?: TranscodeCallOptions): Promise<RegisteredSource> {
    return run(this.client.registerSource(source, options))
  }

  getSource(id: string, options?: TranscodeCallOptions): Promise<RegisteredSource> {
    return run(this.client.getSource(id, options))
  }

  releaseSource(id: string, options?: TranscodeCallOptions): Promise<void> {
    return run(this.client.releaseSource(id, options))
  }

  relayUrl(source: Pick<RegisteredSource, "relay_url">): string {
    return this.client.relayUrl(source)
  }

  createSession(
    request: CreateSessionRequest,
    options?: TranscodeCallOptions,
  ): Promise<TranscodeSession> {
    return run(this.client.createSession(request, options))
  }

  getSession(id: string, options?: TranscodeCallOptions): Promise<TranscodeSession> {
    return run(this.client.getSession(id, options))
  }

  deleteSession(id: string, options?: TranscodeCallOptions): Promise<void> {
    return run(this.client.deleteSession(id, options))
  }

  warmSession(
    id: string,
    positionSeconds: number,
    bufferSeconds: number,
    options?: TranscodeCallOptions,
  ): Promise<WarmSessionResult> {
    return run(this.client.warmSession(id, positionSeconds, bufferSeconds, options))
  }

  masterUrl(session: Pick<TranscodeSession, "master_url">): string {
    return this.client.masterUrl(session)
  }
}
