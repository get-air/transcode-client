import { FunctionHttpTransport } from "@get-air/http"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  declaredVideoCodecs,
  declaredVideoDimensions,
  declaredHdrFormats,
  isTranscodeError,
  TranscodeClient,
} from "../src/index.js"
import { makeTranscodeClient } from "../src/effect.js"

const session = {
  id: "6a22f5cf-823a-40ee-85d3-f656b63f4c85",
  source_id: "b30b2687-981f-4531-a0c7-ee96780bf088",
  duration_ns: 7_200_000_000_000,
  seekable: true,
  tracks: [{
    index: 0,
    stream_id: "video-0",
    kind: "video",
    name: null,
    codec: "video/x-h265",
    video_codec: "h265",
    rfc6381_codec: "hvc1",
    caps: "video/x-h265",
    bit_depth: 10,
    colorimetry: "bt2020",
    hdr_format: "hdr10",
    language: null,
    width: 3840,
    height: 2160,
    channels: null,
    sample_rate: null,
    web_compatible: false,
  }],
  renditions: [{
    kind: "video",
    source_track_index: 0,
    name: "video 0",
    language: null,
    default: true,
    mode: "transmux",
    output_codec: "hvc1",
    hdr_passthrough: true,
  }],
  master_url: "/v1/sessions/6a22f5cf-823a-40ee-85d3-f656b63f4c85/master.m3u8",
} as const

const capabilities = {
  gstreamer_version: "GStreamer 1.28.6",
  cmaf: true,
  hls_cmaf: true,
  http: true,
  transmux_video_codecs: ["h264", "h265", "av1"],
  hdr_tone_mapping: "unavailable",
  subtitle_inputs: ["srt", "webvtt"],
  subtitle_output: "webvtt",
  h264_encoders: [{ element: "vah264enc", hardware: true, rank: 0 }],
  aac_encoders: [{ element: "fdkaacenc", hardware: false, rank: 256 }],
} as const

const json = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  })

describe("transcode client", () => {
  it("registers one reusable source and exposes its relay URL", async () => {
    const requests: Request[] = []
    const registered = {
      id: session.source_id,
      media: {
        duration_ns: session.duration_ns,
        seekable: true,
        container: "matroska",
        tracks: session.tracks,
      },
      relay_url: `/v1/sources/${session.source_id}/relay`,
    }
    const transport = FunctionHttpTransport.from(async (request) => {
      requests.push(request)
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return json(registered)
    })
    const client = await TranscodeClient.connect({ origin: "http://127.0.0.1:11471", transport })
    const source = await client.registerSource({ url: "https://media.example/movie.mkv" })
    expect(client.relayUrl(source)).toBe(
      `http://127.0.0.1:11471/v1/sources/${session.source_id}/relay`,
    )
    await client.releaseSource(source.id)
    expect(requests.map((request) => request.method)).toEqual(["POST", "DELETE"])
  })

  it("maps server rate limits to a typed non-retrying error", async () => {
    const transport = FunctionHttpTransport.from(async () => json({
      error: {
        code: "rate_limited",
        message: "source is rate limited",
        retry_after_seconds: 42,
      },
    }, { status: 429 }))
    const client = await TranscodeClient.connect({ origin: "http://localhost:11471", transport })
    await expect(client.registerSource({ url: "https://media.example/movie.mkv" }))
      .rejects.toMatchObject({
        _tag: "SourceRateLimitedError",
        retryAfterSeconds: 42,
      })
  })

  it("creates sessions and resolves browser-facing master URLs through Promises", async () => {
    const requests: Request[] = []
    const transport = FunctionHttpTransport.from(async (request) => {
      requests.push(request)
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      if (request.url.endsWith("/v1/capabilities")) return json(capabilities)
      return json(session)
    })
    const client = await TranscodeClient.connect({
      origin: "http://127.0.0.1:11471/path?ignored=yes",
      transport,
    })

    await expect(client.capabilities()).resolves.toMatchObject({ cmaf: true })
    const created = await client.createSession({
      source: { url: "https://media.example/movie.mkv" },
      output: { video_codecs: ["h264", "h265"] },
    })
    expect(client.masterUrl(created)).toBe(
      "http://127.0.0.1:11471/v1/sessions/6a22f5cf-823a-40ee-85d3-f656b63f4c85/master.m3u8",
    )
    await client.deleteSession(created.id)
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "DELETE"])
  })

  it("preserves server error codes at the Promise boundary", async () => {
    const transport = FunctionHttpTransport.from(async () => json({
      error: { code: "media_processing_failed", message: "GStreamer could not seek" },
    }, { status: 422 }))
    const client = await TranscodeClient.connect({ origin: "http://localhost:11471", transport })

    await expect(client.createSession({
      source: { url: "https://media.example/movie.mkv" },
    })).rejects.toSatisfy(isTranscodeError)
    await expect(client.createSession({
      source: { url: "https://media.example/movie.mkv" },
    })).rejects.toMatchObject({
      _tag: "TranscodeHttpStatusError",
      status: 422,
      code: "media_processing_failed",
      retryable: false,
    })
  })

  it("exposes the same implementation as an Effect-native API", async () => {
    const transport = FunctionHttpTransport.from(async () => json(session))
    const result = await Effect.runPromise(Effect.gen(function* () {
      const client = yield* makeTranscodeClient({ origin: "http://localhost:11471", transport })
      return yield* client.getSession(session.id)
    }))
    expect(result.id).toBe(session.id)
  })

  it("rejects malformed origins with a typed Effect error", async () => {
    const result = makeTranscodeClient({ origin: "file:///tmp/socket" }).pipe(
      Effect.flip,
      Effect.map((error) => error._tag),
    )
    await expect(Effect.runPromise(result)).resolves.toBe("InvalidTranscodeOriginError")
  })
})

