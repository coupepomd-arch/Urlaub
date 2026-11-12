// Empfängt Positionen vom Handy (Traccar Client) und liefert sie an die Live-Seite.
//
// Senden:  GET/POST  .../motorrad-tour?id=<SENDE_TOKEN>&lat=..&lon=..   (OsmAnd-Format)
//          POST      .../motorrad-tour  JSON {device_id, location:{coords:{...}, battery:{...}}}
// Lesen:   GET       .../motorrad-tour?ansicht=<ANSICHT_TOKEN>[&seit=<Nr>][&fotos_seit=<Nr>]
// Foto hochladen: POST .../motorrad-tour?id=<SENDE_TOKEN>&foto=1  (multipart: bild, vorschau, zeit, titel, lat, lng)
// Foto ansehen:   GET  .../motorrad-tour?ansicht=<ANSICHT_TOKEN>&foto=<Nr>[&klein=1]
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

type Punkt = {
  token: string | null;
  zeit: Date;
  lat: number;
  lng: number;
  kmh: number | null;
  richtung: number | null;
  hoehe: number | null;
  genauigkeit: number | null;
  akku: number | null;
  laedt: boolean | null;
};

const zahl = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const positiv = (n: number | null) => (n === null || n < 0 ? null : n);

function zeitAus(v: unknown): Date {
  if (v === null || v === undefined || v === "") return new Date();
  const n = Number(v);
  let d: Date;
  if (Number.isFinite(n)) d = new Date(n > 1e12 ? n : n * 1000);
  else d = new Date(String(v));
  // Ungültige oder stark abweichende Zeiten durch Serverzeit ersetzen
  if (isNaN(d.getTime()) || Math.abs(d.getTime() - Date.now()) > 7 * 24 * 3600 * 1000) return new Date();
  return d;
}

const wahr = (v: unknown): boolean | null =>
  v === null || v === undefined || v === "" ? null : ["1", "true", "yes"].includes(String(v).toLowerCase());

// OsmAnd-Format (Query-Parameter oder Formular): Geschwindigkeit in Knoten
function ausParametern(p: URLSearchParams): Punkt | null {
  const lat = zahl(p.get("lat")), lng = zahl(p.get("lon") ?? p.get("lng"));
  if (lat === null || lng === null) return null;
  const knoten = positiv(zahl(p.get("speed")));
  return {
    token: p.get("id") ?? p.get("deviceid"),
    zeit: zeitAus(p.get("timestamp")),
    lat, lng,
    kmh: knoten === null ? null : knoten * 1.852,
    richtung: positiv(zahl(p.get("bearing") ?? p.get("heading"))),
    hoehe: zahl(p.get("altitude")),
    genauigkeit: positiv(zahl(p.get("accuracy"))),
    akku: zahl(p.get("batt")),
    laedt: wahr(p.get("charge")),
  };
}

// JSON-Format der neueren Traccar-Client-Versionen: Geschwindigkeit in m/s
function ausJson(body: any, fallbackToken: string | null): Punkt[] {
  const token = body?.device_id ?? body?.deviceId ?? body?.id ?? fallbackToken;
  const liste = Array.isArray(body?.location) ? body.location : body?.location ? [body.location] : [];
  const punkte: Punkt[] = [];
  for (const loc of liste) {
    const c = loc?.coords ?? {};
    const lat = zahl(c.latitude), lng = zahl(c.longitude);
    if (lat === null || lng === null) continue;
    const ms = positiv(zahl(c.speed));
    const level = zahl(loc?.battery?.level);
    punkte.push({
      token: token ? String(token) : null,
      zeit: zeitAus(loc?.timestamp),
      lat, lng,
      kmh: ms === null ? null : ms * 3.6,
      richtung: positiv(zahl(c.heading)),
      hoehe: zahl(c.altitude),
      genauigkeit: positiv(zahl(c.accuracy)),
      akku: level === null ? null : (level <= 1 ? level * 100 : level),
      laedt: typeof loc?.battery?.is_charging === "boolean" ? loc.battery.is_charging : null,
    });
  }
  return punkte;
}

