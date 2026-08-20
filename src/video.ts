import type Hls from "hls.js"
import type {
  AttachVideoOptions,
  BackendVideoController,
  MediaTrack,
  PlaybackQuality,
  PlayerCapabilities,
  SessionStats,
  TrackKind,
  VideoBackendAdapter,
  VideoControllerEventMap,
  VideoControlsTarget,
  VideoFitMode,
  VideoSource,
} from "@get-air/video"

import {
  declaredHdrFormats,
  declaredVideoCodecs,
  detectCodecSupport,
} from "./Capabilities.js"
import type {
  CreateSessionRequest,
  RegisteredSource,
  TranscodeCallOptions,
  TranscodeOutputOptions,
  TranscodeSession,
  TranscodeSource,
  VideoCodec,
} from "./Types.js"

const HLS_MIME = "application/vnd.apple.mpegurl"
const DEFAULT_STARTUP_BUFFER_SECONDS = 12
const DEFAULT_STARTUP_TIMEOUT_MILLIS = 60_000

export interface TranscodeVideoBackendOptions {
  readonly client: TranscodeSessionClient
  readonly output?: TranscodeOutputOptions
  readonly startupTimeoutMillis?: number
  /** Buffered A/V required before the controller can be played. Defaults to 12 seconds. */
  readonly startupBufferSeconds?: number
  readonly videoCodecs?: readonly VideoCodec[]
  /** Prefer platform-native HLS before hls.js/MSE. Defaults to true. */
  readonly preferNativeHls?: boolean
}

export interface TranscodeSessionClient {
  readonly origin: string
  registerSource(source: TranscodeSource, options?: TranscodeCallOptions): Promise<RegisteredSource>
  releaseSource(id: string, options?: TranscodeCallOptions): Promise<void>
  createSession(
    request: CreateSessionRequest,
    options?: TranscodeCallOptions,
  ): Promise<TranscodeSession>
  deleteSession(id: string, options?: TranscodeCallOptions): Promise<void>
  warmSession(
    id: string,
    positionSeconds: number,
    bufferSeconds: number,
    options?: TranscodeCallOptions,
  ): Promise<unknown>
  masterUrl(session: Pick<TranscodeSession, "master_url">): string
}

/** Explicit GStreamer fallback adapter for `@get-air/video`. */
export function transcodeVideoBackend(defaults: TranscodeVideoBackendOptions): VideoBackendAdapter {
  let capabilityDetection: ReturnType<typeof detectVideoCapabilities> | undefined
  return {
    id: "transcode",
    isAvailable: () => true,
    open: async ({ element, options }) => {
      const source = normalizeSource(options.source)
      const detected = await (capabilityDetection ??= detectVideoCapabilities())
      const headers = sourceHeaders(source)
      const callOptions = options.signal === undefined ? {} : { signal: options.signal }
      const registered = await defaults.client.registerSource({
        url: source.uri,
        ...(headers === undefined ? {} : { headers }),
      }, callOptions)
      let session: TranscodeSession | undefined
      try {
        const request: CreateSessionRequest = {
          source_id: registered.id,
          output: {
            ...defaults.output,
            // The universal fallback favors predictable browser playback over
            // source fidelity. Callers can explicitly request a larger encode.
            max_width: defaults.output?.max_width ?? 1920,
            max_height: defaults.output?.max_height ?? 1080,
            video_codecs: defaults.videoCodecs ?? detected.videoCodecs,
            hdr_formats: defaults.output?.hdr_formats ?? detected.hdrFormats,
          },
        }
        session = await defaults.client.createSession(request, callOptions)
        const startupBuffer = Math.max(
          0,
          defaults.startupBufferSeconds ?? DEFAULT_STARTUP_BUFFER_SECONDS,
        )
        if (startupBuffer > 0) {
          await defaults.client.warmSession(
            session.id,
            source.startPositionSeconds ?? 0,
            startupBuffer,
            callOptions,
          )
        }
      } catch (cause) {
        if (session !== undefined) {
          await defaults.client.deleteSession(session.id).catch(() => undefined)
        }
        await defaults.client.releaseSource(registered.id).catch(() => undefined)
        throw cause
      }
      const controller = new TranscodeHlsController(
        element,
        session,
        defaults.client,
        defaults.startupTimeoutMillis ?? DEFAULT_STARTUP_TIMEOUT_MILLIS,
        Math.max(0, defaults.startupBufferSeconds ?? DEFAULT_STARTUP_BUFFER_SECONDS),
        defaults.preferNativeHls ?? true,
      )
      try {
        await controller.start(defaults.client.masterUrl(session), options)
        return controller
      } catch (cause) {
        await controller.destroy().catch(() => undefined)
        throw cause
      }
    },
  }
}

