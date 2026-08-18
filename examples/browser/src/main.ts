import { TranscodeClient } from '@get-air/transcode'
import { transcodeVideoBackend } from '@get-air/transcode/video'
import { createVideoClient, type VideoController } from '@get-air/video'

import './style.css'

const form = required<HTMLFormElement>('#source-form')
const source = required<HTMLInputElement>('#source')
const origin = required<HTMLInputElement>('#origin')
const video = required<HTMLVideoElement>('#video')
const backend = required<HTMLOutputElement>('#backend')
const status = required<HTMLElement>('#status')
let controller: VideoController | undefined

const parameters = new URLSearchParams(location.search)
source.value = parameters.get('source') ?? ''
origin.value = parameters.get('origin') ?? origin.value

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void playSource()
})

async function playSource(): Promise<void> {
  status.textContent = 'Choosing a playback route…'
  backend.textContent = 'Opening'
  try {
    await controller?.destroy()
    const transcode = await TranscodeClient.connect({ origin: origin.value })
    const client = createVideoClient({
      adapters: [transcodeVideoBackend({
        client: transcode,
        preferNativeHls: parameters.get('mse') !== '1',
      })],
    })
    controller = await client.attach(video, {
      source: source.value,
      backend: 'auto',
      autoplay: false,
    })
    backend.textContent = controller.capabilities.backend
    const codecs = controller.tracks.map((track) => track.codec).filter(Boolean).join(' + ')
    status.textContent = controller.capabilities.backend === 'html'
      ? 'Direct HTML playback—the source needs no proxy or transcoding.'
      : controller.capabilities.backend === 'mediabunny'
        ? `MediaBunny client decode · ${codecs}`
        : `GStreamer HLS · ${codecs}`
    await controller.play()
  } catch (cause) {
    backend.textContent = 'Failed'
    status.textContent = cause instanceof Error ? cause.message : String(cause)
  }
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
