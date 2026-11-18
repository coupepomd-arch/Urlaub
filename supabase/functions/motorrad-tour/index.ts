// Empfängt Positionen vom Handy (Traccar Client) und liefert sie an die Live-Seite.
//
// Senden:  GET/POST  .../motorrad-tour?id=<SENDE_TOKEN oder ERSATZ_TOKEN>&lat=..&lon=..   (OsmAnd-Format)
//          Das Ersatz-Handy wird nur gespeichert, wenn das Haupt-Handy 90 s lang nichts gesendet hat.
//          POST      .../motorrad-tour  JSON {device_id, location:{coords:{...}, battery:{...}}}
// Lesen:   GET       .../motorrad-tour?ansicht=<ANSICHT_TOKEN>[&datum=JJJJ-MM-TT][&seit=<Nr>][&fotos_seit=<Nr>][&kommentare_seit=<Nr>]
// Reisebuch: GET     .../motorrad-tour?ansicht=<ANSICHT_TOKEN>&tage=1
// Foto hochladen: POST .../motorrad-tour?id=<SENDE_TOKEN>&foto=1  (multipart: bild, vorschau, zeit, titel, gps_lat, gps_lng, lat, lng)
// Foto ansehen:   GET  .../motorrad-tour?ansicht=<ANSICHT_TOKEN>&foto=<Nr>[&klein=1]
// Kommentar:      POST .../motorrad-tour?ansicht=<ANSICHT_TOKEN>&kommentar=1  JSON {name, text, foto_id?}
//                 POST .../motorrad-tour?id=<SENDE_TOKEN>&kommentar=1         (Antwort vom Fahrer)
// Kommentare für den Fahrer: GET .../motorrad-tour?id=<SENDE_TOKEN>&kommentare=1[&kommentare_seit=<Nr>]
// Schnellmeldung vom Fahrer: POST .../motorrad-tour?id=<SENDE_TOKEN>&kommentar=1  JSON {art, lat?, lng?}
// Reaktion umschalten:       POST .../motorrad-tour?ansicht=<ANSICHT_TOKEN>&reaktion=1  JSON {ziel_typ, ziel_id, emoji, wer}
// GPX-Strecke hochladen:     POST .../motorrad-tour?id=<SENDE_TOKEN>&gpx=1  (multipart: datei, oder die GPX-Datei als Rohtext)
//                            Innerhalb der GPX-Zeitfenster gilt die GPX-Strecke, davor/danach füllen Live-Punkte auf.
//                            Mehrere Dateien pro Tag werden kombiniert; eine Datei mit überlappender Zeit ersetzt die alte.
// GPX-Dateien auflisten:     GET  .../motorrad-tour?id=<SENDE_TOKEN>&gpx_liste=1
// GPX-Datei entfernen:       POST .../motorrad-tour?id=<SENDE_TOKEN>&gpx_entfernen=1  JSON {id}   (Live-Daten bleiben erhalten)
// Orte in der Nähe:          GET  .../motorrad-tour?id=<SENDE_TOKEN>&orte=1&lat=..&lng=..[&art=essen]  (OpenStreetMap)
// Ort festlegen:             POST .../motorrad-tour?id=<SENDE_TOKEN>&ort_setzen=1  JSON {ziel: "kommentar"|"foto", ziel_id, name?, typ?, ortschaft?}
//                            Meldungen und Fotos bekommen außerdem automatisch den Ortsnamen (ortschaft).
import postgres from "npm:postgres@3.4.5";
import { ausduennen, auswerten, type Fenster, gpxLesen, imFenster, liveAuswerten, miniLinie, tempoSetzen } from "./gpx.ts";
import { ortschaftHolen, orteInDerNaehe } from "./orte.ts";

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

// maxTageAlt: wie weit eine Zeit in der Vergangenheit liegen darf (Fotos dürfen später nachgereicht werden)
function zeitAus(v: unknown, maxTageAlt = 7): Date {
  if (v === null || v === undefined || v === "") return new Date();
  const n = Number(v);
  let d: Date;
  if (Number.isFinite(n)) d = new Date(n > 1e12 ? n : n * 1000);
  else d = new Date(String(v));
  // Ungültige, zu alte oder zukünftige Zeiten durch Serverzeit ersetzen
  const diff = Date.now() - (d.getTime() || 0);
  if (isNaN(d.getTime()) || diff > maxTageAlt * 24 * 3600 * 1000 || diff < -24 * 3600 * 1000) return new Date();
  return d;
}

const koordinate = (lat: number | null, lng: number | null) =>
  lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

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
  // Haupt-Handy (sende_token) oder Ersatz-Handy (ersatz_token)
  const [geraet] = await sql`
    select id, (sende_token = ${token}) as haupt from privat.tour_geraete
    where sende_token = ${token} or ersatz_token = ${token}`;
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);
  const quelle = geraet.haupt ? "haupt" : "ersatz";

  // Das Ersatz-Handy übernimmt nur, wenn das Haupt-Handy in den letzten 90 Sekunden nichts gesendet hat.
  // Seine Punkte werden sonst still verworfen (mit "ok", damit die App nicht endlos neu sendet).
  if (!geraet.haupt) {
    const [aktiv] = await sql`
      select 1 from privat.tour_positionen
      where geraet_id = ${geraet.id} and quelle = 'haupt' and empfangen_am > now() - interval '90 seconds'
      limit 1`;
    if (aktiv) return json({ ok: true, gespeichert: 0, hinweis: "Haupt-Handy aktiv" });
  }

  // Doppelt gesendete Punkte (gleiche Aufnahmezeit) werden übersprungen,
  // trotzdem mit "ok" beantwortet, damit die App nicht endlos neu sendet.
  let gespeichert = 0;
  for (const p of punkte) {
    if (p.token && p.token !== token) continue;
    const r = await sql`
      insert into privat.tour_positionen
        (geraet_id, aufgenommen_am, lat, lng, geschwindigkeit_kmh, richtung, hoehe_m, genauigkeit_m, akku_prozent, laedt, quelle)
      select ${geraet.id}, ${p.zeit}, ${p.lat}, ${p.lng}, ${p.kmh}, ${p.richtung}, ${p.hoehe}, ${p.genauigkeit}, ${p.akku}, ${p.laedt}, ${quelle}
      where not exists (
        select 1 from privat.tour_positionen
        where geraet_id = ${geraet.id} and aufgenommen_am = ${p.zeit})
      returning id`;
    gespeichert += r.length;
  }
  return json({ ok: true, gespeichert });
}

