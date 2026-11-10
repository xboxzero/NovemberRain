// YouTube layer. Browsers do not expose the pixels of a cross-origin iframe, so the
// player sits underneath the WebGL canvas and the two are mixed by the compositor
// with CSS blend modes. For pixel-level mixing use screen / tab capture instead.

interface YTPlayer {
  loadVideoById(id: string): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  mute(): void;
  unMute(): void;
  setVolume(v: number): void;
  destroy(): void;
}

interface YTNamespace {
  Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v) return v.slice(0, 11);
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a url */
  }
  return null;
}

let apiPromise: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        if (window.YT) resolve(window.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => {
        apiPromise = null;
        reject(new Error('Could not reach YouTube'));
      };
      document.head.appendChild(s);
    });
  }
  return apiPromise;
}

export class YouTubeLayer {
  private player: YTPlayer | null = null;
  videoId: string | null = null;

  constructor(private host: HTMLElement) {}

  get active(): boolean {
    return this.videoId !== null;
  }

  async load(id: string): Promise<void> {
    const YT = await loadApi();
    this.videoId = id;
    this.host.classList.add('on');
    if (this.player) {
      this.player.loadVideoById(id);
      return;
    }
    const slot = document.createElement('div');
    this.host.appendChild(slot);
    await new Promise<void>((resolve) => {
      this.player = new YT.Player(slot, {
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 0, loop: 1, playlist: id, playsinline: 1, rel: 0, modestbranding: 1, disablekb: 1, fs: 0 },
        events: {
          onReady: () => {
            this.player?.playVideo();
            resolve();
          },
        },
      });
    });
  }

  off(): void {
    this.player?.destroy();
    this.player = null;
    this.videoId = null;
    this.host.replaceChildren();
    this.host.classList.remove('on');
  }

  command(cmd: 'pause' | 'play' | 'mute' | 'unmute'): void {
    if (!this.player) return;
    if (cmd === 'pause') this.player.pauseVideo();
    else if (cmd === 'play') this.player.playVideo();
    else if (cmd === 'mute') this.player.mute();
    else this.player.unMute();
  }

  volume(v: number): void {
    this.player?.unMute();
    this.player?.setVolume(v);
  }
}