async function empfangen(req: Request, url: URL) {
  const punkte: Punkt[] = [];
  const ausQuery = ausParametern(url.searchParams);
  if (ausQuery) punkte.push(ausQuery);

  if (req.method === "POST") {
    const text = await req.text();
    if (text.trim()) {
      const typ = req.headers.get("content-type") ?? "";
      if (typ.includes("json") || text.trim().startsWith("{")) {
        try {
          punkte.push(...ausJson(JSON.parse(text), url.searchParams.get("id")));
        } catch { /* kein gültiges JSON */ }
      } else {
        const p = ausParametern(new URLSearchParams(text));
        if (p) punkte.push(p);
      }
    }
  }

  if (punkte.length === 0) return json({ fehler: "keine Position" }, 400);

  const token = punkte.find((p) => p.token)?.token;
  if (!token) return json({ fehler: "unbekanntes Gerät" }, 403);
  const [geraet] = await sql`select id from privat.tour_geraete where sende_token = ${token}`;
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);

  // Doppelt gesendete Punkte (gleiche Aufnahmezeit) werden übersprungen,
  // trotzdem mit "ok" beantwortet, damit die App nicht endlos neu sendet.
  let gespeichert = 0;
  for (const p of punkte) {
    if (p.token && p.token !== token) continue;
    const r = await sql`
      insert into privat.tour_positionen
        (geraet_id, aufgenommen_am, lat, lng, geschwindigkeit_kmh, richtung, hoehe_m, genauigkeit_m, akku_prozent, laedt)
      select ${geraet.id}, ${p.zeit}, ${p.lat}, ${p.lng}, ${p.kmh}, ${p.richtung}, ${p.hoehe}, ${p.genauigkeit}, ${p.akku}, ${p.laedt}
      where not exists (
        select 1 from privat.tour_positionen
        where geraet_id = ${geraet.id} and aufgenommen_am = ${p.zeit})
      returning id`;
    gespeichert += r.length;
  }
  return json({ ok: true, gespeichert });
}

async function ansehen(url: URL) {
  const token = url.searchParams.get("ansicht")!;
  const [geraet] = await sql`select id, name from privat.tour_geraete where ansicht_token = ${token}`;
  if (!geraet) return json({ fehler: "Link ungültig" }, 403);

  // Zeitraum: die letzten 18 Stunden. "seit" ist die laufende Nummer des zuletzt
  // abgeholten Punkts, damit nach einem Funkloch nachgereichte Punkte auch ankommen.
  const ab = new Date(Date.now() - 18 * 3600 * 1000);
  const seit = Math.max(0, Math.floor(Number(url.searchParams.get("seit")) || 0));

  const rows = await sql`
    select id, aufgenommen_am, lat, lng, geschwindigkeit_kmh, richtung, hoehe_m, genauigkeit_m, akku_prozent, laedt
    from privat.tour_positionen
    where geraet_id = ${geraet.id} and aufgenommen_am > ${ab} and id > ${seit}
    order by id
    limit 20000`;

  const fotosSeit = Math.max(0, Math.floor(Number(url.searchParams.get("fotos_seit")) || 0));
  const fotos = await sql`
    select id, aufgenommen_am, lat, lng, titel
    from privat.tour_fotos
    where geraet_id = ${geraet.id} and aufgenommen_am > ${ab} and id > ${fotosSeit}
    order by id`;

  return json({
    name: geraet.name,
    fotos_cursor: fotos.length ? Number(fotos[fotos.length - 1].id) : fotosSeit,
    fotos: fotos.map((f) => ({ id: Number(f.id), t: f.aufgenommen_am, lat: f.lat, lng: f.lng, titel: f.titel })),
    cursor: rows.length ? Number(rows[rows.length - 1].id) : seit,
    positionen: rows.map((r) => ({
      t: r.aufgenommen_am,
      lat: r.lat,
      lng: r.lng,
      kmh: r.geschwindigkeit_kmh,
      richtung: r.richtung,
      hoehe: r.hoehe_m,
      genau: r.genauigkeit_m,
      akku: r.akku_prozent,
      laedt: r.laedt,
    })),
  });
}