const datumOk = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? v : null;

async function geraetFuerAnsicht(token: string | null) {
  const [g] = await sql`
    select id, name, titel, zeitzone, reise_start::text as reise_start, (now() at time zone zeitzone)::date::text as heute
    from privat.tour_geraete where ansicht_token = ${token}`;
  return g;
}

async function ansehen(url: URL) {
  const g = await geraetFuerAnsicht(url.searchParams.get("ansicht"));
  if (!g) return json({ fehler: "Link ungültig" }, 403);
  if (url.searchParams.has("tage")) return await tageListe(g);

  // Ein Kalendertag in der Zeitzone der Reise. Ohne Angabe: heute.
  const datum = datumOk(url.searchParams.get("datum")) ?? g.heute;
  const [{ von, bis }] = await sql`
    select (${datum}::date::timestamp at time zone ${g.zeitzone}) as von,
           ((${datum}::date + 1)::timestamp at time zone ${g.zeitzone}) as bis`;
  const nummer = (name: string) => Math.max(0, Math.floor(Number(url.searchParams.get(name)) || 0));
  const seit = nummer("seit"), fotosSeit = nummer("fotos_seit"), kSeit = nummer("kommentare_seit");

  // GPX-Teile des Tages: innerhalb ihrer Zeitfenster ersetzen sie die Live-Punkte, außerhalb bleiben die Live-Punkte.
  const gpxTeile = await sql`
    select id, name, km, fahrzeit_s, max_kmh, anstieg_m, abstieg_m, hoehe_max, hoehe_max_lat, hoehe_max_lng, start, ende
    from privat.tour_gpx where geraet_id = ${g.id} and tag = ${datum}::date order by start`;
  let rows: any[], cursorNeu: number, gpxInfo: Record<string, unknown> | null = null;
  if (gpxTeile.length) {
    const fenster: Fenster[] = gpxTeile.map((x) => ({ start: x.start.getTime(), ende: x.ende.getTime() }));
    const liveAlle = await sql`
      select id, aufgenommen_am, lat, lng, geschwindigkeit_kmh, richtung, hoehe_m, genauigkeit_m, akku_prozent, laedt
      from privat.tour_positionen
      where geraet_id = ${g.id} and aufgenommen_am >= ${von} and aufgenommen_am < ${bis}
      order by aufgenommen_am
      limit 50000`;
    const liveRest = liveAlle.filter((r) => !imFenster(r.aufgenommen_am.getTime(), fenster));
    const gpxPunkte = seit > 0 ? [] : await sql`
      select t as aufgenommen_am, lat, lng, kmh as geschwindigkeit_kmh, hoehe as hoehe_m
      from privat.tour_gpx_punkte where gpx_id in ${sql(gpxTeile.map((x) => x.id))} order by t`;
    rows = seit > 0 ? liveRest.filter((r) => Number(r.id) > seit) : [...gpxPunkte, ...liveRest];
    const [{ max }] = await sql`select coalesce(max(id), 0)::bigint as max from privat.tour_positionen where geraet_id = ${g.id}`;
    cursorNeu = Math.max(1, seit, Number(max));

    // Tageswerte: GPX-Teile + Live-Rest
    const rest = liveAuswerten(liveRest.map((r) => ({
      t: r.aufgenommen_am.getTime(), lat: r.lat, lng: r.lng, kmh: r.geschwindigkeit_kmh, hoehe: r.hoehe_m, genau: r.genauigkeit_m,
    })), fenster);
    const summe = (f: string) => gpxTeile.reduce((a, x) => a + (Number(x[f]) || 0), 0);
    const hoechsterGpx = gpxTeile.reduce((m, x) => (x.hoehe_max != null && (m == null || x.hoehe_max > m.hoehe_max) ? x : m), null as any);
    const hoch = rest.hoehe_max && (!hoechsterGpx || (rest.hoehe_max.hoehe as number) > hoechsterGpx.hoehe_max)
      ? { h: rest.hoehe_max.hoehe, lat: rest.hoehe_max.lat, lng: rest.hoehe_max.lng }
      : hoechsterGpx ? { h: hoechsterGpx.hoehe_max, lat: hoechsterGpx.hoehe_max_lat, lng: hoechsterGpx.hoehe_max_lng } : null;
    const zeiten = [...gpxTeile.map((x) => x.start.getTime()), ...gpxTeile.map((x) => x.ende.getTime()),
      ...liveRest.map((r) => r.aufgenommen_am.getTime())];
    gpxInfo = {
      name: gpxTeile.map((x) => x.name).filter(Boolean).join(" + ") || null,
      teile: gpxTeile.length,
      km: Math.round((summe("km") + rest.km) * 100) / 100,
      live_km: Math.round(rest.km * 100) / 100,
      fahrzeit_s: Math.round(summe("fahrzeit_s") + rest.fahrzeit_s),
      max_kmh: Math.round(Math.max(rest.max_kmh, ...gpxTeile.map((x) => Number(x.max_kmh) || 0))),
      anstieg_m: summe("anstieg_m"), abstieg_m: summe("abstieg_m"),
      hoehe_max: hoch?.h ?? null, hoehe_max_lat: hoch?.lat ?? null, hoehe_max_lng: hoch?.lng ?? null,
      start: new Date(Math.min(...zeiten)), ende: new Date(Math.max(...zeiten)),
    };
  } else {
    rows = await sql`
      select id, aufgenommen_am, lat, lng, geschwindigkeit_kmh, richtung, hoehe_m, genauigkeit_m, akku_prozent, laedt
      from privat.tour_positionen
      where geraet_id = ${g.id} and aufgenommen_am >= ${von} and aufgenommen_am < ${bis} and id > ${seit}
      order by id
      limit 50000`;
    cursorNeu = rows.length ? Number(rows[rows.length - 1].id) : seit;
  }

  const fotos = await sql`
    select id, aufgenommen_am, lat, lng, titel, ortschaft, platz, platz_typ
    from privat.tour_fotos
    where geraet_id = ${g.id} and aufgenommen_am >= ${von} and aufgenommen_am < ${bis} and id > ${fotosSeit}
    order by id`;

  const kommentare = await kommentareLaden(g.id, kSeit, datum);

  // Reaktionen auf Fotos und Kommentare dieses Tages (immer vollständig, sind wenige)
  const wer = String(url.searchParams.get("wer") ?? "");
  const reaktionen = await sql`
    select r.ziel_typ, r.ziel_id, r.emoji, count(*)::int as anzahl, bool_or(r.wer = ${wer}) as ich
    from privat.tour_reaktionen r
    where r.geraet_id = ${g.id} and (
      (r.ziel_typ = 'foto' and r.ziel_id in (
         select id from privat.tour_fotos where geraet_id = ${g.id} and aufgenommen_am >= ${von} and aufgenommen_am < ${bis}))
      or (r.ziel_typ = 'kommentar' and r.ziel_id in (
         select id from privat.tour_kommentare where geraet_id = ${g.id} and tag = ${datum}::date)))
    group by 1, 2, 3`;

  // Orte von Fotos und Meldungen dieses Tages (immer vollständig, da sie nachträglich gesetzt werden können)
  const orte = await sql`
    select 'foto' as typ, id, ortschaft, platz, platz_typ from privat.tour_fotos
    where geraet_id = ${g.id} and aufgenommen_am >= ${von} and aufgenommen_am < ${bis} and (ortschaft is not null or platz is not null)
    union all
    select 'kommentar', id, ortschaft, platz, platz_typ from privat.tour_kommentare
    where geraet_id = ${g.id} and tag = ${datum}::date and (ortschaft is not null or platz is not null)`;

  return json({
    orte: orte.map((o) => ({ typ: o.typ, id: Number(o.id), ortschaft: o.ortschaft, platz: o.platz, platz_typ: o.platz_typ })),
    name: g.name,
    titel: g.titel,
    reaktionen: reaktionen.map((r) => ({ typ: r.ziel_typ, id: Number(r.ziel_id), emoji: r.emoji, anzahl: r.anzahl, ich: r.ich })),
    datum,
    heute: g.heute,
    kommentare_cursor: kommentare.length ? kommentare[kommentare.length - 1].id : kSeit,
    kommentare,
    fotos_cursor: fotos.length ? Number(fotos[fotos.length - 1].id) : fotosSeit,
    fotos: fotos.map((f) => ({ id: Number(f.id), t: f.aufgenommen_am, lat: f.lat, lng: f.lng, titel: f.titel,
      ortschaft: f.ortschaft, platz: f.platz, platz_typ: f.platz_typ })),
    gpx: gpxInfo,
    cursor: cursorNeu,
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

// Reisebuch: eine Zeile pro Tag mit Strecke, Fahrzeit, Höchsttempo, Fotos und Kommentaren
async function tageListe(g: { id: number; zeitzone: string; reise_start: string | null; heute: string; titel: string }) {
  const ab = g.reise_start ?? "1970-01-01";
  const rows = await sql`
    with p0 as (   -- Live-Punkte; in_gpx = liegt im Zeitfenster eines hochgeladenen GPX-Teils
      select (t.aufgenommen_am at time zone ${g.zeitzone})::date as tag, t.aufgenommen_am, t.lat, t.lng, t.geschwindigkeit_kmh, t.hoehe_m,
             exists (select 1 from privat.tour_gpx gw where gw.geraet_id = ${g.id}
                     and t.aufgenommen_am between gw.start - interval '60 seconds' and gw.ende + interval '60 seconds') as in_gpx
      from privat.tour_positionen t
      where t.geraet_id = ${g.id} and (t.genauigkeit_m is null or t.genauigkeit_m <= 60)
        and t.aufgenommen_am >= (${ab}::date::timestamp at time zone ${g.zeitzone})
    ),
    p as (
      select *, lag(lat) over w as plat, lag(lng) over w as plng, lag(aufgenommen_am) over w as pt, lag(in_gpx) over w as p_in_gpx
      from p0 window w as (partition by tag order by aufgenommen_am)
    ),
    d as (
      select *, extract(epoch from aufgenommen_am - pt) as dt,
             2 * 6371 * asin(sqrt(power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lng - plng) / 2), 2))) as km,
             -- Teilstück zählt als "außerhalb GPX", wenn beide Punkte draußen liegen und kein GPX-Teil dazwischen liegt
             (not in_gpx and not coalesce(p_in_gpx, false) and not exists (
                select 1 from privat.tour_gpx gw where gw.geraet_id = ${g.id} and gw.start > p.pt and gw.ende < p.aufgenommen_am)) as aussen
      from p
    ),
    strecke as (
      select tag, min(aufgenommen_am) as start, max(aufgenommen_am) as ende,
        coalesce(sum(km) filter (where km > 0.005 and dt > 0 and km / (dt / 3600) < 300), 0) as km,
        coalesce(sum(dt) filter (where dt > 0 and dt < 180 and km / (dt / 3600) > 4), 0) as fahrzeit_s,
        max(geschwindigkeit_kmh) filter (where geschwindigkeit_kmh < 300) as max_kmh,
        max(hoehe_m) as hoehe_max,
        coalesce(sum(km) filter (where aussen and km > 0.005 and dt > 0 and km / (dt / 3600) < 300), 0) as km_aussen,
        coalesce(sum(dt) filter (where aussen and dt > 0 and dt < 180 and km / (dt / 3600) > 4), 0) as fz_aussen,
        max(geschwindigkeit_kmh) filter (where aussen and geschwindigkeit_kmh < 300) as max_aussen,
        max(hoehe_m) filter (where not in_gpx) as hoehe_aussen
      from d group by tag
    ),
    gx as (   -- alle GPX-Teile eines Tages zusammengefasst
      select tag, min(start) as start, max(ende) as ende, sum(km) as km, sum(fahrzeit_s) as fahrzeit_s, max(max_kmh) as max_kmh,
             sum(anstieg_m) as anstieg_m, max(hoehe_max) as hoehe_max,
             jsonb_agg(linie order by start) as linien
      from privat.tour_gpx where geraet_id = ${g.id} and tag >= ${ab}::date
      group by tag
    ),
    fotos as (
      select (aufgenommen_am at time zone ${g.zeitzone})::date as tag, count(*) as anzahl,
             (array_agg(id order by aufgenommen_am))[1:8] as ids
      from privat.tour_fotos
      where geraet_id = ${g.id} and aufgenommen_am >= (${ab}::date::timestamp at time zone ${g.zeitzone})
      group by 1
    ),
    kom as (
      select tag, count(*) as anzahl from privat.tour_kommentare
      where geraet_id = ${g.id} and tag >= ${ab}::date group by 1
    ),
    linie as (   -- vereinfachte Strecke (ca. 80 Punkte) für die Mini-Karte
      select tag, json_agg(json_build_array(round(lat::numeric, 5), round(lng::numeric, 5)) order by aufgenommen_am) as punkte
      from (select tag, lat, lng, aufgenommen_am,
                   row_number() over (partition by tag order by aufgenommen_am) as rn,
                   count(*) over (partition by tag) as n
            from p) x
      where (rn - 1) % greatest(1, ceil(n / 80.0)::int) = 0 or rn = n
      group by tag
    ),
    titelfoto as (   -- Foto mit den meisten Reaktionen, sonst das erste des Tages
      select distinct on (tag) tag, id from (
        select (f.aufgenommen_am at time zone ${g.zeitzone})::date as tag, f.id, f.aufgenommen_am,
               (select count(*) from privat.tour_reaktionen r
                where r.geraet_id = f.geraet_id and r.ziel_typ = 'foto' and r.ziel_id = f.id) as rk
        from privat.tour_fotos f
        where f.geraet_id = ${g.id} and f.aufgenommen_am >= (${ab}::date::timestamp at time zone ${g.zeitzone})) y
      order by tag, rk desc, aufgenommen_am
    ),
    zitate as (   -- die zwei neuesten richtigen Kommentare (keine Schnellmeldungen)
      select tag, json_agg(json_build_object('name', name, 'text', text, 'fahrer', vom_fahrer) order by id desc) as liste
      from (select tag, name, text, vom_fahrer, id, row_number() over (partition by tag order by id desc) as rn
            from privat.tour_kommentare where geraet_id = ${g.id} and tag >= ${ab}::date and art is null) z
      where rn <= 2
      group by tag
    ),
    stationen as (   -- Schnellmeldungen mit Ort (ohne "Alles gut" und "Weiter geht's")
      select tag, json_agg(json_build_object('t', erstellt_am, 'art', art, 'text', text, 'ortschaft', ortschaft,
                                             'platz', platz, 'platz_typ', platz_typ, 'lat', lat, 'lng', lng) order by id) as liste
      from privat.tour_kommentare
      where geraet_id = ${g.id} and tag >= ${ab}::date and art is not null and art not in ('gut', 'weiter')
      group by tag
    ),
    tage as (select tag from strecke union select tag from fotos union select tag from kom union select tag from gx)
    select t.tag::text as datum, row_number() over (order by t.tag)::int as nr,
           least(gx.start, s.start) as start, greatest(gx.ende, s.ende) as ende,
           -- Mini-Karte: die Live-Linie zeigt den ganzen Tag; ohne Live-Daten die GPX-Teile aneinandergehängt
           coalesce(l.punkte::jsonb, (select jsonb_agg(e) from jsonb_array_elements(gx.linien) teil, jsonb_array_elements(teil) e), '[]'::jsonb) as linie,
           tf.id as titelfoto, coalesce(zi.liste, '[]'::json) as zitate, coalesce(st.liste, '[]'::json) as stationen,
           round((case when gx.tag is not null then gx.km + coalesce(s.km_aussen, 0) else coalesce(s.km, 0) end)::numeric, 2)::float8 as km,
           (case when gx.tag is not null then gx.fahrzeit_s + coalesce(s.fz_aussen, 0) else coalesce(s.fahrzeit_s, 0) end)::int as fahrzeit_s,
           round(greatest(gx.max_kmh, case when gx.tag is not null then s.max_aussen else s.max_kmh end)::numeric)::int as max_kmh,
           round(gx.anstieg_m::numeric)::int as anstieg_m,
           round(greatest(gx.hoehe_max, case when gx.tag is not null then s.hoehe_aussen else s.hoehe_max end)::numeric)::int as hoehe_max,
           (gx.tag is not null) as gpx,
           coalesce(f.anzahl, 0)::int as fotos, coalesce(f.ids, '{}') as foto_ids, coalesce(k.anzahl, 0)::int as kommentare
    from tage t
    left join strecke s using (tag) left join fotos f using (tag) left join kom k using (tag)
    left join linie l using (tag) left join titelfoto tf using (tag) left join zitate zi using (tag)
    left join gx using (tag) left join stationen st using (tag)
    order by t.tag`;
  // Fun-Facts-Seite am Ende des Reisebuchs (Texte in privat.tour_geraete.fakten, nicht im öffentlichen Code)
  const [{ fakten }] = await sql`select fakten from privat.tour_geraete where id = ${g.id}`;
  return json({
    titel: g.titel,
    heute: g.heute,
    reise_start: g.reise_start,
    fakten: fakten ?? null,
    tage: rows.map((r) => ({ ...r, foto_ids: (r.foto_ids as unknown[]).map(Number), titelfoto: r.titelfoto === null ? null : Number(r.titelfoto) })),
  });
}

async function kommentareLaden(geraetId: number, seit: number, tag: string) {
  const rows = await sql`
    select k.id, k.erstellt_am, k.tag::text as tag, k.name, k.text, k.foto_id, k.vom_fahrer, k.art, k.lat, k.lng, k.ortschaft, k.platz, k.platz_typ, f.aufgenommen_am as foto_t
    from privat.tour_kommentare k
    left join privat.tour_fotos f on f.id = k.foto_id
    where k.geraet_id = ${geraetId} and k.tag = ${tag}::date and k.id > ${seit}
    order by k.id
    limit 2000`;
  return rows.map(kommentarJson);
}

function kommentarJson(k: Record<string, any>) {
  return {
    id: Number(k.id), t: k.erstellt_am, tag: k.tag, name: k.name, text: k.text,
    foto_id: k.foto_id === null ? null : Number(k.foto_id), foto_t: k.foto_t, fahrer: k.vom_fahrer,
    art: k.art, lat: k.lat, lng: k.lng, ortschaft: k.ortschaft, platz: k.platz, platz_typ: k.platz_typ,
  };
}

const MELDUNGEN: Record<string, string> = {
  gut: "👍 Alles gut!",
  pause: "☕ Kaffeepause",
  tanken: "⛽ Tanken",
  essen: "🍽️ Essenspause",
  foto: "📸 Fotostopp",
  aussicht: "🌋 Aussicht genießen",
  weiter: "🏍️ Weiter geht's!",
  angekommen: "🏁 Angekommen",
};

async function kommentarSchreiben(req: Request, url: URL) {
  const ansicht = url.searchParams.get("ansicht"), sende = url.searchParams.get("id");
  let geraet: { id: number; heute: string } | undefined, fahrer = false;
  if (sende) {
    [geraet] = await sql`select id, (now() at time zone zeitzone)::date::text as heute from privat.tour_geraete where sende_token = ${sende}`;
    fahrer = true;
  } else if (ansicht) {
    [geraet] = await sql`select id, (now() at time zone zeitzone)::date::text as heute from privat.tour_geraete where ansicht_token = ${ansicht}`;
  }
  if (!geraet) return json({ fehler: "Link ungültig" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ fehler: "ungültige Daten" }, 400); }
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || (fahrer ? "Fahrer" : "");
  // Schnellmeldungen (nur vom Fahrer): feste Arten mit Standardtext
  const art = fahrer && typeof body?.art === "string" && MELDUNGEN[body.art] ? body.art : null;
  const text = (String(body?.text ?? "").trim() || (art ? MELDUNGEN[art] : "")).slice(0, 500);
  if (!name) return json({ fehler: "Name fehlt" }, 400);
  if (!text) return json({ fehler: "Text fehlt" }, 400);
  // Kommentar gehört zu dem Tag, den man gerade ansieht (nicht in der Zukunft)
  let tag = datumOk(body?.tag) ?? geraet.heute;
  if (tag > geraet.heute) tag = geraet.heute;

  let fotoId: number | null = null;
  if (body?.foto_id != null) {
    const [f] = await sql`select id from privat.tour_fotos where id = ${Math.floor(Number(body.foto_id)) || 0} and geraet_id = ${geraet.id}`;
    if (f) fotoId = Number(f.id);
  }

  // Einfacher Spamschutz: höchstens 20 Kommentare pro Minute insgesamt
  const [{ anzahl }] = await sql`
    select count(*)::int as anzahl from privat.tour_kommentare
    where geraet_id = ${geraet.id} and erstellt_am > now() - interval '1 minute'`;
  if (anzahl >= 20) return json({ fehler: "Zu viele Kommentare, bitte kurz warten" }, 429);

  // Meldungen bekommen einen Ort: vom Handy, sonst die letzte Streckenposition
  let lat: number | null = null, lng: number | null = null;
  if (art) {
    const bl = zahl(body?.lat), bg = zahl(body?.lng);
    if (koordinate(bl, bg)) { lat = bl; lng = bg; }
    else {
      const [letzter] = await sql`
        select lat, lng from privat.tour_positionen where geraet_id = ${geraet.id}
        order by aufgenommen_am desc limit 1`;
      if (letzter) { lat = letzter.lat; lng = letzter.lng; }
    }
  }

  const [neu] = await sql`
    insert into privat.tour_kommentare (geraet_id, name, text, foto_id, vom_fahrer, tag, art, lat, lng)
    values (${geraet.id}, ${name}, ${text}, ${fotoId}, ${fahrer}, ${tag}::date, ${art}, ${lat}, ${lng})
    returning id`;
  if (art && lat != null && lng != null) nebenbei(ortschaftNachtragen("kommentar", Number(neu.id), lat, lng));
  return json({ ok: true, id: Number(neu.id), lat, lng });
}

// ---------- Orte ----------
// Arbeit nach der Antwort weiterlaufen lassen (Edge Runtime), damit das Handy nicht warten muss
function nebenbei(p: Promise<unknown>) {
  const laufzeit = (globalThis as any).EdgeRuntime;
  if (laufzeit?.waitUntil) laufzeit.waitUntil(p);
}

async function ortschaftNachtragen(ziel: "kommentar" | "foto", id: number, lat: number, lng: number) {
  try {
    const o = await ortschaftHolen(lat, lng);
    if (!o) return;
    if (ziel === "kommentar") await sql`update privat.tour_kommentare set ortschaft = ${o} where id = ${id} and ortschaft is null`;
    else await sql`update privat.tour_fotos set ortschaft = ${o} where id = ${id} and ortschaft is null`;
  } catch (e) {
    console.error("Ortschaft", e);
  }
}

async function sendeGeraet(url: URL) {
  const token = url.searchParams.get("id");
  if (!token) return null;
  const [g] = await sql`select id from privat.tour_geraete where sende_token = ${token}`;
  return g ? { id: Number(g.id) } : null;
}

// Lokale, Tankstellen, Aussichtspunkte … in der Nähe, zur Auswahl auf der Fahrer-Seite
async function orteLiefern(url: URL) {
  if (!(await sendeGeraet(url))) return json({ fehler: "unbekanntes Gerät" }, 403);
  const lat = zahl(url.searchParams.get("lat")), lng = zahl(url.searchParams.get("lng"));
  if (!koordinate(lat, lng)) return json({ fehler: "Ort fehlt" }, 400);
  const art = url.searchParams.get("art");
  const [orte, ortschaft] = await Promise.all([orteInDerNaehe(lat!, lng!, art), ortschaftHolen(lat!, lng!)]);
  return json({ ok: orte !== null, ortschaft, orte: orte ?? [] });
}

// Ort festlegen: "name" (+ "typ") setzt das gewählte Lokal (leer = entfernen), "ortschaft" den Ortsnamen.
// Die Fahrer-Seite fragt OpenStreetMap direkt vom Handy ab (Cloud-Adressen werden dort oft gesperrt) und schickt das Ergebnis.
async function ortSetzen(req: Request, url: URL) {
  const geraet = await sendeGeraet(url);
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);
  let body: any;
  try { body = await req.json(); } catch { return json({ fehler: "ungültige Daten" }, 400); }
  const id = Math.floor(Number(body?.ziel_id)) || 0;
  const mitName = body != null && typeof body === "object" && "name" in body;
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const typ = name ? String(body?.typ ?? "").replace(/[^a-z_]/g, "").slice(0, 30) || null : null;
  const ortschaft = String(body?.ortschaft ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  if (!mitName && !ortschaft) return json({ fehler: "nichts zu speichern" }, 400);
  let rows;
  if (body?.ziel === "kommentar") {
    rows = await sql`update privat.tour_kommentare
                     set platz = case when ${mitName} then ${name} else platz end,
                         platz_typ = case when ${mitName} then ${typ} else platz_typ end,
                         ortschaft = coalesce(${ortschaft}, ortschaft)
                     where id = ${id} and geraet_id = ${geraet.id} returning id, lat, lng, ortschaft, platz, platz_typ`;
  } else if (body?.ziel === "foto") {
    rows = await sql`update privat.tour_fotos
                     set platz = case when ${mitName} then ${name} else platz end,
                         platz_typ = case when ${mitName} then ${typ} else platz_typ end,
                         ortschaft = coalesce(${ortschaft}, ortschaft)
                     where id = ${id} and geraet_id = ${geraet.id} returning id, lat, lng, ortschaft, platz, platz_typ`;
  } else return json({ fehler: "Ziel fehlt" }, 400);
  if (!rows.length) return json({ fehler: "nicht gefunden" }, 404);
  const r = rows[0];
  // Falls die Ortschaft noch fehlt (z. B. alte Einträge), auf dem Server versuchen
  if (!r.ortschaft && r.lat != null) nebenbei(ortschaftNachtragen(body.ziel, id, r.lat, r.lng));
  return json({ ok: true, platz: r.platz, platz_typ: r.platz_typ, ortschaft: r.ortschaft });
}

async function kommentareFuerFahrer(url: URL) {
  const [geraet] = await sql`
    select id, (now() at time zone zeitzone)::date::text as heute from privat.tour_geraete where sende_token = ${url.searchParams.get("id")}`;
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);
  const seit = Math.max(0, Math.floor(Number(url.searchParams.get("kommentare_seit")) || 0));
  const rows = await sql`
    select k.id, k.erstellt_am, k.tag::text as tag, k.name, k.text, k.foto_id, k.vom_fahrer, k.art, k.lat, k.lng, k.ortschaft, k.platz, k.platz_typ, f.aufgenommen_am as foto_t
    from privat.tour_kommentare k
    left join privat.tour_fotos f on f.id = k.foto_id
    where k.geraet_id = ${geraet.id} and k.tag >= ${geraet.heute}::date - 1 and k.id > ${seit}
    order by k.id
    limit 500`;
  const kommentare = rows.map(kommentarJson);
  return json({ kommentare_cursor: kommentare.length ? kommentare[kommentare.length - 1].id : seit, kommentare });
}

const EMOJIS = ["❤️", "🔥", "😂", "👍", "😮"];

async function reaktionUmschalten(req: Request, url: URL) {
  const g = await geraetFuerAnsicht(url.searchParams.get("ansicht"));
  if (!g) return json({ fehler: "Link ungültig" }, 403);
  let body: any;
  try { body = await req.json(); } catch { return json({ fehler: "ungültige Daten" }, 400); }
  const typ = body?.ziel_typ, id = Math.floor(Number(body?.ziel_id)) || 0, emoji = body?.emoji;
  const wer = String(body?.wer ?? "");
  if (!["foto", "kommentar"].includes(typ) || !EMOJIS.includes(emoji) || !/^[A-Za-z0-9_-]{8,64}$/.test(wer)) {
    return json({ fehler: "ungültige Reaktion" }, 400);
  }
  const [ziel] = typ === "foto"
    ? await sql`select id from privat.tour_fotos where id = ${id} and geraet_id = ${g.id}`
    : await sql`select id from privat.tour_kommentare where id = ${id} and geraet_id = ${g.id}`;
  if (!ziel) return json({ fehler: "nicht gefunden" }, 404);

  const [{ anzahl }] = await sql`
    select count(*)::int as anzahl from privat.tour_reaktionen
    where geraet_id = ${g.id} and erstellt_am > now() - interval '1 minute'`;
  if (anzahl >= 120) return json({ fehler: "Zu viele Reaktionen, bitte kurz warten" }, 429);

  const geloescht = await sql`
    delete from privat.tour_reaktionen
    where geraet_id = ${g.id} and ziel_typ = ${typ} and ziel_id = ${id} and emoji = ${emoji} and wer = ${wer}
    returning id`;
  if (!geloescht.length) {
    await sql`
      insert into privat.tour_reaktionen (geraet_id, ziel_typ, ziel_id, emoji, wer)
      values (${g.id}, ${typ}, ${id}, ${emoji}, ${wer})
      on conflict do nothing`;
  }
  return json({ ok: true, aktiv: !geloescht.length });
}

const MAX_GPX = 25 * 1024 * 1024;

async function gpxHochladen(req: Request, url: URL) {
  const [geraet] = await sql`
    select id, zeitzone from privat.tour_geraete where sende_token = ${url.searchParams.get("id")}`;
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);

  let text = "", name: string | null = null;
  const typ = req.headers.get("content-type") ?? "";
  if (typ.includes("multipart/form-data")) {
    const form = await req.formData();
    const datei = form.get("datei");
    if (!(datei instanceof File)) return json({ fehler: "Datei fehlt" }, 400);
    if (datei.size > MAX_GPX) return json({ fehler: "Datei zu groß" }, 413);
    text = await datei.text();
    name = datei.name ? datei.name.replace(/\.gpx$/i, "") : null;
  } else {
    text = await req.text();
    if (text.length > MAX_GPX) return json({ fehler: "Datei zu groß" }, 413);
  }
  if (!/<gpx[\s>]/i.test(text)) return json({ fehler: "Das ist keine GPX-Datei" }, 415);

  const alle = gpxLesen(text);
  if (alle.length < 10) return json({ fehler: "Keine Strecke mit Zeitangaben in der Datei gefunden" }, 422);
  tempoSetzen(alle);
  const werte = auswerten(alle);
  const duenn = ausduennen(alle, 3);
  {   // Name der Strecke aus der Datei bevorzugen, sonst Dateiname
    const m = /<trk>[\s\S]*?<name>([^<]{1,200})<\/name>/.exec(text) || /<name>([^<]{1,200})<\/name>/.exec(text);
    if (m) name = m[1].trim();
  }

  // Tag der Reise = Kalendertag des ersten Punkts in der Zeitzone der Reise
  const [{ tag }] = await sql`select ((${werte.start}::timestamptz) at time zone ${geraet.zeitzone})::date::text as tag`;

  const id = await sql.begin(async (tx) => {
    // Eine Datei, die zeitlich mit einem vorhandenen Teil überlappt, ersetzt ihn (z. B. dieselbe Datei nochmal).
    // Andere Teile desselben Tages bleiben und werden kombiniert.
    await tx`
      delete from privat.tour_gpx
      where geraet_id = ${geraet.id} and tag = ${tag}::date and start < ${werte.ende} and ende > ${werte.start}`;
    const [neu] = await tx`
      insert into privat.tour_gpx (geraet_id, tag, name, punkte_original, start, ende, km, fahrzeit_s, max_kmh,
                                   anstieg_m, abstieg_m, hoehe_max, hoehe_max_lat, hoehe_max_lng, linie)
      values (${geraet.id}, ${tag}::date, ${name}, ${alle.length}, ${werte.start}, ${werte.ende}, ${werte.km}, ${werte.fahrzeit_s},
              ${werte.max_kmh}, ${werte.anstieg_m}, ${werte.abstieg_m}, ${werte.hoehe_max}, ${werte.hoehe_max_lat},
              ${werte.hoehe_max_lng}, ${sql.json(miniLinie(duenn))})
      returning id`;
    const zeilen = duenn.map((q, i) => ({
      gpx_id: neu.id, nr: i, t: new Date(q.t), lat: q.lat, lng: q.lng, hoehe: q.hoehe, kmh: q.kmh,
    }));
    for (let i = 0; i < zeilen.length; i += 2000) {
      await tx`insert into privat.tour_gpx_punkte ${tx(zeilen.slice(i, i + 2000), "gpx_id", "nr", "t", "lat", "lng", "hoehe", "kmh")}`;
    }
    return Number(neu.id);
  });

  return json({
    ok: true, id, tag, name, punkte_original: alle.length, punkte_gespeichert: duenn.length,
    km: werte.km, fahrzeit_s: werte.fahrzeit_s, max_kmh: werte.max_kmh, anstieg_m: werte.anstieg_m,
    hoehe_max: werte.hoehe_max, start: werte.start, ende: werte.ende,
  });
}

