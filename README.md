# Urlaub – Motorrad Live-Tracking

Eine kleine Live-Seite, auf der man während einer Motorradtour Position, gefahrene Strecke,
Tempo, Kilometer, Fahrzeit, Höhe und Handy-Akku sehen kann.

```
Handy (Traccar Client)  ──►  Supabase Edge Function "motorrad-tour"  ──►  Tabelle privat.tour_positionen
                                         ▲
Live-Seite (index.html)  ────────────────┘  fragt alle 10 Sekunden neue Punkte ab
```

## Bestandteile

| Datei | Zweck |
|---|---|
| `index.html` | Live-Seite (Karte + Werte). Der Zugang steht als geheimer Schlüssel hinter dem `#` im Link. |
| `foto.html` | Upload-Seite für Fotos unterwegs. Der Sendeschlüssel steht hinter dem `#` im Link. |
| `supabase/functions/motorrad-tour/index.ts` | Nimmt Positionen und Fotos vom Handy an und liefert sie an die Seite. |

Die Daten liegen im Supabase-Projekt im eigenen Schema `privat`, getrennt von allen anderen Tabellen.
Das Schema ist nicht über die öffentliche API erreichbar; nur die Edge Function liest und schreibt.
Es wird nichts gelöscht: Die Seite gliedert alles nach Kalendertagen (Zeitzone `tour_geraete.zeitzone`).
Heute läuft live, frühere Tage lassen sich mit ‹ › oder über das **📖 Reisebuch** (Übersicht aller Tage
mit Kilometern, Fahrzeit, Fotos und Kommentaren) ansehen. Das Reisebuch beginnt bei `tour_geraete.reise_start`.

**Keine Schlüssel in dieses Repo schreiben.** Sende- und Ansichtsschlüssel stehen nur in der Datenbank
(`privat.tour_geraete`).

## Handy einrichten (Android, Traccar Client)

1. „Traccar Client“ aus dem Play Store installieren.
2. Einstellungen:
   - **Gerätekennung / Device identifier:** der Sendeschlüssel
   - **Server-URL:** `https://qdqtvaoqhhecoeqvxsqq.supabase.co/functions/v1/motorrad-tour`
   - **Genauigkeit:** Hoch
   - **Intervall / Frequency:** 10 Sekunden
   - **Distanz:** 0, **Offline-Pufferung:** an
3. Android-Akkuoptimierung für Traccar Client ausschalten, sonst stoppt Android die App im Hintergrund.
4. Dienst starten. Auf der Live-Seite sollte nach wenigen Sekunden der erste Punkt erscheinen.

## Live-Seite ansehen

`https://<github-pages-adresse>/#<ansichtsschlüssel>`

## Fotos unterwegs

`https://<github-pages-adresse>/foto.html#<sendeschlüssel>` auf dem Handy öffnen (am besten zum
Startbildschirm hinzufügen). Fotos werden vor dem Hochladen verkleinert (max. 1600 px) und in
`privat.tour_fotos` gespeichert. Der Ort wird über die Aufnahmezeit dem nächsten Streckenpunkt
(± 15 Min.) zugeordnet, sonst dem Standort des Handys beim Hochladen.

## Kommentare

Jeder mit dem Live-Link kann unter Angabe eines Namens kommentieren, auch direkt zu einem Foto.
Der Fahrer liest und antwortet auf der Foto-Seite; seine Antworten sind mit 🏍️ markiert.
Gespeichert in `privat.tour_kommentare`, höchstens 20 Kommentare pro Minute.

Kommentare gehören zu dem Tag, der beim Schreiben angezeigt wurde (`tag`).
Kommentar ausblenden: `update privat.tour_kommentare set tag = date '2000-01-01' where id = …;`

## Neue Schlüssel erzeugen (falls ein Link weitergegeben wurde)

```sql
update privat.tour_geraete
set sende_token   = encode(extensions.gen_random_bytes(12), 'hex'),
    ansicht_token = encode(extensions.gen_random_bytes(12), 'hex')
where id = 1
returning sende_token, ansicht_token;
```

## Alte Touren löschen

```sql
delete from privat.tour_positionen where aufgenommen_am < now() - interval '1 day';
```
