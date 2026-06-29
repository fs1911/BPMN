/**
 * Minimal German translation module for bpmn-js (palette, context pad, tooltips).
 * bpmn-js looks up English template strings; we map the common ones to German.
 */
const DE: Record<string, string> = {
  "Activate the create/remove space tool": "Platz-Werkzeug aktivieren",
  "Activate the hand tool": "Hand-Werkzeug aktivieren",
  "Activate the lasso tool": "Lasso-Werkzeug aktivieren",
  "Activate the global connect tool": "Globales Verbinden-Werkzeug aktivieren",
  "Append {type}": "{type} anhängen",
  "Append EndEvent": "Endereignis anhängen",
  "Append Gateway": "Gateway anhängen",
  "Append Task": "Aufgabe anhängen",
  "Append Intermediate/Boundary Event": "Zwischen-/Randereignis anhängen",
  "Add Lane above": "Bahn oberhalb hinzufügen",
  "Divide into two Lanes": "In zwei Bahnen teilen",
  "Divide into three Lanes": "In drei Bahnen teilen",
  "Add Lane below": "Bahn unterhalb hinzufügen",
  "Append compensation activity": "Kompensationsaktivität anhängen",
  "Change type": "Typ ändern",
  "Connect using Association": "Mit Assoziation verbinden",
  "Connect using Sequence/MessageFlow or Association": "Mit Sequenz-/Nachrichtenfluss oder Assoziation verbinden",
  "Connect using DataInputAssociation": "Mit Dateneingabe-Assoziation verbinden",
  "Remove": "Entfernen",
  "Activate the create/remove space tool ": "Platz-Werkzeug aktivieren",
  "Create expanded SubProcess": "Erweiterten Teilprozess erstellen",
  "Create IntermediateThrowEvent/BoundaryEvent": "Zwischen-/Randereignis erstellen",
  "Create pool/participant": "Pool/Teilnehmer erstellen",
  "Parallel Multi Instance": "Parallele Mehrfachinstanz",
  "Sequential Multi Instance": "Sequenzielle Mehrfachinstanz",
  "Loop": "Schleife",
  "Ad-hoc": "Ad-hoc",
  "Create {type}": "{type} erstellen",
  "Task": "Aufgabe",
  "User Task": "Benutzeraufgabe",
  "Service Task": "Serviceaufgabe",
  "Send Task": "Sendeaufgabe",
  "Receive Task": "Empfangsaufgabe",
  "Manual Task": "Manuelle Aufgabe",
  "Business Rule Task": "Geschäftsregel-Aufgabe",
  "Script Task": "Skriptaufgabe",
  "Call Activity": "Aufruf-Aktivität",
  "Sub Process (collapsed)": "Teilprozess (eingeklappt)",
  "Sub Process (expanded)": "Teilprozess (erweitert)",
  "Start Event": "Startereignis",
  "End Event": "Endereignis",
  "Intermediate Throw Event": "Zwischenereignis (werfend)",
  "Intermediate Catch Event": "Zwischenereignis (fangend)",
  "Exclusive Gateway": "Exklusives Gateway",
  "Parallel Gateway": "Paralleles Gateway",
  "Inclusive Gateway": "Inklusives Gateway",
  "Event based Gateway": "Ereignisbasiertes Gateway",
  "Complex Gateway": "Komplexes Gateway",
  "Data Store Reference": "Datenspeicher",
  "Data Object Reference": "Datenobjekt",
  "Create StartEvent": "Startereignis erstellen",
  "Create EndEvent": "Endereignis erstellen",
  "Create Task": "Aufgabe erstellen",
  "Create Gateway": "Gateway erstellen",
  "Create DataObjectReference": "Datenobjekt erstellen",
  "Create DataStoreReference": "Datenspeicher erstellen",
  "Create Group": "Gruppe erstellen",
  "Create Pool/Participant": "Pool/Teilnehmer erstellen",
  "Empty Pool": "Leerer Pool",
  "Pool": "Pool",
  "Lane": "Bahn",
};

export function translateModule() {
  return {
    translate: [
      "value",
      function (template: string, replacements?: Record<string, string>) {
        replacements = replacements || {};
        const translated = DE[template] || template;
        return translated.replace(/{([^}]+)}/g, (_: string, key: string) =>
          replacements![key] || "{" + key + "}",
        );
      },
    ],
  };
}
