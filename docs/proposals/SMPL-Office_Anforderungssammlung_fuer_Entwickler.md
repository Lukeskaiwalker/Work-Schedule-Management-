# SMPL-office: Anforderungssammlung fuer den technischen Leiter

## Ziel
Die Anwendung soll den operativen Ablauf so unterstuetzen, dass Verwaltung und technische Leitung jederzeit sehen:
- was fuer ein Projekt vereinbart wurde
- welches Material gebraucht wird
- was bestellt ist
- was geliefert wurde
- was im Lager liegt
- was auf welcher Baustelle ist
- was noch fehlt
- welche Bueroaufgaben automatisch folgen muessen

## Bereits vorhandene Grundlage im System
Laut aktuellem Repo-Stand gibt es bereits:
- `Kunden`
- `Projekte`
- `Aufgaben`
- `Kalender/Planung`
- `Werkstatt`
- `Projekt-Bedarfe`
- `Lieferanten`
- `Bestellungen`
- `Lager-/Werkstattstruktur`

Das ist gut, weil nicht neu angefangen werden muss. Es fehlt vor allem die durchgehende Verbindung zwischen `Projektumfang`, `Materialbedarf`, `Bestellung`, `Lieferung`, `Lager`, `Baustelle` und `Bueroaufgaben`.

## Prioritaet 1: Strukturierte Datenerfassung aus der Auftragsbestaetigung
### Ziel
Die Auftragsbestaetigung bleibt als Dokument im Dateiordner. Die darin enthaltenen Positionen sollen aber sauber als Projektdaten im System ankommen.

### Wunsch
- Keine eigene Dokumentansicht fuer die Auftragsbestaetigung bauen.
- Die PDF oder Datei bleibt im Projektordner und wird dort wie bisher abgelegt.
- Im System braucht es eine schlanke Moeglichkeit, die relevanten Positionen aus der Auftragsbestaetigung in strukturierte Projektdaten zu uebernehmen.
- Dabei sollen Positionen unterschieden werden koennen in:
  - Leistungen
  - Material
  - sonstige Kosten / Besonderheiten
- Materialpositionen sollen direkt als Grundlage fuer den Materialstatus dienen.
- Es ist egal, ob die Erfassung manuell, halbautomatisch oder per Import passiert. Wichtig ist, dass die Daten danach sauber im Projekt verfuegbar sind.

### Mindestfelder pro Position
- Typ: `Leistung` oder `Material`
- Bezeichnung
- Artikelnummer falls vorhanden
- Menge
- Einheit
- Lieferant falls bekannt
- Notiz
- Status aktiv/inaktiv

### Warum
Aktuell fehlt die strukturierte Uebernahme dessen, was eigentlich zum Auftrag gehoert. Die Auftragsbestaetigung ist die Quelle, aber nicht die Ansicht. Genau aus diesen Daten soll spaeter der Materialbedarf entstehen.

## Prioritaet 2: Echter Materialstatus pro Projekt
### Ziel
Pro Projekt soll sichtbar sein, welches Material offen, bestellt, geliefert, im Lager oder auf der Baustelle ist.

### Wunsch
- Neuer Projektbereich: `Materialstatus`
- Jede Materialposition soll einen Status haben:
  - `offen`
  - `teilbestellt`
  - `bestellt`
  - `teilgeliefert`
  - `vollstaendig im Lager`
  - `teilweise auf Baustelle`
  - `vollstaendig auf Baustelle`
- Sichtbare Mengen:
  - benoetigt
  - bestellt
  - geliefert
  - aus Lager reserviert
  - fehlt noch

### Zusätzliche Felder
- `required_by_date`
- `supplier_id`
- `order_line_id`
- Freitext Notiz
- Quelle der Position:
  - `Auftragsbestaetigung`
  - `manuell`
  - `Baustellenbericht`
  - `Lager`

### Warum
Die Verwaltung muss sehen koennen, ob eine Baustelle wirklich bereit ist. Die technische Leitung braucht eine Uebersicht ueber Fehlteile und Materialluecken.

## Prioritaet 3: Bestellungen mit Projektbezug statt isoliert
### Ziel
Bestellungen sollen nicht nur als Einkauf sichtbar sein, sondern direkt zum Projekt und zum Materialbedarf passen.

### Wunsch
- In `Werkstatt -> Bestellungen` echte Daten statt Mockdaten anzeigen.
- Jede Bestellposition soll optional verknuepft werden koennen mit:
  - `Projekt`
  - `Materialbedarf`
- Beim Wareneingang muss je Position sichtbar sein:
  - bestellt
  - bereits geliefert
  - Restmenge offen
  - Lieferschein-Referenz

### Funktionen
- Bestellung anlegen
- Teil-Lieferung buchen
- Voll-Lieferung buchen
- Lieferschein-Nummer hinterlegen
- erwartetes Lieferdatum pflegen
- Projektfilter auf Bestellungen

### Warum
Bestellungen sind erst dann hilfreich, wenn man sieht, fuer welche Baustelle sie gedacht sind und was davon schon eingetroffen ist.

## Prioritaet 4: Lagerware und Baustellenware sauber trennen
### Ziel
Material aus Lager und bestelltes Material sollen zusammen gedacht, aber sauber unterschieden werden.

