// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"

import type { TranscodeSession } from "../src/Types.js"
import {
  shouldUseNativeHls,
  transcodeRelayHttpTransport,
  transcodeVideoBackend,
  type TranscodeSessionClient,
} from "../src/video.js"

const session: TranscodeSession = {
  id: "6a22f5cf-823a-40ee-85d3-f656b63f4c85",
  source_id: "b30b2687-981f-4531-a0c7-ee96780bf088",
  duration_ns: 8_000_000_000,
  seekable: true,
  tracks: [],
  renditions: [
    {
      kind: "video", source_track_index: 0, name: "Video", language: null,
      default: true, mode: "transmux", output_codec: "avc1.640028", hdr_passthrough: false,
    },
    {
      kind: "audio", source_track_index: 1, name: "English", language: "en",
      default: true, mode: "transcode", output_codec: "mp4a.40.2", hdr_passthrough: false,
    },
    {
      kind: "audio", source_track_index: 2, name: "Spanish", language: "es",
      default: false, mode: "transcode", output_codec: "mp4a.40.2", hdr_passthrough: false,
    },
  ],
  master_url: "/v1/sessions/6a22f5cf-823a-40ee-85d3-f656b63f4c85/master.m3u8",
}

describe("transcode video backend", () => {
  it("relays range requests through a source-only session", async () => {
    const registerSource = vi.fn(async () => ({
      id: session.source_id,
      media: { duration_ns: 8_000_000_000, seekable: true, container: "matroska", tracks: [] },
      relay_url: `/v1/sources/${session.source_id}/relay`,
    }))
    const fetch = vi.fn(async (_request: Request) => new Response("range", {
      status: 206,
      headers: { "content-range": "bytes 10-14/100" },
    }))
    const transport = transcodeRelayHttpTransport({
      origin: "http://127.0.0.1:11472",
      registerSource,
      releaseSource: vi.fn(async () => undefined),
      relayUrl: (source) => new URL(source.relay_url, "http://127.0.0.1:11472").toString(),
      createSession: vi.fn(async () => session),
      deleteSession: vi.fn(async () => undefined),
      warmAudio: vi.fn(async () => ({ sequence: 1, elapsed_ms: 0 })),
      masterUrl: () => "",
    }, { fetch })

    await transport.register({
      url: "https://media.example/movie.mkv",
      headers: { Authorization: "Bearer test" },
    })
    const response = await transport.fetch(new Request("https://media.example/movie.mkv", {
      headers: { Accept: "video/*", Authorization: "Bearer test", Range: "bytes=10-14" },
    }))
    await transport.fetch(new Request("https://media.example/movie.mkv", {
      headers: { Authorization: "Bearer test", Range: "bytes=20-24" },
    }))

    expect(response.status).toBe(206)
    expect(registerSource).toHaveBeenCalledWith({
        url: "https://media.example/movie.mkv",
        headers: { Authorization: "Bearer test" },
    }, expect.any(Object))
    expect(registerSource).toHaveBeenCalledTimes(1)
    const relayed = vi.mocked(fetch).mock.calls[0]?.[0]
    expect(relayed?.url).toBe(
      `http://127.0.0.1:11472/v1/sources/${session.source_id}/relay`,
    )
    expect(relayed?.headers.get("range")).toBe("bytes=10-14")
  })

  it("uses hls.js when native HLS cannot switch alternate audio", () => {
    const video = document.createElement("video")
    video.canPlayType = () => "probably"

    expect(shouldUseNativeHls(video, session, true)).toBe(false)
    expect(shouldUseNativeHls(video, {
      renditions: session.renditions.filter((rendition) => rendition.source_track_index !== 2),
    }, true)).toBe(true)
  })

  it("uses native HLS when available and destroys the server session", async () => {
    const client: TranscodeSessionClient = {
      origin: "http://127.0.0.1:11471",
      registerSource: vi.fn(async () => ({
        id: session.source_id,
        media: { duration_ns: 8_000_000_000, seekable: true, container: "matroska", tracks: [] },
        relay_url: `/v1/sources/${session.source_id}/relay`,
      })),
      releaseSource: vi.fn(async () => undefined),
      relayUrl: (source) => new URL(source.relay_url, "http://127.0.0.1:11471").toString(),
      createSession: vi.fn(async () => session),
      deleteSession: vi.fn(async () => undefined),
      warmAudio: vi.fn(async () => ({ sequence: 1, elapsed_ms: 0 })),
      masterUrl: () => "http://127.0.0.1:11471/v1/sessions/id/master.m3u8",
    }
    const video = document.createElement("video")
    video.canPlayType = () => "probably"
    video.load = vi.fn(() => queueMicrotask(() =>
      video.dispatchEvent(new Event("loadedmetadata"))))
    video.play = vi.fn(async () => undefined)
    video.pause = vi.fn()
    const nativeAudio = [{ enabled: true }, { enabled: false }]
    Object.defineProperty(video, "audioTracks", { value: nativeAudio })
    const adapter = transcodeVideoBackend({ client, videoCodecs: ["h264"] })

    const controller = await adapter.open({
      element: video,
      options: { source: "https://media.example/movie.mkv" },
      http: { fetch: globalThis.fetch },
    })

    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      source_id: session.source_id,
      output: {
        max_width: 1920,
        max_height: 1080,
        video_codecs: ["h264"],
        hdr_formats: [],
      },
    }), {})
    expect(video.src).toContain("/v1/sessions/id/master.m3u8")
    expect(controller.capabilities.backend).toBe("transcode")
    expect(controller.media.durationSeconds).toBe(8)
    await controller.selectTrack("audio", "audio-2")
    expect(nativeAudio).toEqual([{ enabled: false }, { enabled: true }])
    expect(controller.tracks.find((track) => track.id === "audio-2")?.selected).toBe(true)
    await controller.destroy()
    expect(client.deleteSession).toHaveBeenCalledWith(session.id)
  })
})
