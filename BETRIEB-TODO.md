# Offene Punkte für den Betrieb (manuell zu erledigen)

Diese Schritte kann nur der Projektinhaber erledigen – sie brauchen Zugang zu
Netlify bzw. eine Entscheidung.

- [ ] **API-Key hinterlegen:** Netlify → Projekt `flowcraft-bpmn` → *Site
      configuration → Environment variables* → `ANTHROPIC_API_KEY` anlegen,
      danach neu deployen. Ohne Key nutzt die App nur den Offline-Parser.
- [ ] **Richtigen Branch deployen:** Die Live-Seite baut aus
      `claude/bpmn-modeling-tool-s137br`. Die neuen Funktionen liegen auf
      `claude/awesome-meitner-568870` → per Pull Request zusammenführen oder den
      Produktions-Branch in Netlify umstellen.
- [ ] **Endpunkt schützen:** `/api/generate` hat keine Anmeldung und kein
      Limit – jeder mit der URL verbraucht API-Guthaben. Mindestens den
      Passwortschutz von Netlify einschalten (*Site configuration → Access &
      security*), bevor die URL weitergegeben wird.
- [ ] **Testsammlung liefern:** 10–20 echte Prozessbeschreibungen (anonymisiert)
      als Grundlage, um die KI-Generierung messbar zu verbessern.
