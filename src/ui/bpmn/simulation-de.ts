/**
 * German labels for the bpmn.io token simulation (it ships English texts and
 * no translation hook): texts and tooltips are replaced as they appear.
 */

const TEXT: Record<string, string> = {
  "Token Simulation": "Manuell simulieren",
  "Simulation Log": "Ablaufprotokoll",
  "No Entries": "Noch keine Einträge",
  Finished: "Beendet",
  "Play Simulation": "Simulation läuft",
  "Pause Simulation": "Simulation pausiert",
  "Reset Simulation": "Simulation zurückgesetzt",
  "Found unsupported elements": "Nicht unterstützte Elemente gefunden",
  "Not supported": "Nicht unterstützt",
  Process: "Prozess",
  SubProcess: "Teilprozess",
  Task: "Aufgabe",
  "User Task": "Benutzeraufgabe",
  "Service Task": "Serviceaufgabe",
  "Script Task": "Skriptaufgabe",
  "Send Task": "Sendeaufgabe",
  "Receive Task": "Empfangsaufgabe",
  "Manual Task": "Manuelle Aufgabe",
  "Business Rule Task": "Geschäftsregelaufgabe",
  "Call Activity": "Aufrufaktivität",
  "Exclusive Gateway": "XOR-Gateway",
  "Parallel Gateway": "Paralleles Gateway",
  "Inclusive Gateway": "ODER-Gateway",
  "Start Event": "Start",
  "End Event": "Ende",
  "Intermediate Event": "Zwischenereignis",
  "Boundary Event": "Randereignis",
};

const TITLE: Record<string, string> = {
  "Play/Pause Simulation": "Simulation starten / pausieren",
  "Reset Simulation": "Simulation zurücksetzen",
  "Set Sequence Flow": "Diesen Weg nehmen",
  "Toggle Simulation Log": "Ablaufprotokoll ein/aus",
  "Trigger Event": "Ereignis auslösen",
};

function translateTitle(t: string): string {
  if (TITLE[t]) return TITLE[t];
  const speed = /^Set animation speed = (.*)$/.exec(t);
  if (speed) return `Geschwindigkeit ${speed[1]}`;
  const inst = /^View Process Instance (.*)$/.exec(t);
  if (inst) return `Prozessinstanz ${inst[1]} anzeigen`;
  return t;
}

/** Only the simulation's own UI (classes "bts-…"), never diagram labels. */
const inSimulationUi = (el: Element | null) => !!el?.closest('[class*="bts-"]');

function translate(root: Node): void {
  const texts: Node[] = [];
  if (root.nodeType === Node.TEXT_NODE) texts.push(root);
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
  }
  for (const n of texts) {
    if (!inSimulationUi(n.parentElement)) continue;
    const raw = n.nodeValue ?? "";
    const key = raw.trim();
    if (TEXT[key]) n.nodeValue = raw.replace(key, TEXT[key]);
    else {
      // log lines: "Process started", "SubProcess Foo finished", "… canceled"
      const m = /^(.*?) (started|finished|canceled)$/.exec(key);
      if (m) n.nodeValue = raw.replace(key, `${TEXT[m[1]] ?? m[1]} ${{ started: "gestartet", finished: "beendet", canceled: "abgebrochen" }[m[2]]}`);
    }
  }
  if (root instanceof Element) {
    for (const el of [root, ...root.querySelectorAll("[title]")]) {
      if (!inSimulationUi(el)) continue;
      const t = el.getAttribute("title");
      if (t) {
        const de = translateTitle(t);
        if (de !== t) el.setAttribute("title", de);
      }
    }
  }
}

/** Keep the simulation UI inside `container` German; returns a disposer. */
export function germanizeTokenSimulation(container: HTMLElement): () => void {
  translate(container);
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") translate(r.target);
      for (const n of r.addedNodes) translate(n);
      if (r.type === "attributes" && r.target instanceof Element) translate(r.target);
    }
  });
  obs.observe(container, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title"] });
  return () => obs.disconnect();
}
