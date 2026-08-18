import { TranscodeClient } from '@get-air/transcode'
import { transcodeVideoBackend } from '@get-air/transcode/video'
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
const submit = required<HTMLButtonElement>('button[type="submit"]')
const trackControls = required<HTMLElement>('#track-controls')
const audioTrackField = required<HTMLElement>('#audio-track-field')
const audioTrack = required<HTMLSelectElement>('#audio-track')
const subtitleTrackField = required<HTMLElement>('#subtitle-track-field')
const subtitleTrack = required<HTMLSelectElement>('#subtitle-track')
let controller: VideoController | undefined
let loadSequence = 0
let playbackSummary = 'Enter a direct media URL.'

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

async function playSource(): Promise<void> {
  const sequence = ++loadSequence
  status.textContent = 'Choosing a playback route…'
  backend.textContent = 'Opening'
  setBusy(true)
  hideTrackControls()
  try {
    await controller?.destroy()
    controller = undefined
    const transcode = await TranscodeClient.connect({ origin: origin.value })
    const client = createVideoClient({
      adapters: [transcodeVideoBackend({
        client: transcode,
        preferNativeHls: parameters.get('mse') !== '1',
      })],
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
    backend.textContent = controller.capabilities.backend
    const codecs = controller.tracks.map((track) => track.codec).filter(Boolean).join(' + ')
    playbackSummary = controller.capabilities.backend === 'html'
      ? 'Direct HTML playback—the source needs no proxy or transcoding.'
      : controller.capabilities.backend === 'mediabunny'
        ? `MediaBunny client decode · ${codecs}`
        : `GStreamer HLS · ${codecs}`
    status.textContent = playbackSummary
    renderTrackControls(controller)
    await controller.play()
  } catch (cause) {
    if (sequence !== loadSequence) return
    backend.textContent = 'Failed'
    playbackSummary = cause instanceof Error ? cause.message : String(cause)
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
  }
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
