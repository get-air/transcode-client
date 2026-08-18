import { TranscodeClient } from '@get-air/transcode'
import {
  hybridVideoBackend,
  transcodeRelayHttpTransport,
  transcodeVideoBackend,
} from '@get-air/transcode/video'
import {
  createVideoClient,
  type MediaTrack,
  type TrackKind,
  type VideoBackend,
  type VideoController,
} from '@get-air/video'

import './style.css'

const form = required<HTMLFormElement>('#source-form')
const source = required<HTMLInputElement>('#source')
const origin = required<HTMLInputElement>('#origin')
const route = required<HTMLSelectElement>('#route')
const video = required<HTMLVideoElement>('#video')
const backend = required<HTMLOutputElement>('#backend')
const status = required<HTMLElement>('#status')
const diagnostics = required<HTMLElement>('#diagnostics')
const submit = required<HTMLButtonElement>('button[type="submit"]')
const trackControls = required<HTMLElement>('#track-controls')
const audioTrackField = required<HTMLElement>('#audio-track-field')
const audioTrack = required<HTMLSelectElement>('#audio-track')
const subtitleTrackField = required<HTMLElement>('#subtitle-track-field')
const subtitleTrack = required<HTMLSelectElement>('#subtitle-track')
const seekField = required<HTMLElement>('#seek-field')
const seekPosition = required<HTMLInputElement>('#seek-position')
const seekButton = required<HTMLButtonElement>('#seek-button')
let controller: VideoController | undefined
let loadSequence = 0
let playbackSummary = 'Enter a direct media URL.'
let transcodeClient: TranscodeClient | undefined
let diagnosticsTimer: number | undefined
let activeSourceId: string | undefined

const parameters = new URLSearchParams(location.search)
source.value = parameters.get('source') ?? ''
origin.value = parameters.get('origin') ?? origin.value
route.value = parameters.get('mode') ?? route.value

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void playSource()
})
audioTrack.addEventListener('change', () => { void selectTrack('audio', audioTrack) })
subtitleTrack.addEventListener('change', () => { void selectTrack('subtitle', subtitleTrack) })
seekButton.addEventListener('click', () => { void seekToPosition() })

async function playSource(): Promise<void> {
  const sequence = ++loadSequence
  status.textContent = 'Choosing a playback route…'
  backend.textContent = 'Opening'
  setBusy(true)
  hideTrackControls()
  try {
    const previousTranscode = transcodeClient
    const previousSourceId = activeSourceId
    await controller?.destroy()
    if (previousTranscode && previousSourceId) {
      await previousTranscode.releaseSource(previousSourceId).catch(() => undefined)
    }
    controller = undefined
    activeSourceId = undefined
    if (diagnosticsTimer !== undefined) window.clearInterval(diagnosticsTimer)
    const transcode = await TranscodeClient.connect({ origin: origin.value })
    transcodeClient = transcode
    const relay = transcodeRelayHttpTransport(transcode)
    activeSourceId = (await relay.register({ url: source.value })).id
    const client = createVideoClient({
      http: relay,
      adapters: [
        hybridVideoBackend({ client: transcode, relay }),
        transcodeVideoBackend({
          client: transcode,
          relay,
          preferNativeHls: parameters.get('mse') !== '1',
        }),
      ],
    })
    controller = await client.attach(video, {
      source: source.value,
      backend: route.value as VideoBackend,
      autoplay: false,
    })
    if (sequence !== loadSequence) {
      await controller.destroy()
      return
    }
    const hybrid = controller.sessionId.startsWith('hybrid-')
    backend.textContent = hybrid ? 'hybrid' : controller.capabilities.backend
    const codecs = controller.tracks.map((track) => track.codec).filter(Boolean).join(' + ')
    playbackSummary = hybrid
      ? `Native video + GStreamer AAC · ${codecs}`
      : controller.capabilities.backend === 'html'
      ? 'Direct HTML playback—the source needs no proxy or transcoding.'
      : controller.capabilities.backend === 'mediabunny'
        ? `MediaBunny client decode · ${codecs}`
        : `GStreamer HLS · ${codecs}`
    status.textContent = playbackSummary
    renderTrackControls(controller)
    await controller.play()
    await updateDiagnostics()
    diagnosticsTimer = window.setInterval(() => { void updateDiagnostics() }, 1_000)
  } catch (cause) {
    if (sequence !== loadSequence) return
    backend.textContent = 'Failed'
    playbackSummary = errorDetails(cause)
    status.textContent = playbackSummary
  } finally {
    if (sequence === loadSequence) setBusy(false)
  }
}

