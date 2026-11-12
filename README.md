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
| `supabase/functions/motorrad-tour/index.ts` | Nimmt Positionen vom Handy an und liefert sie an die Seite. |

Die Daten liegen im Supabase-Projekt im eigenen Schema `privat`, getrennt von allen anderen Tabellen.
Das Schema ist nicht über die öffentliche API erreichbar; nur die Edge Function liest und schreibt.
Positionen älter als 18 Stunden werden auf der Seite nicht mehr angezeigt.

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
