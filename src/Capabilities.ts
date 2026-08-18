import type { CodecProbe, CodecSupport, VideoCodec } from "./Types.js"

const codecFamily = (contentType: string): VideoCodec | undefined => {
  const normalized = contentType.toLowerCase()
  if (normalized.includes("avc1") || normalized.includes("avc3")) return "h264"
  if (normalized.includes("hvc1") || normalized.includes("hev1")) return "h265"
  if (normalized.includes("av01")) return "av1"
  return undefined
}

/** Advisory browser capability probe; successful playback still requires startup verification. */
export async function detectCodecSupport(probe: CodecProbe): Promise<CodecSupport> {
  if (typeof document === "undefined") {
    return { contentType: probe.contentType, canPlayType: "", mediaSource: false }
  }
  const video = document.createElement("video")
  const canPlayType = video.canPlayType(probe.contentType)
  const mediaSource = typeof MediaSource !== "undefined"
    && MediaSource.isTypeSupported(probe.contentType)
  if (!navigator.mediaCapabilities?.decodingInfo
    || probe.width === undefined
    || probe.height === undefined
    || probe.bitrate === undefined
    || probe.framerate === undefined) {
    return { contentType: probe.contentType, canPlayType, mediaSource }
  }
  try {
    const result = await navigator.mediaCapabilities.decodingInfo({
      type: mediaSource ? "media-source" : "file",
      video: {
        contentType: probe.contentType,
        width: probe.width,
        height: probe.height,
        bitrate: probe.bitrate,
        framerate: probe.framerate,
      },
      ...(probe.audioContentType === undefined ? {} : {
        audio: {
          contentType: probe.audioContentType,
          channels: probe.audioChannels ?? "2",
          bitrate: probe.audioBitrate ?? 192_000,
          samplerate: probe.audioSampleRate ?? 48_000,
        },
      }),
    })
    return {
      contentType: probe.contentType,
      canPlayType,
      mediaSource,
      supported: result.supported,
      smooth: result.smooth,
      powerEfficient: result.powerEfficient,
    }
  } catch {
    return { contentType: probe.contentType, canPlayType, mediaSource }
  }
}

export function declaredVideoCodecs(results: readonly CodecSupport[]): VideoCodec[] {
  const codecs = new Set<VideoCodec>(["h264"])
  for (const result of results) {
    if (result.supported !== true || result.smooth === false) continue
    const codec = codecFamily(result.contentType)
    if (codec) codecs.add(codec)
  }
  return [...codecs]
}