class TranscodeHlsController extends EventTarget implements BackendVideoController {
  readonly sessionId: string
  readonly capabilities: PlayerCapabilities
  readonly tracks: MediaTrack[]
  readonly media: BackendVideoController["media"]
  #hls: Hls | undefined
  #destroyed = false
  #playing = false
  #lastHlsRecovery = 0
  #unsubscribers: Array<() => void> = []

  constructor(
    readonly element: HTMLVideoElement,
    private readonly session: TranscodeSession,
    private readonly client: TranscodeSessionClient,
    private readonly startupTimeoutMillis: number,
    private readonly startupBufferSeconds: number,
    private readonly preferNativeHls: boolean,
  ) {
    super()
    this.sessionId = `transcode-${session.id}`
    this.tracks = session.renditions.map(renditionTrack)
    this.media = {
      durationSeconds: session.duration_ns / 1_000_000_000,
      seekable: session.seekable,
      live: false,
      container: "hls",
      tracks: this.tracks,
      chapters: [],
    }
    this.capabilities = {
      backend: "transcode",
      containers: ["hls", "cmaf"],
      codecs: session.renditions.flatMap((rendition) =>
        rendition.output_codec === null ? [] : [rendition.output_codec]),
      drm: false,
      hdr: session.renditions.some((rendition) => rendition.hdr_passthrough),
      playbackRate: true,
      volume: true,
      videoFit: true,
      videoZoom: true,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
      customHeaders: true,
      frameAccurateSeeking: false,
    }
  }

  async start(masterUrl: string, options: AttachVideoOptions): Promise<void> {
    this.#listen(this.element, "timeupdate", () => this.#emitTime())
    this.#listen(this.element, "progress", () => this.#emitBuffer())
    this.#listen(this.element, "play", () => { this.#playing = true })
    this.#listen(this.element, "pause", () => { this.#playing = false })
    if (shouldUseNativeHls(this.element, this.session, this.preferNativeHls)) {
      await this.#startNative(masterUrl, options.signal)
    } else {
      await this.#startMse(masterUrl, options.signal)
      await waitForMedia(this.element, this.startupTimeoutMillis, options.signal)
    }
    this.#emitBuffer()
    if (options.autoplay) await this.play()
  }

  async play(): Promise<void> { await this.element.play() }
  pause(): void { this.element.pause() }
  async seek(positionSeconds: number): Promise<void> {
    this.element.currentTime = Math.max(0, positionSeconds)
  }

  async selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    const renditions = this.session.renditions.filter((rendition) => rendition.kind === kind)
    const selected = trackId === undefined
      ? -1
      : renditions.findIndex((rendition) => trackId === `${kind}-${rendition.source_track_index}`)
    if (trackId !== undefined && selected < 0) throw new Error(`Unknown ${kind} track: ${trackId}`)
    if (this.#hls && kind === "audio") this.#hls.audioTrack = selected
    else if (this.#hls && kind === "subtitle") this.#hls.subtitleTrack = selected
    else if (kind === "audio") selectNativeAudioTrack(this.element, selected)
    else if (kind === "subtitle") selectNativeSubtitleTrack(this.element, selected)
    for (const track of this.tracks) {
      if (track.kind === kind) track.selected = track.id === trackId
    }
    this.dispatchEvent(new CustomEvent("trackchange", { detail: { kind, trackId } }))
  }

  async setVolume(volume: number): Promise<void> {
    this.element.volume = Math.min(1, Math.max(0, volume))
  }
  async setPlaybackRate(rate: number): Promise<void> { this.element.playbackRate = rate }
  async setVideoFit(mode: VideoFitMode): Promise<void> {
    this.element.style.objectFit = mode === "fit" ? "contain" : mode === "cover" ? "cover" : "fill"
  }
  async setVideoZoom(scale: number): Promise<void> {
    this.element.style.transform = `scale(${Math.max(0.01, scale)})`
  }
  async stats(): Promise<SessionStats> {
    const quality = this.playbackQuality()
    const videoCodec = this.tracks.find((track) => track.kind === "video")?.codec
    const audioCodec = this.tracks.find((track) => track.kind === "audio" && track.selected)?.codec
    const stats: SessionStats = {
      sessionId: this.sessionId,
      sourceId: this.session.source_id,
      playbackMode: "transcode",
      encodedBytesBuffered: 0,
      bufferedAheadSeconds: this.bufferedAhead(),
      ...(videoCodec === undefined ? {} : { videoCodec }),
      ...(audioCodec === undefined ? {} : { audioCodec }),
      hardwareBackend: "platform",
      decodedFrameCopies: 0,
      droppedFrames: quality.droppedVideoFrames,
      visible: !this.element.hidden,
      playing: this.#playing,
    }
    return stats
  }
  bufferedAhead(): number { return bufferedAhead(this.element) }
  playbackQuality(): PlaybackQuality {
    const quality = this.element.getVideoPlaybackQuality?.()
    const total = quality?.totalVideoFrames ?? 0
    const dropped = quality?.droppedVideoFrames ?? 0
    return {
      presentedFrames: Math.max(0, total - dropped),
      mediaTimeSeconds: this.element.currentTime,
      measuredFps: 0,
      totalVideoFrames: total,
      droppedVideoFrames: dropped,
      droppedFramePercent: total === 0 ? 0 : dropped / total * 100,
    }
  }
  refreshLayout(): void { /* DOM video follows application layout */ }
  registerControls(_target: VideoControlsTarget): () => void { return () => undefined }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#hls?.destroy()
    this.#hls = undefined
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe()
    this.element.pause()
    this.element.removeAttribute("src")
    this.element.load()
    await this.client.deleteSession(this.session.id).catch(() => undefined)
    await this.client.releaseSource(this.session.source_id).catch(() => undefined)
  }

