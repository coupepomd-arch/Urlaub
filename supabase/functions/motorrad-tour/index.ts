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

  const rows = await sql`
    select id, aufgenommen_am, lat, lng, geschwindigkeit_kmh, richtung, hoehe_m, genauigkeit_m, akku_prozent, laedt
    from privat.tour_positionen
    where geraet_id = ${g.id} and aufgenommen_am >= ${von} and aufgenommen_am < ${bis} and id > ${seit}
    order by id
    limit 50000`;

  const fotos = await sql`
    select id, aufgenommen_am, lat, lng, titel
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

  return json({
    name: g.name,
    titel: g.titel,
    reaktionen: reaktionen.map((r) => ({ typ: r.ziel_typ, id: Number(r.ziel_id), emoji: r.emoji, anzahl: r.anzahl, ich: r.ich })),
    datum,
    heute: g.heute,
    kommentare_cursor: kommentare.length ? kommentare[kommentare.length - 1].id : kSeit,
    kommentare,
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

// Reisebuch: eine Zeile pro Tag mit Strecke, Fahrzeit, Höchsttempo, Fotos und Kommentaren
async function tageListe(g: { id: number; zeitzone: string; reise_start: string | null; heute: string; titel: string }) {
  const ab = g.reise_start ?? "1970-01-01";
  const rows = await sql`
    with p as (
      select (aufgenommen_am at time zone ${g.zeitzone})::date as tag, aufgenommen_am, lat, lng, geschwindigkeit_kmh,
             lag(lat) over w as plat, lag(lng) over w as plng, lag(aufgenommen_am) over w as pt
      from privat.tour_positionen
      where geraet_id = ${g.id} and (genauigkeit_m is null or genauigkeit_m <= 60)
        and aufgenommen_am >= (${ab}::date::timestamp at time zone ${g.zeitzone})
      window w as (partition by (aufgenommen_am at time zone ${g.zeitzone})::date order by aufgenommen_am)
    ),
    d as (
      select *, extract(epoch from aufgenommen_am - pt) as dt,
             2 * 6371 * asin(sqrt(power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lng - plng) / 2), 2))) as km
      from p
    ),
    strecke as (
      select tag, min(aufgenommen_am) as start, max(aufgenommen_am) as ende,
        coalesce(sum(km) filter (where km > 0.005 and dt > 0 and km / (dt / 3600) < 300), 0) as km,
        coalesce(sum(dt) filter (where dt > 0 and dt < 180 and km / (dt / 3600) > 4), 0) as fahrzeit_s,
        max(geschwindigkeit_kmh) filter (where geschwindigkeit_kmh < 300) as max_kmh
      from d group by tag
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
    tage as (select tag from strecke union select tag from fotos union select tag from kom)
    select t.tag::text as datum, row_number() over (order by t.tag)::int as nr, s.start, s.ende,
           coalesce(l.punkte, '[]'::json) as linie, tf.id as titelfoto, coalesce(zi.liste, '[]'::json) as zitate,
           round(coalesce(s.km, 0)::numeric, 2)::float8 as km, coalesce(s.fahrzeit_s, 0)::int as fahrzeit_s,
           round(s.max_kmh::numeric)::int as max_kmh,
           coalesce(f.anzahl, 0)::int as fotos, coalesce(f.ids, '{}') as foto_ids, coalesce(k.anzahl, 0)::int as kommentare
    from tage t
    left join strecke s using (tag) left join fotos f using (tag) left join kom k using (tag)
    left join linie l using (tag) left join titelfoto tf using (tag) left join zitate zi using (tag)
    order by t.tag`;
  return json({
    titel: g.titel,
    heute: g.heute,
    reise_start: g.reise_start,
    tage: rows.map((r) => ({ ...r, foto_ids: (r.foto_ids as unknown[]).map(Number), titelfoto: r.titelfoto === null ? null : Number(r.titelfoto) })),
  });
}

async function kommentareLaden(geraetId: number, seit: number, tag: string) {
  const rows = await sql`
    select k.id, k.erstellt_am, k.tag::text as tag, k.name, k.text, k.foto_id, k.vom_fahrer, k.art, k.lat, k.lng, f.aufgenommen_am as foto_t
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
    art: k.art, lat: k.lat, lng: k.lng,
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
  return json({ ok: true, id: Number(neu.id) });
}

async function kommentareFuerFahrer(url: URL) {
  const [geraet] = await sql`
    select id, (now() at time zone zeitzone)::date::text as heute from privat.tour_geraete where sende_token = ${url.searchParams.get("id")}`;
  if (!geraet) return json({ fehler: "unbekanntes Gerät" }, 403);
  const seit = Math.max(0, Math.floor(Number(url.searchParams.get("kommentare_seit")) || 0));
  const rows = await sql`
    select k.id, k.erstellt_am, k.tag::text as tag, k.name, k.text, k.foto_id, k.vom_fahrer, k.art, k.lat, k.lng, f.aufgenommen_am as foto_t
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
