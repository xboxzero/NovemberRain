// The camera as a sense: the organism takes its colours from what the camera sees.

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
  camOn = false;
  private camStream: MediaStream | null = null;
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

  private probe: CanvasRenderingContext2D | null = null;

  /**
   * Three representative colours of what the camera sees (dark, mid and bright
   * thirds of the frame by luminance), as 9 floats in 0..1. Null until a frame is ready.
   */
  colours(): Float32Array | null {
    const v = this.cam;
    if (!this.camOn || v.readyState < 2 || !v.videoWidth) return null;
    if (!this.probe) {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      this.probe = c.getContext('2d', { willReadFrequently: true });
    }
    if (!this.probe) return null;
    this.probe.drawImage(v, 0, 0, 16, 16);
    const px = this.probe.getImageData(0, 0, 16, 16).data;
    const list: [number, number, number, number][] = [];
    for (let i = 0; i < px.length; i += 4) list.push([px[i], px[i + 1], px[i + 2], px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11]);
    list.sort((a, b) => a[3] - b[3]);
    const out = new Float32Array(9);
    const third = Math.floor(list.length / 3);
    for (let k = 0; k < 3; k++) {
      for (let i = k * third; i < (k + 1) * third; i++) for (let ch = 0; ch < 3; ch++) out[k * 3 + ch] += list[i][ch] / 255 / third;
    }
    return out;
  }
}
