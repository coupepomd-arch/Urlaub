// GPX-Dateien (z. B. aus Calimoto) einlesen, auswerten und für die Karte ausdünnen.

export type GpxPunkt = { t: number; lat: number; lng: number; hoehe: number | null; kmh: number | null };

const rad = (g: number) => (g * Math.PI) / 180;
export function abstandKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Liest alle Trackpunkte mit Zeitstempel. Wegpunkte und Routen ohne Zeit werden ignoriert.
export function gpxLesen(text: string): GpxPunkt[] {
  const punkte: GpxPunkt[] = [];
  const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
  const attr = (s: string, name: string) => {
    const m = new RegExp("\\b" + name + "\\s*=\\s*[\"']([^\"']+)[\"']").exec(s);
    return m ? Number(m[1]) : NaN;
  };
  for (const m of text.matchAll(re)) {
    const lat = attr(m[1], "lat"), lng = attr(m[1], "lon");
    const inhalt = m[2] ?? "";
    const zeit = /<time>\s*([^<\s]+)\s*<\/time>/.exec(inhalt);
    const ele = /<ele>\s*([^<\s]+)\s*<\/ele>/.exec(inhalt);
    const t = zeit ? Date.parse(zeit[1]) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const h = ele ? Number(ele[1]) : NaN;
    punkte.push({ t, lat, lng, hoehe: Number.isFinite(h) ? h : null, kmh: null });
  }
  punkte.sort((a, b) => a.t - b.t);
  // doppelte Zeitstempel entfernen
  return punkte.filter((p, i) => i === 0 || p.t !== punkte[i - 1].t);
}

// Geschwindigkeit je Punkt, geglättet über ca. 10 Sekunden (gegen GPS-Ausreißer)
export function tempoSetzen(p: GpxPunkt[]) {
  const summe = [0];
  for (let i = 1; i < p.length; i++) summe.push(summe[i - 1] + abstandKm(p[i - 1], p[i]));
  let a = 0, b = 0;
  for (let i = 0; i < p.length; i++) {
    while (p[i].t - p[a].t > 5000) a++;
    while (b < p.length - 1 && p[b + 1].t - p[i].t <= 5000) b++;
    const dt = (p[b].t - p[a].t) / 3600000;
    const v = dt > 0 ? (summe[b] - summe[a]) / dt : 0;
    p[i].kmh = v < 250 ? Math.round(v * 10) / 10 : null;
  }
}

export function auswerten(p: GpxPunkt[]) {
  let km = 0, fahrMs = 0;
  for (let i = 1; i < p.length; i++) {
    const d = abstandKm(p[i - 1], p[i]), dt = p[i].t - p[i - 1].t;
    if (dt <= 0) continue;
    const v = d / (dt / 3600000);
    if (v > 250) continue;
    km += d;
    if (v > 4 && dt < 120000) fahrMs += dt;
  }
  let maxKmh = 0;
  for (const x of p) if (x.kmh != null && x.kmh > maxKmh) maxKmh = x.kmh;

  // Höhenmeter: gleitender Mittelwert über 15 Punkte, Schwelle 3 m
  const mitHoehe = p.filter((x) => x.hoehe != null);
  let anstieg = 0, abstieg = 0, hoeheMax: GpxPunkt | null = null;
  if (mitHoehe.length) {
    const h = mitHoehe.map((x) => x.hoehe as number);
    const glatt = h.map((_, i) => {
      const s = h.slice(Math.max(0, i - 7), i + 8);
      return s.reduce((a, b) => a + b, 0) / s.length;
    });
    let ref = glatt[0];
    for (const g of glatt) {
      if (g - ref >= 3) { anstieg += g - ref; ref = g; }
      else if (ref - g >= 3) { abstieg += ref - g; ref = g; }
    }
    hoeheMax = mitHoehe.reduce((m, x) => ((x.hoehe as number) > (m.hoehe as number) ? x : m));
  }
  return {
    start: new Date(p[0].t), ende: new Date(p[p.length - 1].t),
    km: Math.round(km * 100) / 100, fahrzeit_s: Math.round(fahrMs / 1000), max_kmh: Math.round(maxKmh),
    anstieg_m: Math.round(anstieg), abstieg_m: Math.round(abstieg),
    hoehe_max: hoeheMax?.hoehe ?? null, hoehe_max_lat: hoeheMax?.lat ?? null, hoehe_max_lng: hoeheMax?.lng ?? null,
  };
}

// Douglas-Peucker in Metern: behält nur Punkte, die für die Form der Strecke nötig sind.
// Zusätzlich bleibt spätestens alle 20 Sekunden ein Punkt erhalten (für Replay und Tempo-Farben).
export function ausduennen(p: GpxPunkt[], toleranzM = 3): GpxPunkt[] {
  if (p.length < 3) return p.slice();
  const lat0 = rad(p[0].lat), kx = 111320 * Math.cos(lat0), ky = 110540;
  const x = p.map((q) => q.lng * kx), y = p.map((q) => q.lat * ky);
  const behalten = new Uint8Array(p.length);
  behalten[0] = behalten[p.length - 1] = 1;
  const stapel: [number, number][] = [[0, p.length - 1]];
  while (stapel.length) {
    const [a, b] = stapel.pop()!;
    const dx = x[b] - x[a], dy = y[b] - y[a], len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      let d;
      if (len2 === 0) d = Math.hypot(x[i] - x[a], y[i] - y[a]);
      else {
        const t = Math.max(0, Math.min(1, ((x[i] - x[a]) * dx + (y[i] - y[a]) * dy) / len2));
        d = Math.hypot(x[i] - (x[a] + t * dx), y[i] - (y[a] + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > toleranzM) { behalten[idx] = 1; stapel.push([a, idx], [idx, b]); }
  }
  let letzte = p[0].t;
  for (let i = 1; i < p.length; i++) {
    if (behalten[i]) { letzte = p[i].t; continue; }
    if (p[i].t - letzte >= 20000) { behalten[i] = 1; letzte = p[i].t; }
  }
  return p.filter((_, i) => behalten[i]);
}

// ca. n gleichmäßig verteilte Punkte für die Mini-Karte im Reisebuch
export function miniLinie(p: GpxPunkt[], n = 80) {
  const schritt = Math.max(1, Math.ceil(p.length / n));
  const aus = p.filter((_, i) => i % schritt === 0 || i === p.length - 1);
  return aus.map((q) => [Math.round(q.lat * 1e5) / 1e5, Math.round(q.lng * 1e5) / 1e5]);
}
