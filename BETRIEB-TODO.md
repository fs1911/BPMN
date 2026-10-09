# Offene Punkte für den Betrieb (manuell zu erledigen)

Diese Schritte kann nur der Projektinhaber erledigen – sie brauchen Zugang zu
Cloudflare/Netlify bzw. eine Entscheidung.

## Umzug auf Cloudflare (offen)

Der Code ist vorbereitet (`worker/index.ts`, `wrangler.jsonc`) und lokal in
Cloudflares eigener Laufzeitumgebung getestet. Die Menünamen unten sind nach
bestem Wissen – Cloudflare benennt sie gelegentlich um. Wenn etwas nicht
passt: Screenshot schicken.

1. **Konto:** auf dash.cloudflare.com ein kostenloses Konto anlegen.
2. **Projekt anlegen:** *Workers & Pages* → *Create* → bei „Workers“
   *Import a repository* (bzw. „Connect to Git“) → GitHub verbinden →
   Repository `fs1911/BPMN` wählen.
3. **Einstellungen beim Anlegen:**
   - Project name: `flowcraft`
   - Production branch: `claude/awesome-meitner-568870`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - Root directory: leer lassen (`/`)
4. **Geheime Werte** (*Settings* → *Variables and Secrets* → *Add*, Typ
   **Secret**), jeweils für „Production“:
   - `ANTHROPIC_API_KEY` – der Schlüssel aus der Anthropic-Konsole
     (derselbe wie bei Netlify oder ein neuer)
   - `ACCESS_CODES` – z. B. `filip:<dein Code>, anna:<ihr Code>`
   - `ACCESS_SECRET` – eine lange Zufallszeichenkette (nur einmal festlegen;
     ändern meldet alle ab)
5. **Neu bauen:** *Deployments* → letzten Build *Retry* (bzw. einen neuen
   Push abwarten), damit die Secrets aktiv sind.
6. **Testen:** die Adresse `https://flowcraft.<konto>.workers.dev` öffnen →
   Code-Seite → Code eingeben → einen Prozess generieren.
7. **Netlify abschalten**, sobald Cloudflare läuft: im Netlify-Projekt die
   automatischen Builds stoppen (*Project configuration* → *Build & deploy* →
   *Stop builds*) oder das Projekt löschen – sonst verbraucht jeder Push
   weiter Credits.

Kosten bei Cloudflare (Gratis-Tarif, Stand nach bestem Wissen): Seite und
Funktionen kostenlos bis 100 000 Aufrufe pro Tag; Builds kostenlos mit
Monatskontingent. Die KI-Kosten bei Anthropic bleiben gleich.

**Bibliothek:** sie hängt an der Adresse. Vor dem Umzug in der alten App
*📁 Bibliothek → Bibliothek sichern*, in der neuen *Sicherung laden*.

## Erledigt

- [x] **API-Key hinterlegen** (Netlify, Production).
- [x] **Produktions-Branch** `claude/awesome-meitner-568870`.
- [x] **Zugang schützen:** persönliche Zugangscodes
      (`server/access.ts`) vor Seite und `/api/generate`.
      - Kollege hinzufügen: `, anna:<langer Zufallscode>` an `ACCESS_CODES`
        anhängen, speichern, neu bauen. Andere bleiben angemeldet, wenn
        `ACCESS_SECRET` gesetzt ist.
      - Kollege sperren: Eintrag löschen + neu bauen.
      - Alle abmelden: `ACCESS_SECRET` ändern + neu bauen.
      - Abmelden im Browser: `/__access/logout`.
      Ohne `ACCESS_CODES` liefert die Seite nichts aus (503).

## Weiterhin offen

- [ ] **Ausgabenlimit** in der Anthropic-Konsole setzen (jeder Code-Inhaber
      kann KI-Aufrufe auslösen).
- [ ] **Testsammlung liefern:** 10–20 echte Prozessbeschreibungen
      (anonymisiert) als Grundlage, um die KI-Generierung messbar zu
      verbessern.