const MAX_BILD = 6 * 1024 * 1024;

async function fotoHochladen(req: Request, url: URL) {
  const token = url.searchParams.get("id");
  if (!token) return json({ fehler: "unbekanntes Gerät" }, 403);
  const [geraet] = await sql`select id from privat.tour_geraete where sende_token = ${token}`;
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);

  const form = await req.formData();
  const bild = form.get("bild"), vorschau = form.get("vorschau");
  if (!(bild instanceof File) || !(vorschau instanceof File)) return json({ fehler: "Bild fehlt" }, 400);
  if (bild.size > MAX_BILD || vorschau.size > MAX_BILD) return json({ fehler: "Bild zu groß" }, 413);
  if (!bild.type.startsWith("image/") || !vorschau.type.startsWith("image/")) return json({ fehler: "kein Bild" }, 415);

  const zeit = zeitAus(form.get("zeit"));
  const titel = String(form.get("titel") ?? "").trim().slice(0, 300) || null;

  // Ort: Streckenpunkt, der zeitlich am nächsten an der Aufnahme liegt (max. 15 Min.),
  // sonst der Standort des Handys beim Hochladen, sonst der letzte bekannte Punkt.
  let lat: number | null = null, lng: number | null = null;
  const [nah] = await sql`
    select lat, lng from privat.tour_positionen
    where geraet_id = ${geraet.id}
      and aufgenommen_am between ${new Date(zeit.getTime() - 15 * 60000)} and ${new Date(zeit.getTime() + 15 * 60000)}
    order by abs(extract(epoch from (aufgenommen_am - ${zeit}::timestamptz)))
    limit 1`;
  if (nah) { lat = nah.lat; lng = nah.lng; }
  else {
    const fl = zahl(form.get("lat")), fg = zahl(form.get("lng"));
    if (fl !== null && fg !== null) { lat = fl; lng = fg; }
    else {
      const [letzter] = await sql`
        select lat, lng from privat.tour_positionen where geraet_id = ${geraet.id}
        order by aufgenommen_am desc limit 1`;
      if (letzter) { lat = letzter.lat; lng = letzter.lng; }
    }
  }

  const [neu] = await sql`
    insert into privat.tour_fotos (geraet_id, aufgenommen_am, lat, lng, titel, bild, vorschau)
    values (${geraet.id}, ${zeit}, ${lat}, ${lng}, ${titel},
            ${new Uint8Array(await bild.arrayBuffer())}, ${new Uint8Array(await vorschau.arrayBuffer())})
    returning id`;
  return json({ ok: true, id: Number(neu.id), lat, lng });
}

async function fotoLiefern(url: URL) {
  const token = url.searchParams.get("ansicht")!;
  const id = Math.floor(Number(url.searchParams.get("foto")) || 0);
  const klein = url.searchParams.get("klein") === "1";
  const [f] = klein
    ? await sql`select f.vorschau as daten from privat.tour_fotos f join privat.tour_geraete g on g.id = f.geraet_id
                where g.ansicht_token = ${token} and f.id = ${id}`
    : await sql`select f.bild as daten from privat.tour_fotos f join privat.tour_geraete g on g.id = f.geraet_id
                where g.ansicht_token = ${token} and f.id = ${id}`;
  if (!f) return json({ fehler: "nicht gefunden" }, 404);
  return new Response(f.daten, {
    headers: { ...cors, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=604800, immutable" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.has("ansicht") && url.searchParams.has("foto")) return await fotoLiefern(url);
    if (req.method === "GET" && url.searchParams.has("ansicht")) return await ansehen(url);
    if (req.method === "POST" && url.searchParams.has("foto")) return await fotoHochladen(req, url);
    if (req.method === "GET" || req.method === "POST") return await empfangen(req, url);
    return json({ fehler: "Methode nicht erlaubt" }, 405);
  } catch (e) {
    console.error(e);
    return json({ fehler: "Serverfehler" }, 500);
  }
});
