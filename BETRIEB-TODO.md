# Offene Punkte für den Betrieb (manuell zu erledigen)

Diese Schritte kann nur der Projektinhaber erledigen – sie brauchen Zugang zu
Netlify bzw. eine Entscheidung.

- [ ] **API-Key hinterlegen:** Netlify → Projekt `flowcraft-bpmn` → *Site
      configuration → Environment variables* → `ANTHROPIC_API_KEY` anlegen,
      danach neu deployen. Ohne Key nutzt die App nur den Offline-Parser.
- [x] **Richtigen Branch deployen:** Produktions-Branch in Netlify auf
      `claude/awesome-meitner-568870` umgestellt (Project configuration →
      Developer settings → Continuous deployment → Branches and deploy
      contexts). Jeder Push auf diesen Branch geht damit sofort live.
- [ ] **Endpunkt schützen:** `/api/generate` hat keine Anmeldung und kein
      Limit – jeder mit der URL verbraucht API-Guthaben. Mindestens den
      Passwortschutz von Netlify einschalten (*Site configuration → Access &
      security*), bevor die URL weitergegeben wird.
- [ ] **Testsammlung liefern:** 10–20 echte Prozessbeschreibungen (anonymisiert)
      als Grundlage, um die KI-Generierung messbar zu verbessern.