describe("browser capability declarations", () => {
  it("declares only supported smooth modern video codecs plus conservative H.264", () => {
    expect(declaredVideoCodecs([
      { contentType: 'video/mp4; codecs="hvc1"', canPlayType: "probably", mediaSource: true,
        supported: true, smooth: true, powerEfficient: true },
      { contentType: 'video/mp4; codecs="av01"', canPlayType: "maybe", mediaSource: true,
        supported: true, smooth: false, powerEfficient: false },
    ])).toEqual(["h264", "h265"])
  })

  it("does not advertise file-only codecs to an MSE HLS session", () => {
    expect(declaredVideoCodecs([
      { contentType: 'video/mp4; codecs="hvc1"', canPlayType: "probably", mediaSource: false,
        supported: true, smooth: true, powerEfficient: true },
    ])).toEqual(["h264"])
  })

  it("declares HDR only from a supported smooth HDR-specific probe", () => {
    expect(declaredHdrFormats([
      { contentType: 'video/mp4; codecs="hvc1"', hdrFormat: "HDR10",
        canPlayType: "probably", mediaSource: true, supported: true, smooth: true },
      { contentType: 'video/mp4; codecs="av01"', hdrFormat: "hdr10+",
        canPlayType: "maybe", mediaSource: true, supported: true, smooth: false },
    ])).toEqual(["hdr10"])
  })

  it("does not advertise file-only HDR to an MSE HLS session", () => {
    expect(declaredHdrFormats([
      { contentType: 'video/mp4; codecs="hvc1"', hdrFormat: "HDR10",
        canPlayType: "probably", mediaSource: false, supported: true, smooth: true },
    ])).toEqual([])
  })

  it("declares the largest dimensions from a supported smooth probe", () => {
    expect(declaredVideoDimensions([
      { contentType: 'video/mp4; codecs="avc1"', width: 1920, height: 1080,
        canPlayType: "probably", mediaSource: true, supported: true, smooth: true },
      { contentType: 'video/mp4; codecs="hvc1"', width: 3840, height: 2160,
        canPlayType: "probably", mediaSource: true, supported: true, smooth: true },
    ])).toEqual({ maxWidth: 3840, maxHeight: 2160 })
    expect(declaredVideoDimensions([
      { contentType: 'video/mp4; codecs="hvc1"', width: 3840, height: 2160,
        canPlayType: "probably", mediaSource: true, supported: true, smooth: false },
    ])).toEqual({ maxWidth: 1920, maxHeight: 1080 })
    expect(declaredVideoDimensions([
      { contentType: 'video/mp4; codecs="avc1"', width: 1920, height: 1080,
        canPlayType: "probably", mediaSource: true, supported: true, smooth: true },
      { contentType: 'video/mp4; codecs="av01"', width: 3840, height: 2160,
        canPlayType: "probably", mediaSource: true, supported: true, smooth: true },
    ], ["h264"])).toEqual({ maxWidth: 1920, maxHeight: 1080 })
  })
})