  on<K extends keyof VideoControllerEventMap>(
    type: K,
    listener: (event: VideoControllerEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): () => void {
    const eventListener = listener as EventListener
    this.addEventListener(type, eventListener, options)
    return () => this.removeEventListener(type, eventListener, options)
  }

  async #startNative(masterUrl: string, signal?: AbortSignal): Promise<void> {
    this.element.preload = "auto"
    this.element.src = masterUrl
    this.element.load()
    await waitForMedia(this.element, this.startupTimeoutMillis, signal)
  }

  async #startMse(masterUrl: string, signal?: AbortSignal): Promise<void> {
    const module = await import("hls.js")
    const HlsConstructor = module.default
    if (!HlsConstructor.isSupported()) throw new Error("HLS requires native support or hls.js MSE")
    const minimumBuffer = Math.max(12, this.startupBufferSeconds)
    const hls = new HlsConstructor({
      enableWorker: true,
      autoStartLoad: true,
      startFragPrefetch: true,
      maxBufferLength: Math.max(30, minimumBuffer * 2),
      maxMaxBufferLength: Math.max(60, minimumBuffer * 4),
      backBufferLength: 30,
      maxBufferHole: 0.5,
    })
    this.#hls = hls
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("HLS manifest startup timed out")),
        this.startupTimeoutMillis)
      const abort = () => finish(signal?.reason ?? new DOMException("HLS startup aborted", "AbortError"))
      const finish = (failure?: unknown) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        hls.off(HlsConstructor.Events.MANIFEST_PARSED, parsed)
        hls.off(HlsConstructor.Events.ERROR, failed)
        failure === undefined ? resolve() : reject(failure)
      }
      const parsed = () => finish()
      const failed = (_event: unknown, data: { fatal: boolean; details?: string }) => {
        if (data.fatal) finish(new Error(`HLS startup failed: ${data.details ?? "fatal error"}`))
      }
      signal?.addEventListener("abort", abort, { once: true })
      hls.on(HlsConstructor.Events.MANIFEST_PARSED, parsed)
      hls.on(HlsConstructor.Events.ERROR, failed)
      hls.loadSource(masterUrl)
      hls.attachMedia(this.element)
    })
    hls.on(HlsConstructor.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      const now = Date.now()
      if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR
        && now - this.#lastHlsRecovery > 5_000) {
        this.#lastHlsRecovery = now
        hls.recoverMediaError()
        return
      }
      this.dispatchEvent(new CustomEvent("error", {
        detail: {
          code: "hls_runtime_failed",
          message: `HLS playback failed: ${data.details ?? data.type}`,
        },
      }))
    })
  }

  #listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener)
    this.#unsubscribers.push(() => target.removeEventListener(type, listener))
  }
  #emitTime(): void {
    this.dispatchEvent(new CustomEvent("timeupdate", {
      detail: { currentTime: this.element.currentTime },
    }))
  }
  #emitBuffer(): void {
    this.dispatchEvent(new CustomEvent("bufferprogress", {
      detail: { bufferedAhead: this.bufferedAhead() },
    }))
  }
}

const normalizeSource = (source: string | VideoSource): VideoSource =>
  typeof source === "string" ? { uri: source } : source

