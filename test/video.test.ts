// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"

import type { TranscodeSession } from "../src/Types.js"
import { transcodeVideoBackend, type TranscodeSessionClient } from "../src/video.js"

const session: TranscodeSession = {
  id: "6a22f5cf-823a-40ee-85d3-f656b63f4c85",
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
  ],
  master_url: "/v1/sessions/6a22f5cf-823a-40ee-85d3-f656b63f4c85/master.m3u8",
}

describe("transcode video backend", () => {
  it("uses native HLS when available and destroys the server session", async () => {
    const client: TranscodeSessionClient = {
      createSession: vi.fn(async () => session),
      deleteSession: vi.fn(async () => undefined),
      masterUrl: () => "http://127.0.0.1:11471/v1/sessions/id/master.m3u8",
    }
    const video = document.createElement("video")
    video.canPlayType = () => "probably"
    video.load = vi.fn(() => queueMicrotask(() =>
      video.dispatchEvent(new Event("loadedmetadata"))))
    video.play = vi.fn(async () => undefined)
    video.pause = vi.fn()
    const adapter = transcodeVideoBackend({ client, videoCodecs: ["h264"] })

    const controller = await adapter.open({
      element: video,
      options: { source: "https://media.example/movie.mkv" },
      http: { fetch: globalThis.fetch },
    })

    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      source: { url: "https://media.example/movie.mkv" },
      output: { video_codecs: ["h264"] },
    }), {})
    expect(video.src).toContain("/v1/sessions/id/master.m3u8")
    expect(controller.capabilities.backend).toBe("transcode")
    expect(controller.media.durationSeconds).toBe(8)
    await controller.destroy()
    expect(client.deleteSession).toHaveBeenCalledWith(session.id)
  })
})
