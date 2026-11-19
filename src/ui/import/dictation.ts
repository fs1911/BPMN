/**
 * Dictation into the text field with the browser's speech recognition
 * (Web Speech API: Chrome, Edge, Safari; not Firefox). The recognised text is
 * appended to the field like typed text and can be corrected before
 * generating. Chrome and Edge send the audio to their maker's speech service
 * for recognition; FlowCraft itself never receives audio.
 */

export interface Dictation {
  stop(): void;
}

export interface DictationHandlers {
  /** final text of a spoken passage */
  onText(text: string): void;
  /** what is being recognised right now (not final yet) */
  onInterim(text: string): void;
  onEnd(error?: string): void;
}

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

const ctor = (): (new () => Recognition) | undefined =>
  typeof window === "undefined" ? undefined : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

export const dictationSupported = () => !!ctor();

const ERRORS: Record<string, string> = {
  "not-allowed": "Mikrofon nicht freigegeben – im Browser (Schloss-Symbol in der Adresszeile) das Mikrofon erlauben.",
  "service-not-allowed": "Spracherkennung ist in diesem Browser gesperrt.",
  "audio-capture": "Kein Mikrofon gefunden.",
  network: "Spracherkennung nicht erreichbar (keine Verbindung zum Sprachdienst des Browsers).",
  "language-not-supported": "Deutsch wird von der Spracherkennung dieses Browsers nicht unterstützt.",
};

/** Spoken commands for layout ("neuer Absatz", "neue Zeile") → line breaks. */
export function applyVoiceCommands(text: string): string {
  return text
    .replace(/\s*\bneuer absatz\b\s*/gi, "\n\n")
    .replace(/\s*\bneue zeile\b\s*/gi, "\n")
    .replace(/[ \t]+\n/g, "\n");
}

export function startDictation(h: DictationHandlers): Dictation | undefined {
  const Ctor = ctor();
  if (!Ctor) return undefined;
  const rec = new Ctor();
  const nav = typeof navigator !== "undefined" ? navigator.language : "de-CH";
  rec.lang = /^de\b/i.test(nav) ? nav : "de-CH";
  rec.continuous = true;
  rec.interimResults = true;
  let error: string | undefined;
  let stopped = false;
  rec.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) h.onText(applyVoiceCommands(r[0].transcript.trim()));
      else interim += r[0].transcript;
    }
    h.onInterim(interim.trim());
  };
  rec.onerror = (e: any) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    error = ERRORS[e.error] ?? `Spracherkennung: ${e.error}`;
  };
  // Chrome ends a session after a pause: keep listening until stopped.
  rec.onend = () => {
    if (!stopped && !error) {
      try {
        rec.start();
        return;
      } catch {
        /* fall through */
      }
    }
    h.onInterim("");
    h.onEnd(error);
  };
  rec.start();
  return {
    stop() {
      stopped = true;
      rec.stop();
    },
  };
}

/** Append dictated text to what is in the field: a space or the line break the speaker asked for. */
export function appendDictated(current: string, spoken: string): string {
  if (!spoken) return current;
  if (!current) return spoken.replace(/^\n+/, "");
  if (spoken.startsWith("\n") || current.endsWith("\n")) return current + spoken;
  return `${current} ${spoken}`;
}
