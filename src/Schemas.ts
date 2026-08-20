import { Schema } from "effect"

export const VideoCodec = Schema.Literal("h264", "h265", "av1")
export const PipelineMode = Schema.Literal("transmux", "transcode")
const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)

export const MediaTrack = Schema.Struct({
  index: Schema.Number,
  stream_id: NullableString,
  kind: Schema.String,
  name: NullableString,
  codec: NullableString,
  video_codec: Schema.NullOr(VideoCodec),
  rfc6381_codec: NullableString,
  caps: NullableString,
  bit_depth: NullableNumber,
  colorimetry: NullableString,
  hdr_format: NullableString,
  language: NullableString,
  width: NullableNumber,
  height: NullableNumber,
  channels: NullableNumber,
  sample_rate: NullableNumber,
  web_compatible: Schema.Boolean,
})

export const Rendition = Schema.Struct({
  kind: Schema.String,
  source_track_index: Schema.Number,
  name: Schema.String,
  language: NullableString,
  default: Schema.Boolean,
  mode: Schema.NullOr(PipelineMode),
  output_codec: NullableString,
  hdr_passthrough: Schema.Boolean,
})

export const TranscodeSession = Schema.Struct({
  id: Schema.UUID,
  source_id: Schema.UUID,
  duration_ns: Schema.Number,
  seekable: Schema.Boolean,
  tracks: Schema.Array(MediaTrack),
  renditions: Schema.Array(Rendition),
  master_url: Schema.String,
})

export const WarmSessionResult = Schema.Struct({
  sequences: Schema.Array(Schema.Number),
  elapsed_ms: Schema.Number,
})

export const RegisteredSource = Schema.Struct({
  id: Schema.UUID,
  media: Schema.Struct({
    duration_ns: Schema.Number,
    seekable: Schema.Boolean,
    container: NullableString,
    tracks: Schema.Array(MediaTrack),
  }),
  relay_url: Schema.String,
})

export const EncoderCandidate = Schema.Struct({
  element: Schema.String,
  hardware: Schema.Boolean,
  rank: Schema.Number,
})

export const TranscodeCapabilities = Schema.Struct({
  gstreamer_version: Schema.String,
  cmaf: Schema.Boolean,
  hls_cmaf: Schema.Boolean,
  http: Schema.Boolean,
  transmux_video_codecs: Schema.Array(VideoCodec),
  hdr_tone_mapping: Schema.String,
  subtitle_inputs: Schema.Array(Schema.String),
  subtitle_output: Schema.String,
  h264_encoders: Schema.Array(EncoderCandidate),
  aac_encoders: Schema.Array(EncoderCandidate),
})

export const TranscodeMetrics = Schema.Struct({
  active_pipelines: Schema.Number,
  peak_active_pipelines: Schema.Number,
  generated_segments: Schema.Number,
  cache_hits: Schema.Number,
  failed_pipelines: Schema.Number,
  transmux_segments: Schema.Number,
  transcode_segments: Schema.Number,
  subtitle_segments: Schema.Number,
  cancelled_pipelines: Schema.Number,
  pipeline_queue_wait_ms: Schema.Number,
  source_registrations: Schema.Number,
  deduplicated_source_registrations: Schema.Number,
  resolver_requests: Schema.Number,
  relay_requests: Schema.Number,
  cdn_range_requests: Schema.Number,
  source_rate_limited: Schema.Number,
  source_refreshes: Schema.Number,
})
