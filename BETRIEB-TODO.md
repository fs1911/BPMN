# Offene Punkte für den Betrieb (manuell zu erledigen)

Diese Schritte kann nur der Projektinhaber erledigen – sie brauchen Zugang zu
Netlify bzw. eine Entscheidung.

- [x] **API-Key hinterlegen:** Netlify → Projekt `flowcraft-bpmn` → *Project
      configuration → Environment variables* → `ANTHROPIC_API_KEY` anlegen
      (als Secret), danach neu deployen. Vorher in der Anthropic-Konsole ein
      Ausgabenlimit setzen. Ohne Key nutzt die App nur den Offline-Parser.
- [x] **Richtigen Branch deployen:** Produktions-Branch in Netlify auf
      `claude/awesome-meitner-568870` umgestellt (Project configuration →
      Developer settings → Continuous deployment → Branches and deploy
      contexts). Jeder Push auf diesen Branch geht damit sofort live.
- [x] **Zugang schützen:** Persönliche Zugangscodes (Edge-Function
      `netlify/edge-functions/access.ts`) vor Seite und `/api/generate`.
      Codes stehen in Netlify unter *Project configuration → Environment
      variables* in `ACCESS_CODES` als `name:code, name:code`.
      - Kollege hinzufügen: `, anna:<langer Zufallscode>` anhängen, speichern,
        dann *Deploys → Trigger deploy* (Env-Änderungen wirken erst nach
        einem Deploy). Andere bleiben angemeldet.
      - Kollege sperren: seinen Eintrag löschen + neu deployen.
      - Alle abmelden: `ACCESS_SECRET` ändern + neu deployen.
      - Abmelden im Browser: `/__access/logout`.
      Ohne `ACCESS_CODES` liefert die Seite nichts aus (503).
- [ ] **Testsammlung liefern:** 10–20 echte Prozessbeschreibungen (anonymisiert)
      als Grundlage, um die KI-Generierung messbar zu verbessern.
