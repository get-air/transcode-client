import type Hls from "hls.js"
import type { HttpTransport } from "@get-air/http"
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
  declaredVideoDimensions,
  detectCodecSupport,
} from "./Capabilities.js"
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
  /** Prefer platform-native HLS before hls.js/MSE. Defaults to true. */
  readonly preferNativeHls?: boolean
}

export interface TranscodeSessionClient {
  createSession(
    request: CreateSessionRequest,
    options?: TranscodeCallOptions,
  ): Promise<TranscodeSession>
  deleteSession(id: string, options?: TranscodeCallOptions): Promise<void>
  masterUrl(session: Pick<TranscodeSession, "master_url">): string
}

export interface TranscodeRelayClient extends TranscodeSessionClient {
  readonly origin: string
}

/**
 * Adapts MediaBunny range requests to the transcoder's same-origin relay. The
 * source is registered once and the injected `@get-air/http` transport handles
 * every relay request, including Tauri transports.
 */
export function transcodeRelayHttpTransport(
  client: TranscodeRelayClient,
  local: HttpTransport = { fetch: (request) => globalThis.fetch(request) },
): HttpTransport {
  const relays = new Map<string, Promise<string>>()
  return {
    fetch: async (request) => {
      const sourceHeaders = new Headers(request.headers)
      sourceHeaders.delete("range")
      sourceHeaders.delete("if-range")
      const key = JSON.stringify([request.url, [...sourceHeaders].sort()])
      let relay = relays.get(key)
      if (!relay) {
        relay = client.createSession({
          source: { url: request.url, headers: Object.fromEntries(sourceHeaders) },
          relay_only: true,
        }).then((session) => new URL(
          `/v1/sessions/${encodeURIComponent(session.id)}/source`,
          client.origin,
        ).toString())
        relays.set(key, relay)
      }
      const relayHeaders = new Headers()
      for (const name of ["range", "if-range"] as const) {
        const value = request.headers.get(name)
        if (value !== null) relayHeaders.set(name, value)
      }
      return local.fetch(new Request(await relay, {
        method: request.method,
        headers: relayHeaders,
        signal: request.signal,
      }))
    },
  }
}

/** Final fallback adapter for `@get-air/video` automatic routing. */
export function transcodeVideoBackend(defaults: TranscodeVideoBackendOptions): VideoBackendAdapter {
  return {
    id: "transcode",
    autoPriority: 0,
    isAvailable: () => true,
    open: async ({ element, options }) => {
      const source = normalizeSource(options.source)
      const detected = await detectVideoCapabilities()
      const videoCodecs = defaults.videoCodecs ?? detected.videoCodecs
      const headers = sourceHeaders(source)
      const request: CreateSessionRequest = {
        source: {
          url: source.uri,
          ...(headers === undefined ? {} : { headers }),
        },
        output: {
          ...defaults.output,
          max_width: defaults.output?.max_width ?? detected.maxWidth,
          max_height: defaults.output?.max_height ?? detected.maxHeight,
          video_codecs: videoCodecs,
          hdr_formats: defaults.output?.hdr_formats ?? detected.hdrFormats,
        },
      }
      const callOptions = options.signal === undefined ? {} : { signal: options.signal }
      let session: TranscodeSession
      try {
        session = await defaults.client.createSession(request, callOptions)
      } catch {
        return openHybridController(element, request, defaults, options)
      }
      const controller = new TranscodeHlsController(element, session, defaults.client,
        defaults.startupTimeoutMillis ?? 30_000, defaults.preferNativeHls ?? true)
      try {
        await controller.start(defaults.client.masterUrl(session), options)
        return controller
      } catch (cause) {
        await controller.destroy().catch(() => undefined)
        try {
          return await openHybridController(element, request, defaults, options)
        } catch {
          throw cause
        }
      }
    },
  }
}

async function openHybridController(
  element: HTMLVideoElement,
  request: CreateSessionRequest,
  defaults: TranscodeVideoBackendOptions,
  options: AttachVideoOptions,
): Promise<BackendVideoController> {
  const session = await defaults.client.createSession({
    source: request.source,
    relay_only: true,
  }, options.signal === undefined ? {} : { signal: options.signal })
  const relaySource = new URL(
    `/v1/sessions/${encodeURIComponent(session.id)}/source`,
    defaults.client.masterUrl(session),
  ).toString()
  const controller = new HybridVideoController(
    element,
    relaySource,
    session,
    defaults.client,
    defaults.startupTimeoutMillis ?? 30_000,
  )
  try {
    await controller.start(options)
    return controller
  } catch (cause) {
    await controller.destroy().catch(() => undefined)
    throw cause
  }
}

