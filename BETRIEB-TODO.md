# Offene Punkte für den Betrieb (manuell zu erledigen)

Diese Schritte kann nur der Projektinhaber erledigen – sie brauchen Zugang zu
Netlify bzw. eine Entscheidung.

- [ ] **API-Key hinterlegen:** Netlify → Projekt `flowcraft-bpmn` → *Project
      configuration → Environment variables* → `ANTHROPIC_API_KEY` anlegen
      (als Secret), danach neu deployen. Vorher in der Anthropic-Konsole ein
      Ausgabenlimit setzen. Ohne Key nutzt die App nur den Offline-Parser.
- [x] **Richtigen Branch deployen:** Produktions-Branch in Netlify auf
      `claude/awesome-meitner-568870` umgestellt (Project configuration →
      Developer settings → Continuous deployment → Branches and deploy
      contexts). Jeder Push auf diesen Branch geht damit sofort live.
- [x] **Endpunkt schützen:** Netlify-Team-Anmeldung für alle Deploys aktiv
      (Passwortschutz ist im aktuellen Tarif nicht verfügbar). Seite und
      `/api/generate` sind nur mit Anmeldung am Netlify-Konto erreichbar.
      Einschränkung: im Free-Tarif sieht nur der Team-Inhaber die Seite; für
      Kollegen Upgrade auf Pro oder einen eigenen Zugangscode einbauen.
- [ ] **Testsammlung liefern:** 10–20 echte Prozessbeschreibungen (anonymisiert)
      als Grundlage, um die KI-Generierung messbar zu verbessern.
