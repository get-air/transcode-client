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
  const declaration = {
    contentType: probe.contentType,
    ...(probe.width === undefined ? {} : { width: probe.width }),
    ...(probe.height === undefined ? {} : { height: probe.height }),
    ...(probe.hdrFormat === undefined ? {} : { hdrFormat: probe.hdrFormat }),
  }
  if (typeof document === "undefined") {
    return {
      ...declaration,
      canPlayType: "",
      mediaSource: false,
    }
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
    return {
      ...declaration,
      canPlayType,
      mediaSource,
    }
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
        ...(probe.colorGamut === undefined ? {} : { colorGamut: probe.colorGamut }),
        ...(probe.transferFunction === undefined ? {} : {
          transferFunction: probe.transferFunction,
        }),
        ...(probe.hdrMetadataType === undefined ? {} : {
          hdrMetadataType: probe.hdrMetadataType,
        }),
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
      ...declaration,
      canPlayType,
      mediaSource,
      supported: result.supported,
      smooth: result.smooth,
      powerEfficient: result.powerEfficient,
    }
  } catch {
    return {
      ...declaration,
      canPlayType,
      mediaSource,
    }
  }
}

export function declaredHdrFormats(results: readonly CodecSupport[]): string[] {
  const formats = new Set<string>()
  for (const result of results) {
    if (result.hdrFormat === undefined
      || result.supported !== true
      || result.smooth === false) continue
    formats.add(result.hdrFormat.toLowerCase())
  }
  return [...formats]
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

/** Maximum dimensions from probes the browser reports as supported and smooth. */
export function declaredVideoDimensions(results: readonly CodecSupport[]): {
  maxWidth: number
  maxHeight: number
} {
  let maxWidth = 1920
  let maxHeight = 1080
  for (const result of results) {
    if (result.supported !== true || result.smooth === false
      || result.width === undefined || result.height === undefined) continue
    if (result.width * result.height <= maxWidth * maxHeight) continue
    maxWidth = result.width
    maxHeight = result.height
  }
  return { maxWidth, maxHeight }
}