class HybridVideoController extends EventTarget implements BackendVideoController {
  readonly sessionId: string
  readonly tracks: MediaTrack[]
  readonly media: BackendVideoController["media"]
  readonly capabilities: PlayerCapabilities
  #audio: HTMLAudioElement
  #hls: Hls | undefined
  #playing = false
  #destroyed = false
  #unsubscribers: Array<() => void> = []

  constructor(
    readonly element: HTMLVideoElement,
    private readonly source: string,
    private readonly session: TranscodeSession,
    private readonly client: TranscodeSessionClient,
    private readonly startupTimeoutMillis: number,
  ) {
    super()
    this.sessionId = `hybrid-${session.id}`
    this.#audio = element.ownerDocument.createElement("audio")
    this.#audio.hidden = true
    element.parentElement?.append(this.#audio)
    this.tracks = session.renditions
      .filter((rendition) => rendition.kind === "audio")
      .map(renditionTrack)
    const video = session.tracks.find((track) => track.kind === "video")
    if (video) {
      this.tracks.unshift({
        id: `video-${video.index}`,
        kind: "video",
        streamIndex: video.index,
        codec: video.rfc6381_codec ?? video.codec ?? "",
        caps: video.caps ?? "",
        label: video.name ?? "Native video",
        selected: true,
        default: true,
        forced: false,
        ...(video.width === null ? {} : { width: video.width }),
        ...(video.height === null ? {} : { height: video.height }),
      })
    }
    this.media = {
      durationSeconds: session.duration_ns / 1_000_000_000,
      seekable: session.seekable,
      live: false,
      container: "hybrid",
      tracks: this.tracks,
      chapters: [],
    }
    this.capabilities = {
      backend: "transcode",
      containers: ["native", "hls", "cmaf"],
      codecs: this.tracks.map((track) => track.codec).filter(Boolean),
      drm: false,
      hdr: session.tracks.some((track) => track.hdr_format !== null),
      playbackRate: true,
      volume: true,
      videoFit: true,
      videoZoom: true,
      audioTrackSelection: true,
      subtitleTrackSelection: false,
      customHeaders: false,
      frameAccurateSeeking: false,
    }
  }

  async start(options: AttachVideoOptions): Promise<void> {
    this.element.muted = true
    this.element.preload = "auto"
    this.element.src = this.source
    this.element.load()
    await waitForMedia(this.element, this.startupTimeoutMillis, options.signal)
    const selected = this.session.renditions.find((track) =>
      track.kind === "audio" && track.default)
      ?? this.session.renditions.find((track) => track.kind === "audio")
    if (!selected) throw new Error("Hybrid playback requires an audio track")
    await this.#loadAudio(selected.source_track_index, options.signal)
    this.#listen(this.element, "timeupdate", () => {
      if (Math.abs(this.#audio.currentTime - this.element.currentTime) > 0.35) {
        this.#audio.currentTime = this.element.currentTime
      }
      this.dispatchEvent(new CustomEvent("timeupdate", {
        detail: { currentTime: this.element.currentTime },
      }))
    })
    this.#listen(this.element, "progress", () => this.dispatchEvent(new CustomEvent(
      "bufferprogress", { detail: { bufferedAhead: this.bufferedAhead() } },
    )))
    if (options.autoplay) await this.play()
  }

  async play(): Promise<void> {
    this.#playing = true
    this.#audio.currentTime = this.element.currentTime
    await Promise.all([this.element.play(), this.#audio.play()])
  }
  pause(): void { this.#playing = false; this.element.pause(); this.#audio.pause() }
  async seek(positionSeconds: number): Promise<void> {
    const target = Math.max(0, positionSeconds)
    this.element.currentTime = target
    this.#audio.currentTime = target
  }
  async selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    if (kind !== "audio" || !trackId) throw new Error(`Hybrid ${kind} selection is unavailable`)
    const track = this.tracks.find((candidate) => candidate.kind === kind && candidate.id === trackId)
    if (!track) throw new Error(`Unknown audio track: ${trackId}`)
    const resume = this.#playing
    this.#audio.pause()
    await this.#loadAudio(track.streamIndex)
    this.#audio.currentTime = this.element.currentTime
    if (resume) await this.#audio.play()
    for (const candidate of this.tracks) {
      if (candidate.kind === "audio") candidate.selected = candidate.id === trackId
    }
    this.dispatchEvent(new CustomEvent("trackchange", { detail: { kind, trackId } }))
  }
  async setVolume(volume: number): Promise<void> {
    this.#audio.volume = Math.min(1, Math.max(0, volume))
  }
  async setPlaybackRate(rate: number): Promise<void> {
    this.element.playbackRate = rate; this.#audio.playbackRate = rate
  }
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
    return {
      sessionId: this.sessionId,
      encodedBytesBuffered: 0,
      bufferedAheadSeconds: this.bufferedAhead(),
      ...(videoCodec === undefined ? {} : { videoCodec }),
      ...(audioCodec === undefined ? {} : { audioCodec }),
      hardwareBackend: "platform+gstreamer",
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
    return { presentedFrames: Math.max(0, total - dropped), mediaTimeSeconds: this.element.currentTime,
      measuredFps: 0, totalVideoFrames: total, droppedVideoFrames: dropped,
      droppedFramePercent: total === 0 ? 0 : dropped / total * 100 }
  }
  refreshLayout(): void { /* native video follows layout */ }
  registerControls(_target: VideoControlsTarget): () => void { return () => undefined }
  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#hls?.destroy()
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe()
    this.element.pause(); this.#audio.pause(); this.#audio.remove()
    this.element.muted = false; this.element.removeAttribute("src"); this.element.load()
    await this.client.deleteSession(this.session.id).catch(() => undefined)
  }
  on<K extends keyof VideoControllerEventMap>(type: K,
    listener: (event: VideoControllerEventMap[K]) => void,
    options?: AddEventListenerOptions): () => void {
    const eventListener = listener as EventListener
    this.addEventListener(type, eventListener, options)
    return () => this.removeEventListener(type, eventListener, options)
  }
  async #loadAudio(trackIndex: number, signal?: AbortSignal): Promise<void> {
    this.#hls?.destroy()
    const module = await import("hls.js")
    const HlsConstructor = module.default
    const hls = new HlsConstructor({ enableWorker: true })
    this.#hls = hls
    const master = new URL(this.client.masterUrl(this.session))
    const playlist = new URL(`audio/${trackIndex}/playlist.m3u8`, master).toString()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Hybrid audio startup timed out")),
        this.startupTimeoutMillis)
      const finish = (failure?: unknown) => {
        clearTimeout(timer)
        hls.off(HlsConstructor.Events.MANIFEST_PARSED, parsed)
        hls.off(HlsConstructor.Events.ERROR, failed)
        failure === undefined ? resolve() : reject(failure)
      }
      const parsed = () => finish()
      const failed = (_event: unknown, data: { fatal: boolean; details?: string }) => {
        if (data.fatal) finish(new Error(`Hybrid audio failed: ${data.details ?? "fatal error"}`))
      }
      signal?.addEventListener("abort", () => finish(signal.reason), { once: true })
      hls.on(HlsConstructor.Events.MANIFEST_PARSED, parsed)
      hls.on(HlsConstructor.Events.ERROR, failed)
      hls.loadSource(playlist)
      hls.attachMedia(this.#audio)
    })
  }
  #listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener)
    this.#unsubscribers.push(() => target.removeEventListener(type, listener))
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
  #lastHlsRecovery = 0
  #unsubscribers: Array<() => void> = []

  constructor(
    readonly element: HTMLVideoElement,
    private readonly session: TranscodeSession,
    private readonly client: TranscodeSessionClient,
    private readonly startupTimeoutMillis: number,
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
    if (shouldUseNativeHls(this.element, this.session, this.preferNativeHls)) {
      await this.#startNative(masterUrl, options.signal)
    }
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

/**
 * Native HLS is only suitable for a multitrack session when the platform
 * exposes its non-standard audio track list. Chromium can report HLS support
 * without exposing that API, which otherwise makes alternate audio impossible
 * to select after playback starts.
 */
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

async function detectVideoCapabilities(): Promise<{
  videoCodecs: VideoCodec[]
  hdrFormats: string[]
  maxWidth: number
  maxHeight: number
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
    ...declaredVideoDimensions(results),
  }
}
