// Generates sample .bpmn files from the engine so they carry real geometry.
// Run with: npx tsx scripts/gen-samples.mjs
import { writeFileSync } from "node:fs";
import { generateFromTextSync } from "../src/core/ai/index.ts";
import { exportBpmn } from "../src/core/xml/index.ts";

const samples = {
  "rechnungsfreigabe": `Wenn eine Rechnung eingeht, erfasst der Sachbearbeiter sie im System.
Der Sachbearbeiter prüft die Rechnung gegen die Bestellung.
Wenn die Unterlagen unvollständig sind, zurück an die Erfassung der Rechnung senden.
Der Abteilungsleiter gibt die Rechnung frei.
Das System plant die Zahlung.
Der Prozess endet, wenn die Zahlung archiviert ist.`,
  "bauantrag": `Der Antragsteller reicht einen Bauantrag über das Portal ein.
Der Sachbearbeiter prüft den Antrag auf Vollständigkeit.
Wenn Angaben fehlen, zurück an den Antragsteller zur Klärung.
Der Prüfer bewertet den Antrag anhand der Vorschriften.
Der Abteilungsleiter gibt die Genehmigung frei.
Das System stellt die Genehmigung aus und der Prozess endet.`,
  "kunden-onboarding": `Eine neue Kundenanfrage geht beim Vertrieb ein.
Der Vertrieb sammelt die Kundenunterlagen.
Die Buchhaltung prüft die Unterlagen für KYC.
Wenn die Prüfung scheitert, zurück an das Sammeln der Unterlagen.
Der Abteilungsleiter gibt das Onboarding frei.
Das System legt das Kundenkonto an und der Prozess endet.`,
};

for (const [name, text] of Object.entries(samples)) {
  const { model } = generateFromTextSync(text);
  writeFileSync(`samples/${name}.bpmn`, exportBpmn(model));
  console.log("wrote samples/" + name + ".bpmn");
}
