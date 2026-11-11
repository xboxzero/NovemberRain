// Streaming PNG encoder. Rows are filtered and pushed through the browser's native
// deflate as they arrive, so an 8K image never has to exist uncompressed in memory.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 255] ^ (c >>> 8);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

export class PngStream {
  private parts: BlobPart[] = [];
  private writer: WritableStreamDefaultWriter<BufferSource>;
  private pump: Promise<void>;

  static get supported(): boolean {
    return typeof CompressionStream !== 'undefined';
  }

  constructor(readonly width: number, readonly height: number) {
    const head = new Uint8Array(13);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    head[8] = 8; // bit depth
    head[9] = 2; // colour type: RGB (no alpha: a quarter less data)
    this.parts.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head));
    const cs = new CompressionStream('deflate');
    this.writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    this.pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.parts.push(chunk('IDAT', value as Uint8Array));
      }
    })();
  }

  /**
   * Append rows. `rgba` holds `rows` rows of `width` RGBA pixels, bottom row first
   * (the order WebGL's readPixels returns them); they are written top row first.
   */
  async write(rgba: Uint8Array, rows: number): Promise<void> {
    const w = this.width;
    const stride = 1 + w * 3;
    const out = new Uint8Array(rows * stride);
    for (let y = 0; y < rows; y++) {
      let s = (rows - 1 - y) * w * 4;
      let o = y * stride;
      out[o++] = 1; // filter: Sub (difference to the pixel on the left compresses far better)
      let pr = 0;
      let pg = 0;
      let pb = 0;
      for (let x = 0; x < w; x++, s += 4) {
        const r = rgba[s];
        const g = rgba[s + 1];
        const b = rgba[s + 2];
        out[o++] = r - pr;
        out[o++] = g - pg;
        out[o++] = b - pb;
        pr = r;
        pg = g;
        pb = b;
      }
    }
    await this.writer.write(out);
  }

  async finish(): Promise<Blob> {
    await this.writer.close();
    await this.pump;
    this.parts.push(chunk('IEND', new Uint8Array(0)));
    return new Blob(this.parts, { type: 'image/png' });
  }
}