### Wunsch
- Material kann `aus Lager reserviert` werden.
- Material kann `auf Baustelle ausgegeben` werden.
- Im Projekt soll sichtbar sein, ob Material:
  - aus Lager kommt
  - bestellt wurde
  - schon auf Baustelle liegt
- `Werkstatt -> Auf Baustelle` braucht Projektfilter und klare Mengenanzeige.

### Warum
Es soll jederzeit klar sein, was im Lager liegt, was reserviert ist und was bereits einer Baustelle zugeordnet wurde.

## Prioritaet 5: Automatische Bueroaufgaben aus Projektstatus
### Ziel
Wiederkehrende Verwaltungsschritte sollen nicht vergessen werden.

### Wunsch
Bei bestimmten Projektstatus sollen automatisch Aufgaben entstehen:
- Bei `Auftrag bestaetigt`:
  - Vollmachten einholen
  - Netzbetreiber vorbereiten
  - Material pruefen
  - Bestellung anstossen
- Vor geplanter Baustelle:
  - Lieferstatus pruefen
  - Kunde bestaetigen
  - offene Netz-/Buerothemen pruefen
- Nach Montage:
  - Inbetriebnahme nachhalten
  - Restpunkte pruefen
  - Schlussrechnung vorbereiten

### Warum
Viele Dinge werden aktuell im Kopf oder spontan gemacht. Das System soll den naechsten Schritt sichtbar machen.

## Prioritaet 6: Baustellen-Freigabeansicht
### Ziel
Vor der finalen Terminbestaetigung soll es eine einfache Ampelansicht geben.

### Wunsch
Pro Projekt vor Terminfreigabe vier Pflichtpunkte sichtbar:
- `technisch klar`
- `Material disponiert`
- `Lieferstatus geprueft`
- `Kunde bestaetigt`

### Darstellung
- Gruen / Gelb / Rot oder Checkbox-Logik
- Schnell in Projekt und Planung sichtbar

### Warum
Damit nicht mehr erst kurz vor Baustelle auffaellt, dass Informationen oder Material fehlen.

## Prioritaet 7: Checklisten und Vor-Ort-Termin besser abbilden
### Ziel
Weniger Rueckfragen von Baustelle und Technik.

### Wunsch
Checklistenfelder spaeter im System pflegbar oder importierbar:
- Dach
- Kabelweg
- Strings
- Optimierer
- Zaehler-/Schrankthemen
- Kabelkanal
- Besonderheiten
- Kundenwuensche
- Fotos
- Skizze

### Warum
Die wichtigsten Rueckfragen wiederholen sich. Diese Informationen muessen strukturiert und auffindbar sein.

## Prioritaet 8: Projektbezogene Uebersicht fuer Verwaltung
### Ziel
Die Verwaltung braucht eine einfache Projektampel statt nur einzelne Datenpunkte.

### Wunsch
Je Projekt kompakte Uebersicht:
- Angebot offen / raus / angenommen
- Vollmachten offen / erledigt
- Material offen / teilweise / vollstaendig
- Termin geplant / bestaetigt
- Netzthemen offen / erledigt
- Rechnung offen / teilweise / erledigt

### Warum
Damit nicht fuer jede Rueckfrage mehrere Bereiche einzeln geoeffnet werden muessen.

## Technische Empfehlung fuer die Umsetzung
### Sinnvolle Reihenfolge
1. `strukturierte Uebernahme aus der Auftragsbestaetigung`
2. `Materialstatus pro Projekt`
3. `Bestellungen live mit Projektbezug`
4. `Wareneingang / Teil-Lieferung`
5. `Lager/Baustellen-Zuordnung`
6. `Automatische Aufgaben`

### Wichtiger Hinweis
- Kein neues zweites Lagersystem bauen.
- Bestehende `Werkstatt`-Logik weiterverwenden.
- Bestehende `Projekt-Bedarfe` nicht ersetzen, sondern erweitern/verknuepfen.
- Erst `Testinstanz`, dann Live.

## Akzeptanzkriterien aus Verwaltungssicht
- Ich kann die Daten aus der Auftragsbestaetigung sauber im Projekt hinterlegen, ohne eine extra Dokumentansicht zu brauchen.
- Ich kann im Projekt sehen, welches Material noch fehlt.
- Ich kann eine Bestellung eindeutig einem Projekt zuordnen.
- Ich kann Teil-Lieferungen erfassen.
- Ich kann Lagerware einem Projekt zuordnen.
- Ich kann vor Terminbestaetigung sehen, ob das Projekt wirklich bereit ist.
- Ich bekomme automatisch die naechsten Bueroaufgaben angezeigt.

## Offene Inputs aus dem Betrieb
Diese Punkte muessen wir noch nachliefern, damit die Umsetzung sauber wird:
- aktuelle Checklisten
- Liste der wichtigsten Lieferanten
- Beispiele fuer Auftragsbestaetigungen / Angebote
- typische Standard-Projektarten
- typische Folgeaufgaben je Projektart

## Vorschlag fuer die Weitergabe an den Entwickler
Bitte die Umsetzung nicht als grossen Komplettumbau starten, sondern als mehrere kleine Schritte:
- Schritt 1: strukturierte Datenerfassung aus der Auftragsbestaetigung
- Schritt 2: Materialstatus
- Schritt 3: Bestellungen mit Projektbezug
- Schritt 4: Wareneingang und Lieferschein
- Schritt 5: Automatische Aufgaben und Freigabeampel
