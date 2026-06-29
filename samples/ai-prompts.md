# Beispiel-Prompts für die KI-Modellierung

Fügen Sie einen der folgenden Texte unter **KI-Modellierung → Prozess
beschreiben** ein und klicken Sie auf **BPMN-Entwurf generieren**. Die Beispiele
nutzen Rollen, Systeme, Entscheidungen, Freigaben, Prüfungen, Ausnahmen und
Nachbearbeitungsschleifen. (Englische Beschreibungen werden ebenfalls erkannt.)

## 1. Rechnungsfreigabe (Fließtext + Nachbearbeitungsschleife)
```
Wenn eine Rechnung eingeht, erfasst der Sachbearbeiter sie im System.
Der Sachbearbeiter prüft die Rechnung gegen die Bestellung.
Wenn die Unterlagen unvollständig sind, zurück an die Erfassung der Rechnung senden.
Der Abteilungsleiter gibt die Rechnung frei.
Das System plant die Zahlung.
Der Prozess endet, wenn die Zahlung archiviert ist.
```

## 2. Bauantrag (Klärungsschleife + Compliance-Prüfung)
```
Der Antragsteller reicht einen Bauantrag über das Portal ein.
Der Sachbearbeiter prüft den Antrag auf Vollständigkeit.
Wenn Angaben fehlen, zurück an den Antragsteller zur Klärung.
Der Prüfer bewertet den Antrag anhand der Vorschriften.
Der Abteilungsleiter gibt die Genehmigung frei.
Das System stellt die Genehmigung aus und der Prozess endet.
```

## 3. Rollen-Präfix / SOP-Stil
```
Vertrieb: Kundenauftrag entgegennehmen.
Lager: Verfügbarkeit prüfen.
Lager: Wenn der Bestand fehlt, zurück an die Auftragsannahme.
Finanzen: Kundenbonität prüfen.
Abteilungsleiter: Versand freigeben.
System: Versandetikett erzeugen.
```

## 4. Besprechungsnotizen / Umgangssprache
```
Also im Grunde nimmt der Sachbearbeiter das Ticket auf und triagiert es dann.
Wenn es dringend ist, eskalieren wir an den Bereitschaftstechniker, sonst geht
es in die normale Warteschlange. Der Techniker löst es und wir schließen das Ticket.
```

# Beispiel-Folgeanweisungen

In **Per Anweisung aktualisieren** eingeben (oder die Schnellbefehl-Chips nutzen):

- `Eine Freigabe durch den Abteilungsleiter vor dem Versand hinzufügen`
- `Nachbearbeitungsschleife für unvollständige Dokumente erstellen`
- `Ausnahmepfad hinzufügen, wenn die Genehmigung fehlt`
- `Einkauf und Bauleitung in separate Bahnen aufteilen`
- `Triage durch ein XOR-Gateway ersetzen`
- `Qualitätsprüfung vor den Versand verschieben`
- `Prüfschritt in „Bestellung validieren“ umbenennen`
- `Serviceaufgabe zum Benachrichtigen des Kunden vor dem Abschluss hinzufügen`
