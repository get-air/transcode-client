# `@get-air/transcode`

Typed Promise and Effect client for the standalone `air-transcode` GStreamer
service. It creates lazy HLS/CMAF sessions, resolves browser-facing manifest
URLs, detects browser codec capabilities, and destroys sessions when playback
finishes.

```ts
const source = await client.registerSource({ url })
const session = await client.createSession({ source_id: source.id })
const relayUrl = client.relayUrl(source)
// release after dependent sessions are destroyed
await client.releaseSource(source.id)
```

The package never runs GStreamer in JavaScript. Tauri applications can embed
the Rust crate, inject its ephemeral origin, and use this same client.

For an embedded `spawn_tauri_host`, inject both values returned by Rust and use
the shared Tauri HTTP adapter. The bearer token protects the loopback API from
untrusted webpages and is different from the token in cast-facing media URLs:

```ts
import { makeTauriHttpTransport } from "@get-air/http/tauri"
import { TranscodeClient } from "@get-air/transcode"

const client = await TranscodeClient.connect({
  origin: embedded.adminOrigin,
  headers: { Authorization: `Bearer ${embedded.adminToken}` },
  transport: makeTauriHttpTransport(),
})
```

The Tauri app must register `tauri-plugin-http` and scope its capability to the
ephemeral loopback origin. A typical window capability includes:

```json
{
  "identifier": "air-transcode",
  "windows": ["main"],
  "permissions": [{
    "identifier": "http:default",
    "allow": [{ "url": "http://127.0.0.1:*" }]
  }]
}
```

Keep the scope loopback-only; the separate tokenized cast URL is consumed by
the TV, not fetched through the WebView's privileged HTTP adapter.

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

`examples/browser` is a transcode-only URL player. Every source goes through
`transcodeVideoBackend()` and emerges as browser-safe H.264/AAC CMAF HLS. The
adapter defaults to 1080p unless the caller explicitly requests a larger output.
Add `?mse=1` to force hls.js/MSE when qualifying a browser with native HLS.

Before opening HLS, the adapter asks the server to generate a 12-second A/V
reserve and configures hls.js to retain a larger forward buffer during
playback. Override the reserve with `startupBufferSeconds` or the demo's
`?buffer=SECONDS` query.
Full-transcode sessions generate only the selected AAC rendition on demand so
multi-track remuxes do not block ordinary playback.

The qualification fixture has been exercised through both native HLS and
hls.js: VP9/Opus MKV was converted to H.264 High plus AAC-LC, reached media
ready state 4 with a 3.009-second duration, exposed buffered/seekable ranges,
and produced no failed GStreamer pipelines.