const sourceHeaders = (source: VideoSource): Record<string, string> | undefined => {
  const headers = { ...source.headers }
  if (source.cookies) headers.cookie = source.cookies
  if (source.userAgent) headers["user-agent"] = source.userAgent
  if (source.referrer) headers.referer = source.referrer
  return Object.keys(headers).length === 0 ? undefined : headers
}

export function shouldUseNativeHls(
  element: HTMLVideoElement,
  session: Pick<TranscodeSession, "renditions">,
  preferred: boolean,
): boolean {
  if (!preferred || !element.canPlayType(HLS_MIME)) return false
  const audioTrackCount = session.renditions.filter((rendition) => rendition.kind === "audio").length
  return audioTrackCount <= 1 || "audioTracks" in element
}

const renditionTrack = (rendition: TranscodeSession["renditions"][number]): MediaTrack => ({
  id: `${rendition.kind}-${rendition.source_track_index}`,
  kind: rendition.kind as TrackKind,
  streamIndex: rendition.source_track_index,
  codec: rendition.output_codec ?? "",
  caps: rendition.kind === "subtitle" ? "text/vtt" : "video/mp4",
  label: rendition.name,
  ...(rendition.language === null ? {} : { language: rendition.language }),
  selected: rendition.default,
  default: rendition.default,
  forced: false,
})

interface NativeAudioTrack {
  enabled: boolean
}

interface NativeAudioTrackList {
  readonly length: number
  readonly [index: number]: NativeAudioTrack
}

const selectNativeAudioTrack = (element: HTMLVideoElement, selected: number): void => {
  const tracks = (element as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }).audioTracks
  if (!tracks || selected < 0 || selected >= tracks.length) {
    throw new Error("Native HLS audio selection is unavailable on this platform")
  }
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    if (track) track.enabled = index === selected
  }
}

const selectNativeSubtitleTrack = (element: HTMLVideoElement, selected: number): void => {
  const tracks = element.textTracks
  if (selected >= tracks.length) {
    throw new Error("Native HLS subtitle selection is unavailable on this platform")
  }
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    if (track) track.mode = index === selected ? "showing" : "disabled"
  }
}

const waitForMedia = (
  element: HTMLVideoElement,
  timeoutMillis: number,
  signal?: AbortSignal,
): Promise<void> => new Promise((resolve, reject) => {
  if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return resolve()
  const timer = setTimeout(() => finish(new Error("Native HLS startup timed out")), timeoutMillis)
  const loaded = () => finish()
  const failed = () => finish(element.error ?? new Error("Native HLS startup failed"))
  const aborted = () => finish(signal?.reason ?? new DOMException("HLS startup aborted", "AbortError"))
  const finish = (failure?: unknown) => {
    clearTimeout(timer)
    element.removeEventListener("canplay", loaded)
    element.removeEventListener("error", failed)
    signal?.removeEventListener("abort", aborted)
    failure === undefined ? resolve() : reject(failure)
  }
  element.addEventListener("canplay", loaded, { once: true })
  element.addEventListener("error", failed, { once: true })
  signal?.addEventListener("abort", aborted, { once: true })
})

const bufferedAhead = (element: HTMLMediaElement): number => {
  const current = element.currentTime
  for (let index = 0; index < element.buffered.length; index += 1) {
    if (element.buffered.start(index) <= current && element.buffered.end(index) >= current) {
      return element.buffered.end(index) - current
    }
  }
  return 0
}

async function detectVideoCapabilities(): Promise<{
  videoCodecs: VideoCodec[]
  hdrFormats: string[]
}> {
  const results = await Promise.all([
    detectCodecSupport({
      contentType: 'video/mp4; codecs="avc1.640028"',
      width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30,
    }),
    detectCodecSupport({
      contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
      width: 3840, height: 2160, bitrate: 25_000_000, framerate: 24,
    }),
    detectCodecSupport({
      contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
      width: 3840, height: 2160, bitrate: 25_000_000, framerate: 24,
      hdrFormat: "hdr10", colorGamut: "rec2020", transferFunction: "pq",
      hdrMetadataType: "smpteSt2086",
    }),
    detectCodecSupport({
      contentType: 'video/mp4; codecs="av01.0.12M.10"',
      width: 3840, height: 2160, bitrate: 18_000_000, framerate: 24,
    }),
    detectCodecSupport({
      contentType: 'video/mp4; codecs="av01.0.12M.10"',
      width: 3840, height: 2160, bitrate: 18_000_000, framerate: 24,
      hdrFormat: "hdr10", colorGamut: "rec2020", transferFunction: "pq",
      hdrMetadataType: "smpteSt2086",
    }),
  ])
  return {
    videoCodecs: declaredVideoCodecs(results),
    hdrFormats: declaredHdrFormats(results),
  }
}