async function gpxListe(url: URL) {
  const [geraet] = await sql`select id from privat.tour_geraete where sende_token = ${url.searchParams.get("id")}`;
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);
  const teile = await sql`
    select id, tag::text as tag, name, km, fahrzeit_s, anstieg_m, punkte_original, start, ende, hochgeladen_am
    from privat.tour_gpx where geraet_id = ${geraet.id} order by tag desc, start`;
  return json({ teile: teile.map((x) => ({ ...x, id: Number(x.id) })) });
}

async function gpxEntfernen(req: Request, url: URL) {
  const [geraet] = await sql`select id from privat.tour_geraete where sende_token = ${url.searchParams.get("id")}`;
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);
  let body: any;
  try { body = await req.json(); } catch { return json({ fehler: "ungültige Daten" }, 400); }
  const id = Math.floor(Number(body?.id)) || 0;
  // Nur die GPX-Strecke wird entfernt (ihre Punkte per Fremdschlüssel mit). Die Live-Punkte bleiben unberührt.
  const weg = await sql`delete from privat.tour_gpx where id = ${id} and geraet_id = ${geraet.id} returning id, tag::text as tag`;
  if (!weg.length) return json({ fehler: "nicht gefunden" }, 404);
  return json({ ok: true, id, tag: weg[0].tag });
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

  const zeit = zeitAus(form.get("zeit"), 60);
  const titel = String(form.get("titel") ?? "").trim().slice(0, 300) || null;

  // Ort: GPS-Daten aus dem Foto, sonst der Streckenpunkt, der zeitlich am nächsten an der
  // Aufnahme liegt (max. 15 Min.), sonst der Standort des Handys beim Hochladen, sonst der letzte Punkt.
  let lat: number | null = null, lng: number | null = null, ortQuelle = "keiner";
  const gl = zahl(form.get("gps_lat")), gg = zahl(form.get("gps_lng"));
  const [nah] = koordinate(gl, gg) ? [{ lat: gl, lng: gg }] : await sql`
    select lat, lng from privat.tour_positionen
    where geraet_id = ${geraet.id}
      and aufgenommen_am between ${new Date(zeit.getTime() - 15 * 60000)} and ${new Date(zeit.getTime() + 15 * 60000)}
    order by abs(extract(epoch from (aufgenommen_am - ${zeit}::timestamptz)))
    limit 1`;
  if (nah) { lat = nah.lat; lng = nah.lng; ortQuelle = koordinate(gl, gg) ? "foto" : "strecke"; }
  else {
    const fl = zahl(form.get("lat")), fg = zahl(form.get("lng"));
    if (koordinate(fl, fg)) { lat = fl; lng = fg; ortQuelle = "handy"; }
    else {
      const [letzter] = await sql`
        select lat, lng from privat.tour_positionen where geraet_id = ${geraet.id}
        order by aufgenommen_am desc limit 1`;
      if (letzter) { lat = letzter.lat; lng = letzter.lng; ortQuelle = "letzter"; }
    }
  }

  const [neu] = await sql`
    insert into privat.tour_fotos (geraet_id, aufgenommen_am, lat, lng, titel, bild, vorschau)
    values (${geraet.id}, ${zeit}, ${lat}, ${lng}, ${titel},
            ${new Uint8Array(await bild.arrayBuffer())}, ${new Uint8Array(await vorschau.arrayBuffer())})
    returning id`;
  if (lat != null && lng != null) nebenbei(ortschaftNachtragen("foto", Number(neu.id), lat, lng));
  return json({ ok: true, id: Number(neu.id), lat, lng, ort: ortQuelle, zeit });
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
    if (req.method === "POST" && url.searchParams.has("gpx")) return await gpxHochladen(req, url);
    if (req.method === "POST" && url.searchParams.has("gpx_entfernen")) return await gpxEntfernen(req, url);
    if (req.method === "GET" && url.searchParams.has("gpx_liste") && url.searchParams.has("id")) return await gpxListe(url);
    if (req.method === "GET" && url.searchParams.has("orte") && url.searchParams.has("id")) return await orteLiefern(url);
    if (req.method === "POST" && url.searchParams.has("ort_setzen")) return await ortSetzen(req, url);
    if (req.method === "POST" && url.searchParams.has("kommentar")) return await kommentarSchreiben(req, url);
    if (req.method === "POST" && url.searchParams.has("reaktion")) return await reaktionUmschalten(req, url);
    if (req.method === "GET" && url.searchParams.has("kommentare") && url.searchParams.has("id")) return await kommentareFuerFahrer(url);
    if (req.method === "GET" || req.method === "POST") return await empfangen(req, url);
    return json({ fehler: "Methode nicht erlaubt" }, 405);
  } catch (e) {
    console.error(e);
    return json({ fehler: "Serverfehler" }, 500);
  }
});
