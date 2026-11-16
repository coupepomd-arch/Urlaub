// Orte aus OpenStreetMap: Ortsname (Nominatim, Reserve: Photon) und Lokale/Aussichtspunkte in der Nähe (Photon, Reserve: Overpass).
// Alle Dienste sind kostenlos und brauchen keinen Schlüssel; abgefragt wird nur mit Koordinaten.
import { abstandKm } from "./gpx.ts";

const KENNUNG = { "User-Agent": "motorrad-tour-live/1.0 (privates Reise-Tracking)" };

// Ortschaft zu einer Koordinate, z. B. "Vilaflor de Chasna" (Nominatim, Reserve: Photon)
export async function ortschaftHolen(lat: number, lng: number): Promise<string | null> {
  const kuerzen = (x: unknown) => (x ? String(x).slice(0, 120) : null);
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de&lat="
      + lat.toFixed(5) + "&lon=" + lng.toFixed(5), { headers: KENNUNG, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const a = (await r.json())?.address ?? {};
      const name = a.village || a.hamlet || a.town || a.suburb || a.city_district || a.city || a.municipality || a.county;
      if (name) return kuerzen(name);
    } else console.error("Nominatim", r.status);
  } catch (e) { console.error("Nominatim", e); }
  try {
    const r = await fetch("https://photon.komoot.io/reverse?limit=1&lat=" + lat.toFixed(5) + "&lon=" + lng.toFixed(5),
      { headers: KENNUNG, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const p = (await r.json())?.features?.[0]?.properties ?? {};
    const ortTypen = ["city", "town", "village", "hamlet", "locality", "district"];
    return kuerzen(p.district || p.city || p.locality || (ortTypen.includes(p.type) ? p.name : null) || p.county);
  } catch {
    return null;
  }
}

// Welche Orte passen zu welcher Meldung (werden in der Liste nach vorne sortiert)
const PASST: Record<string, string[]> = {
  essen: ["restaurant", "fast_food", "cafe", "bar", "pub", "biergarten"],
  pause: ["cafe", "bar", "restaurant", "ice_cream", "pub", "fast_food", "viewpoint"],
  tanken: ["fuel"],
  aussicht: ["viewpoint", "peak", "volcano", "attraction"],
  foto: ["viewpoint", "peak", "volcano", "attraction", "beach"],
  angekommen: ["hotel", "guest_house", "apartment", "restaurant"],
};

export type Ort = { name: string; typ: string; lat: number; lng: number; m: number };
type Roh = { name: string; typ: string; lat: number; lng: number };

const ESSEN = ["restaurant", "cafe", "bar", "pub", "fast_food", "ice_cream", "biergarten", "fuel"];
const UNTERKUNFT = ["hotel", "guest_house", "apartment", "hostel"];
const SEHENSWERT = ["viewpoint", "attraction", "museum", "picnic_site"];
const NATUR = ["peak", "volcano", "beach"];

// Photon (komoot, OpenStreetMap-Daten): schnelle Umkreissuche, nächste Orte zuerst
async function photon(lat: number, lng: number): Promise<Roh[]> {
  const frage = async (radiusKm: number, tags: string[]) => {
    const u = new URL("https://photon.komoot.io/reverse");
    u.searchParams.set("lat", lat.toFixed(5)); u.searchParams.set("lon", lng.toFixed(5));
    u.searchParams.set("limit", "25"); u.searchParams.set("radius", String(radiusKm));
    for (const t of tags) u.searchParams.append("osm_tag", t);
    const r = await fetch(u, { headers: KENNUNG, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (!Array.isArray(d?.features)) throw new Error("keine Daten");
    return (d.features as any[]).map((f) => ({
      name: String(f.properties?.name ?? ""), typ: String(f.properties?.osm_value ?? ""),
      lat: Number(f.geometry?.coordinates?.[1]), lng: Number(f.geometry?.coordinates?.[0]),
      schluessel: String(f.properties?.osm_key ?? ""),
    })).filter((x) => ["amenity", "tourism", "natural"].includes(x.schluessel));
  };
  const teile = await Promise.allSettled([
    frage(0.35, [...ESSEN.map((x) => "amenity:" + x), ...UNTERKUNFT.map((x) => "tourism:" + x)]),
    frage(1.5, [...SEHENSWERT.map((x) => "tourism:" + x), ...NATUR.map((x) => "natural:" + x)]),
  ]);
  if (teile.every((t) => t.status === "rejected")) throw new Error("Photon nicht erreichbar");
  return teile.flatMap((t) => (t.status === "fulfilled" ? t.value : []));
}

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Reserve, falls Photon nicht antwortet
async function overpass(lat: number, lng: number): Promise<Roh[]> {
  const p = lat.toFixed(5) + "," + lng.toFixed(5);
  const abfrage = `[out:json][timeout:10];(` +
    `nwr(around:350,${p})[name][amenity~"^(${ESSEN.join("|")})$"];` +
    `nwr(around:350,${p})[name][tourism~"^(${UNTERKUNFT.join("|")})$"];` +
    `nwr(around:1500,${p})[name][tourism~"^(${SEHENSWERT.join("|")})$"];` +
    `nwr(around:1500,${p})[name][natural~"^(${NATUR.join("|")})$"];` +
    `);out center 60;`;
  for (const s of OVERPASS) {
    try {
      const r = await fetch(s, {
        method: "POST", headers: { ...KENNUNG, "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(abfrage), signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      if (!Array.isArray(d?.elements)) continue;
      return (d.elements as any[]).map((e) => ({
        name: String(e.tags?.name ?? ""), typ: String(e.tags?.amenity ?? e.tags?.tourism ?? e.tags?.natural ?? ""),
        lat: Number(e.lat ?? e.center?.lat), lng: Number(e.lon ?? e.center?.lon),
      }));
    } catch { /* nächster Server */ }
  }
  throw new Error("Overpass nicht erreichbar");
}

// Benannte Lokale, Tankstellen, Unterkünfte, Aussichtspunkte, Gipfel usw. im Umkreis, passende und nahe zuerst
export async function orteInDerNaehe(lat: number, lng: number, art: string | null): Promise<Ort[] | null> {
  let roh: Roh[];
  try { roh = await photon(lat, lng); }
  catch {
    try { roh = await overpass(lat, lng); } catch { return null; }
  }

  const passt = new Set(PASST[art ?? ""] ?? []);
  const gesehen = new Set<string>();
  const orte: (Ort & { rang: number })[] = [];
  for (const e of roh) {
    const olat = e.lat, olng = e.lng, name = e.name.trim(), typ = e.typ;
    if (!name || !Number.isFinite(olat) || !Number.isFinite(olng)) continue;
    const schluessel = name.toLowerCase();   // gleicher Name nur einmal (z. B. Pension mit Restaurant)
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    const m = Math.round(abstandKm({ lat, lng }, { lat: olat, lng: olng }) * 1000);
    // passende Orte rücken nach vorne; Aussichtspunkte und Gipfel liegen oft weiter weg, daher schwächer gewichtet
    const fern = NATUR.includes(typ) || SEHENSWERT.includes(typ) ? 1.5 : 1;
    orte.push({ name: name.slice(0, 120), typ, lat: olat, lng: olng, m, rang: m * fern * (passt.has(typ) ? 0.4 : 1) });
  }
  orte.sort((a, b) => a.rang - b.rang);
  return orte.slice(0, 12).map(({ rang: _, ...o }) => o);
}
