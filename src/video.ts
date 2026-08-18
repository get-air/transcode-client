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

import { declaredVideoCodecs, detectCodecSupport } from "./Capabilities.js"
import type {
  CreateSessionRequest,
  TranscodeCallOptions,
  TranscodeOutputOptions,
  TranscodeSession,
  VideoCodec,
} from "./Types.js"

const HLS_MIME = "application/vnd.apple.mpegurl"

export interface TranscodeVideoBackendOptions {
  readonly client: TranscodeSessionClient
  readonly output?: TranscodeOutputOptions
  readonly startupTimeoutMillis?: number
  readonly videoCodecs?: readonly VideoCodec[]
}

export interface TranscodeSessionClient {
  createSession(
    request: CreateSessionRequest,
    options?: TranscodeCallOptions,
  ): Promise<TranscodeSession>
  deleteSession(id: string, options?: TranscodeCallOptions): Promise<void>
  masterUrl(session: Pick<TranscodeSession, "master_url">): string
}

/** Final fallback adapter for `@get-air/video` automatic routing. */
export function transcodeVideoBackend(defaults: TranscodeVideoBackendOptions): VideoBackendAdapter {
  return {
    id: "transcode",
    autoPriority: 0,
    isAvailable: () => true,
    open: async ({ element, options }) => {
      const source = normalizeSource(options.source)
      const videoCodecs = defaults.videoCodecs ?? await detectVideoCodecs()
      const headers = sourceHeaders(source)
      const request: CreateSessionRequest = {
        source: {
          url: source.uri,
          ...(headers === undefined ? {} : { headers }),
        },
        output: { ...defaults.output, video_codecs: videoCodecs },
      }
      const session = await defaults.client.createSession(request,
        options.signal === undefined ? {} : { signal: options.signal })
      const controller = new TranscodeHlsController(
        element,
        session,
        defaults.client,
        defaults.startupTimeoutMillis ?? 30_000,
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
  readonly tracks: readonly MediaTrack[]
  readonly media: BackendVideoController["media"]
  #hls: Hls | undefined
  #destroyed = false
  #playing = false
  #unsubscribers: Array<() => void> = []

  constructor(
    readonly element: HTMLVideoElement,
    private readonly session: TranscodeSession,
    private readonly client: TranscodeSessionClient,
    private readonly startupTimeoutMillis: number,
  ) {
    super()
    this.sessionId = `transcode-${session.id}`
    this.tracks = session.renditions.map(renditionTrack)
    this.media = {
      durationSeconds: session.duration_ns / 1_000_000_000,
      seekable: session.seekable,
      live: false,
      container: "hls",
      tracks: [...this.tracks],
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
    if (this.element.canPlayType(HLS_MIME)) await this.#startNative(masterUrl, options.signal)
    else await this.#startMse(masterUrl, options.signal)
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
    else if (kind === "audio" || kind === "subtitle") {
      throw new Error(`Native HLS ${kind} selection is controlled by the platform player`)
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
    const audioCodec = this.tracks.find((track) => track.kind === "audio")?.codec
    return {
      sessionId: this.sessionId,
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
  }
  bufferedAhead(): number {
    const current = this.element.currentTime
    for (let index = 0; index < this.element.buffered.length; index += 1) {
      if (this.element.buffered.start(index) <= current && this.element.buffered.end(index) >= current) {
        return this.element.buffered.end(index) - current
      }
    }
    return 0
  }
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
    this.element.preload = "metadata"
    this.element.src = masterUrl
    this.element.load()
    await waitForMedia(this.element, this.startupTimeoutMillis, signal)
  }

  async #startMse(masterUrl: string, signal?: AbortSignal): Promise<void> {
    const module = await import("hls.js")
    const HlsConstructor = module.default
    if (!HlsConstructor.isSupported()) throw new Error("HLS requires native support or hls.js MSE")
    const hls = new HlsConstructor({ enableWorker: true })
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

const waitForMedia = (
  element: HTMLVideoElement,
  timeoutMillis: number,
  signal?: AbortSignal,
): Promise<void> => new Promise((resolve, reject) => {
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve()
  const timer = setTimeout(() => finish(new Error("Native HLS startup timed out")), timeoutMillis)
  const loaded = () => finish()
  const failed = () => finish(element.error ?? new Error("Native HLS startup failed"))
  const aborted = () => finish(signal?.reason ?? new DOMException("HLS startup aborted", "AbortError"))
  const finish = (failure?: unknown) => {
    clearTimeout(timer)
    element.removeEventListener("loadedmetadata", loaded)
    element.removeEventListener("error", failed)
    signal?.removeEventListener("abort", aborted)
    failure === undefined ? resolve() : reject(failure)
  }
  element.addEventListener("loadedmetadata", loaded, { once: true })
  element.addEventListener("error", failed, { once: true })
  signal?.addEventListener("abort", aborted, { once: true })
})

async function detectVideoCodecs(): Promise<VideoCodec[]> {
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
      contentType: 'video/mp4; codecs="av01.0.12M.10"',
      width: 3840, height: 2160, bitrate: 18_000_000, framerate: 24,
    }),
  ])
  return declaredVideoCodecs(results)
}
