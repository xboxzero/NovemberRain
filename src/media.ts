// Visual inputs that become GPU textures: webcam, screen / tab capture and local video files.

export type VideoKind = 'screen' | 'file' | null;

function makeVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.loop = true;
  v.autoplay = true;
  return v;
}

export class Media {
  readonly cam = makeVideo();
  readonly vid = makeVideo();
  camOn = false;
  vidKind: VideoKind = null;
  private camStream: MediaStream | null = null;
  private vidStream: MediaStream | null = null;
  private fileUrl: string | null = null;
  onchange: () => void = () => {};

  async camera(on: boolean): Promise<void> {
    if (!on) {
      this.camStream?.getTracks().forEach((t) => t.stop());
      this.camStream = null;
      this.cam.srcObject = null;
      this.camOn = false;
      this.onchange();
      return;
    }
    if (this.camOn) return;
    this.camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.cam.srcObject = this.camStream;
    await this.cam.play();
    this.camOn = true;
    this.onchange();
  }

  stopVideo(): void {
    this.vidStream?.getTracks().forEach((t) => t.stop());
    this.vidStream = null;
    this.vid.pause();
    this.vid.srcObject = null;
    this.vid.removeAttribute('src');
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = null;
    this.vidKind = null;
    this.onchange();
  }

  /** Screen / window / tab capture. Capturing a tab that plays a video gives pixel-level mixing of any site. */
  async screen(on: boolean): Promise<void> {
    if (!on) {
      if (this.vidKind === 'screen') this.stopVideo();
      return;
    }
    if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Screen capture is not supported on this device');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    this.stopVideo();
    this.vidStream = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.vidStream === stream) this.stopVideo();
    });
    this.vid.srcObject = stream;
    await this.vid.play();
    this.vidKind = 'screen';
    this.onchange();
  }

  async file(f: File): Promise<void> {
    this.stopVideo();
    this.fileUrl = URL.createObjectURL(f);
    this.vid.src = this.fileUrl;
    await this.vid.play();
    this.vidKind = 'file';
    this.onchange();
  }
}