async function selectTrack(kind: TrackKind, select: HTMLSelectElement): Promise<void> {
  const active = controller
  if (!active) return
  const previous = active.tracks.find((track) => track.kind === kind && track.selected)?.id ?? ''
  select.disabled = true
  status.textContent = `Switching ${kind} track…`
  try {
    await active.selectTrack(kind, select.value || undefined)
    playbackSummary = `${backend.textContent} · ${trackLabel(
      active.tracks.find((track) => track.id === select.value),
      kind === 'subtitle' ? 'Subtitles off' : 'Track selected',
    )}`
    status.textContent = playbackSummary
  } catch (cause) {
    select.value = previous
    status.textContent = errorDetails(cause)
  } finally {
    select.disabled = false
    await updateDiagnostics()
  }
}

async function seekToPosition(): Promise<void> {
  const active = controller
  if (!active) return
  seekButton.disabled = true
  status.textContent = 'Seeking…'
  try {
    await active.seek(Number(seekPosition.value))
    status.textContent = playbackSummary
  } catch (cause) {
    status.textContent = errorDetails(cause)
  } finally {
    seekButton.disabled = false
    await updateDiagnostics()
  }
}

async function updateDiagnostics(): Promise<void> {
  const active = controller
  const transcode = transcodeClient
  if (!active || !transcode) {
    diagnostics.textContent = 'No active session.'
    return
  }
  try {
    const [baseStats, metrics] = await Promise.all([active.stats(), transcode.metrics()])
    const stats = baseStats as typeof baseStats & {
      sourceId?: string
      playbackMode?: string
      switchLatencyMillis?: number
      seekLatencyMillis?: number
      avDriftMillis?: number
    }
    diagnostics.textContent = [
      `mode=${stats.playbackMode ?? active.capabilities.backend}`,
      `source=${stats.sourceId ?? activeSourceId ?? 'n/a'}`,
      `switch_ms=${formatMetric(stats.switchLatencyMillis)}`,
      `seek_ms=${formatMetric(stats.seekLatencyMillis)}`,
      `av_drift_ms=${formatMetric(stats.avDriftMillis)}`,
      `resolver_requests=${metrics.resolver_requests}`,
      `cdn_ranges=${metrics.cdn_range_requests}`,
      `pipeline_queue_ms=${metrics.pipeline_queue_wait_ms}`,
      `failed=${metrics.failed_pipelines}`,
      `cancelled=${metrics.cancelled_pipelines}`,
    ].join(' · ')
  } catch (cause) {
    diagnostics.textContent = `Diagnostics unavailable: ${errorDetails(cause)}`
  }
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? 'n/a' : value.toFixed(1)
}

function errorDetails(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  const nested = 'cause' in cause ? cause.cause : undefined
  return nested === undefined ? cause.message : `${cause.message}: ${String(nested)}`
}

function renderTrackControls(active: VideoController): void {
  renderTrackSelect(
    'audio',
    audioTrack,
    audioTrackField,
    active.capabilities.audioTrackSelection,
    false,
  )
  renderTrackSelect(
    'subtitle',
    subtitleTrack,
    subtitleTrackField,
    active.capabilities.subtitleTrackSelection,
    true,
  )
  trackControls.hidden = audioTrackField.hidden && subtitleTrackField.hidden
  seekField.hidden = false
  trackControls.hidden = false
}

function renderTrackSelect(
  kind: TrackKind,
  select: HTMLSelectElement,
  field: HTMLElement,
  supported: boolean,
  allowOff: boolean,
): void {
  const tracks = controller?.tracks.filter((track) => track.kind === kind) ?? []
  select.replaceChildren()
  if (allowOff) select.add(new Option('Off', ''))
  for (const track of tracks) {
    select.add(new Option(trackLabel(track, `${kind} ${track.streamIndex}`), track.id))
  }
  select.value = tracks.find((track) => track.selected)?.id ?? ''
  field.hidden = !supported || tracks.length === 0
}

function trackLabel(track: MediaTrack | undefined, fallback: string): string {
  if (!track) return fallback
  const identity = track.label || track.language || fallback
  const details = [track.language !== identity ? track.language : undefined, track.codec]
    .filter(Boolean)
    .join(' · ')
  return details ? `${identity} — ${details}` : identity
}

function hideTrackControls(): void {
  trackControls.hidden = true
  audioTrackField.hidden = true
  subtitleTrackField.hidden = true
  seekField.hidden = true
}

function setBusy(busy: boolean): void {
  submit.disabled = busy
  submit.textContent = busy ? 'Opening…' : 'Play URL'
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
