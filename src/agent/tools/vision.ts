/**
 * look_at_screen / look_through_camera: one still frame, only after the owner approves.
 * Web: getDisplayMedia / getUserMedia, grab one frame, stop every track at once.
 * Desktop: the host's capture_screen. Images are downscaled JPEG data URLs (max 1600 px).
 */
import type { Attachment } from '../../types';
import { invokeNative, isDesktopRuntime } from '../../desktop/bridge';
import { newId } from '../../store/db';
import { makeTool } from './define';
import type { ToolContext } from './types';

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

function toAttachment(source: CanvasImageSource, width: number, height: number, origin: Attachment['source']): Attachment {
  if (!width || !height) throw new Error('The captured frame was empty.');
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot process images.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  canvas.width = 0;
  canvas.height = 0;
  return { id: newId(), kind: 'image', mime: 'image/jpeg', dataUrl, source: origin, width: w, height: h };
}

function stopAll(stream: MediaStream): void {
  stream.getTracks().forEach(track => track.stop());
}

/** Waits for `frames` decoded frames (camera exposure settles after a few), with a timeout. */
async function waitForFrames(video: HTMLVideoElement, frames: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const withCallback = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
  };
  for (let i = 0; i < frames && Date.now() < deadline; i += 1) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
      if (typeof withCallback.requestVideoFrameCallback === 'function') {
        withCallback.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
      }
    });
  }
}

async function frameFromStream(stream: MediaStream, origin: Attachment['source'], settleFrames: number): Promise<Attachment> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The video feed did not start.')), 10_000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('The video feed failed.')); };
    });
    await video.play().catch(() => undefined);
    await waitForFrames(video, settleFrames, settleFrames * 120 + 800);
    return toAttachment(video, video.videoWidth, video.videoHeight, origin);
  } finally {
    stopAll(stream);
    video.pause();
    video.srcObject = null;
  }
}

async function imageFromDataUrl(dataUrl: string, origin: Attachment['source']): Promise<Attachment> {
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) throw new Error('The desktop app returned an unexpected image format.');
  const image = new Image();
  image.decoding = 'async';
  image.src = dataUrl;
  await image.decode();
  return toAttachment(image, image.naturalWidth, image.naturalHeight, origin);
}

function mediaError(error: unknown, what: 'screen' | 'camera'): Error {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return new Error(what === 'screen' ? 'The owner cancelled the screen picker or blocked screen sharing.' : 'Camera access was denied.');
      case 'NotFoundError':
        return new Error(what === 'screen' ? 'No screen is available to capture.' : 'No camera was found.');
      case 'NotReadableError':
        return new Error(what === 'camera' ? 'The camera is in use by another app.' : 'The screen could not be read.');
      case 'InvalidStateError':
        return new Error('The capture must start right after the owner clicks approve. Ask again.');
      default:
        return new Error(error.message || error.name);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

function screenAvailable(ctx: ToolContext): boolean {
  if (ctx.desktop) return true;
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export const visionTools = [
  makeTool<Record<string, never>>({
    name: 'look_at_screen',
    description:
      "Takes one screenshot of the owner's screen so you can see it (in the browser the owner picks the screen or "
      + 'window). Asks the owner first; use it only when seeing the screen is needed to help. Returns the image.',
    parameters: { type: 'object', properties: {} },
    policy: 'confirm',
    failure: "Couldn't capture the screen",
    available: screenAvailable,
    parse: () => ({}),
    describe: () => 'Take one screenshot of your screen and show it to Miss Minutes',
    async prepare(_args, ctx) {
      return {
        text: ctx.desktop
          ? 'Take one screenshot of your whole screen and send it to Miss Minutes (and your AI provider, if it can see images).'
          : 'Open the screen picker, capture one frame of what you choose, then stop sharing immediately. The image goes to Miss Minutes (and your AI provider, if it can see images).',
        risk: 'medium',
      };
    },
    async run(_args, ctx) {
      let attachment: Attachment;
      if (ctx.desktop && isDesktopRuntime()) {
        const dataUrl = await invokeNative<string>('capture_screen');
        attachment = await imageFromDataUrl(dataUrl, 'screen');
      } else {
        if (!screenAvailable(ctx)) throw new Error('This browser cannot capture the screen.');
        // Called straight from the approval click: getDisplayMedia needs that user activation.
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
        } catch (error) {
          throw mediaError(error, 'screen');
        }
        attachment = await frameFromStream(stream, 'screen', 2);
      }
      return {
        ok: true,
        summary: `Captured the screen (${attachment.width}x${attachment.height})`,
        data: { captured: 'screen', width: attachment.width, height: attachment.height },
        attachments: [attachment],
      };
    },
  }),

  makeTool<Record<string, never>>({
    name: 'look_through_camera',
    description:
      "Takes one photo with the owner's camera so you can see something they want to show you. Asks the owner "
      + 'first; the camera turns off right after the photo. Returns the image.',
    parameters: { type: 'object', properties: {} },
    policy: 'confirm',
    failure: "Couldn't take a photo",
    available: () => cameraAvailable(),
    parse: () => ({}),
    describe: () => 'Turn on your camera, take one photo, and turn it off again',
    async prepare() {
      return {
        text: 'Turn on your camera, take one photo, and turn the camera off immediately. The photo goes to Miss Minutes (and your AI provider, if it can see images).',
        risk: 'medium',
      };
    },
    async run() {
      if (!cameraAvailable()) throw new Error('This browser cannot use a camera.');
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1600 }, height: { ideal: 1200 }, facingMode: 'user' },
          audio: false,
        });
      } catch (error) {
        throw mediaError(error, 'camera');
      }
      const attachment = await frameFromStream(stream, 'camera', 12);
      return {
        ok: true,
        summary: `Took a photo (${attachment.width}x${attachment.height})`,
        data: { captured: 'camera', width: attachment.width, height: attachment.height },
        attachments: [attachment],
      };
    },
  }),
];
