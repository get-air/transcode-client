# `@get-air/transcode`

Typed Promise and Effect client for the standalone `air-transcode` GStreamer
service. It creates lazy HLS/CMAF sessions, resolves browser-facing manifest
URLs, detects browser codec capabilities, and destroys sessions when playback
finishes.

The package never runs GStreamer in JavaScript. Tauri applications can embed
the Rust crate, inject its ephemeral origin, and use this same client.

```ts
import {
  TranscodeClient,
  declaredVideoCodecs,
  detectCodecSupport,
} from "@get-air/transcode"

const codecResults = await Promise.all([
  detectCodecSupport({
    contentType: 'video/mp4; codecs="avc1.640028"',
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    framerate: 30,
  }),
  detectCodecSupport({
    contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
    width: 3840,
    height: 2160,
    bitrate: 25_000_000,
    framerate: 24,
  }),
])

const client = await TranscodeClient.connect({
  origin: "http://127.0.0.1:11471",
})
const session = await client.createSession({
  source: { url: "https://media.example/movie.mkv" },
  output: { video_codecs: declaredVideoCodecs(codecResults) },
})

video.src = client.masterUrl(session)
```

Effect applications use the same implementation:

```ts
import { Effect } from "effect"
import { makeTranscodeClient } from "@get-air/transcode/effect"

const program = Effect.gen(function* () {
  const client = yield* makeTranscodeClient({ origin })
  return yield* client.createSession(request)
})
```

`canPlayType`, MSE, and Media Capabilities results are advisory. The consuming
video router must still verify real startup and fall back when a browser
overstates support.

Networking is injected through `@get-air/http`, including Tauri transports.

## Browser example

`examples/browser` is a plain HTML URL player. It tries the regular video
element first and uses `transcodeVideoBackend()` only after direct startup
fails. Add `?mse=1` to force the hls.js/MSE path during qualification.

The qualification fixture has been exercised through both native HLS and
hls.js: VP9/Opus MKV was converted to H.264 High plus AAC-LC, reached media
ready state 4 with a 3.009-second duration, exposed buffered/seekable ranges,
and produced no failed GStreamer pipelines.
