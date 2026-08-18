import type { HttpTransport } from "@get-air/http"

export type VideoCodec = "h264" | "h265" | "av1"
export type RenditionKind = "video" | "audio" | "subtitle"
export type PipelineMode = "transmux" | "transcode"

export interface TranscodeSource {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface TranscodeOutputOptions {
  readonly transmux?: boolean
  readonly force_transcode?: boolean
  readonly max_width?: number
  readonly max_height?: number
  readonly video_track_index?: number
  readonly audio_track_index?: number
  readonly subtitle_track_index?: number
  readonly video_codecs?: readonly VideoCodec[]
}

export interface ExternalSubtitleRequest {
  readonly source: TranscodeSource
  readonly name: string
  readonly language?: string
  readonly offset_ms?: number
}

export interface CreateSessionRequest {
  readonly source: TranscodeSource
  readonly output?: TranscodeOutputOptions
  readonly subtitles?: readonly ExternalSubtitleRequest[]
}

export interface MediaTrack {
  readonly index: number
  readonly stream_id: string | null
  readonly kind: string
  readonly name: string | null
  readonly codec: string | null
  readonly video_codec: VideoCodec | null
  readonly rfc6381_codec: string | null
  readonly caps: string | null
  readonly bit_depth: number | null
  readonly colorimetry: string | null
  readonly hdr_format: string | null
  readonly language: string | null
  readonly width: number | null
  readonly height: number | null
  readonly channels: number | null
  readonly sample_rate: number | null
  readonly web_compatible: boolean
}

export interface Rendition {
  readonly kind: string
  readonly source_track_index: number
  readonly name: string
  readonly language: string | null
  readonly default: boolean
  readonly mode: PipelineMode | null
  readonly output_codec: string | null
  readonly hdr_passthrough: boolean
}

export interface TranscodeSession {
  readonly id: string
  readonly duration_ns: number
  readonly seekable: boolean
  readonly tracks: readonly MediaTrack[]
  readonly renditions: readonly Rendition[]
  readonly master_url: string
}

export interface EncoderCandidate {
  readonly element: string
  readonly hardware: boolean
  readonly rank: number
}

export interface TranscodeCapabilities {
  readonly gstreamer_version: string
  readonly cmaf: boolean
  readonly hls_cmaf: boolean
  readonly http: boolean
  readonly transmux_video_codecs: readonly VideoCodec[]
  readonly hdr_tone_mapping: string
  readonly subtitle_inputs: readonly string[]
  readonly subtitle_output: string
  readonly h264_encoders: readonly EncoderCandidate[]
  readonly aac_encoders: readonly EncoderCandidate[]
}

export interface TranscodeClientOptions {
  readonly origin: string | URL
  readonly transport?: HttpTransport
  readonly timeoutMillis?: number
  readonly headers?: Readonly<Record<string, string>>
}

export interface TranscodeCallOptions {
  readonly signal?: AbortSignal
}

export interface CodecProbe {
  readonly contentType: string
  readonly width?: number
  readonly height?: number
  readonly bitrate?: number
  readonly framerate?: number
  readonly audioContentType?: string
  readonly audioChannels?: string
  readonly audioBitrate?: number
  readonly audioSampleRate?: number
}

export interface CodecSupport {
  readonly contentType: string
  readonly canPlayType: CanPlayTypeResult
  readonly mediaSource: boolean
  readonly supported?: boolean
  readonly smooth?: boolean
  readonly powerEfficient?: boolean
}
