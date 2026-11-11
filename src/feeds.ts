// Nature from the internet. Two public, key-less, CORS-enabled feeds are polled:
//   * USGS: every earthquake on Earth in the last hour. Each one shakes the gene
//     pool with a mutation impulse proportional to its magnitude.
//   * Open-Meteo: current wind and temperature at a wild place on the planet,
//     which steer how fast the organism drifts through the 4th dimension and how
//     warm its palette is.
// Nothing about the visitor is sent: the requests carry no location and no identifiers.

const PLACES: [string, number, number][] = [
  ['Amazon rainforest', -3.4, -62.2],
  ['Sahara', 23.4, 12.6],
  ['Himalaya', 27.99, 86.93],
  ['Great Barrier Reef', -18.29, 147.7],
  ['Iceland highlands', 64.9, -18.6],
  ['Serengeti', -2.33, 34.83],
  ['Antarctic plateau', -75.1, 123.3],
  ['Borneo', 0.96, 114.55],
  ['Patagonia', -49.3, -73.1],
  ['Siberian taiga', 62.0, 105.3],
  ['Mid-Pacific', 0.0, -150.0],
  ['Greenland ice sheet', 72.6, -38.5],
];

export interface Quake {
  mag: number;
  place: string;
}

export class EarthFeed {
  on = false;
  /** 0..1: wind speed at the current place (0 calm, 1 storm). */
  wind = 0.3;
  /** 0..1: temperature (0 = -30 C, 1 = +40 C). */
  warmth = 0.5;
  status = '';
  private seen = new Set<string>();
  private queue: Quake[] = [];
  private timers: number[] = [];
  private weatherText = '';
  private quakeText = '';

  start(): void {
    if (this.on) return;
    this.on = true;
    this.status = 'Earth: listening…';
    void this.quakes();
    void this.weather();
    this.timers.push(window.setInterval(() => void this.quakes(), 60_000), window.setInterval(() => void this.weather(), 600_000));
  }

  stop(): void {
    this.on = false;
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.queue = [];
    this.status = '';
  }

  /** Next earthquake waiting to be felt, if any (released one at a time by the caller). */
  next(): Quake | null {
    const q = this.queue.shift() ?? null;
    if (q) {
      this.quakeText = `M${q.mag.toFixed(1)} ${q.place}`;
      this.compose();
    }
    return q;
  }

  private compose(): void {
    this.status = ['Earth', this.quakeText, this.weatherText].filter(Boolean).join(' · ');
  }

  private async quakes(): Promise<void> {
    try {
      const r = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson', { cache: 'no-store' });
      const j = (await r.json()) as { features?: { id?: unknown; properties?: { mag?: unknown; place?: unknown } }[] };
      const fresh: Quake[] = [];
      for (const f of j.features ?? []) {
        const id = String(f.id ?? '');
        const mag = Number(f.properties?.mag);
        if (!id || this.seen.has(id) || !Number.isFinite(mag)) continue;
        this.seen.add(id);
        fresh.push({ mag, place: String(f.properties?.place ?? 'somewhere').slice(0, 60) });
      }
      // strongest last, so the biggest shock of the batch is the one that lingers
      fresh.sort((a, b) => a.mag - b.mag);
      this.queue.push(...fresh.slice(-12));
      if (!this.quakeText && !fresh.length) this.quakeText = 'the ground is quiet';
      this.compose();
    } catch {
      if (!this.quakeText) this.quakeText = 'earthquake feed unreachable';
      this.compose();
    }
  }

  private async weather(): Promise<void> {
    const [name, lat, lon] = PLACES[Math.floor(Math.random() * PLACES.length)];
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m`);
      const j = (await r.json()) as { current?: { temperature_2m?: unknown; wind_speed_10m?: unknown } };
      const t = Number(j.current?.temperature_2m);
      const w = Number(j.current?.wind_speed_10m);
      if (!Number.isFinite(t) || !Number.isFinite(w)) throw new Error('bad data');
      this.wind = Math.min(1, Math.max(0, w / 60));
      this.warmth = Math.min(1, Math.max(0, (t + 30) / 70));
      this.weatherText = `${name}: ${Math.round(t)}°C, wind ${Math.round(w)} km/h`;
    } catch {
      this.weatherText = '';
    }
    this.compose();
  }
}
