import type { ProcessImage } from "@core/ai";
import { MAX_IMAGES, MAX_IMAGE_CHARS } from "@core/ai";

/**
 * Photos and page images for the AI: decoded and shrunk in the browser so a
 * request stays small. Claude reads at most about 1568 px on the long side
 * (larger images are scaled down on its side anyway), and the whole request
 * must stay light enough for the server's CPU budget — so every image is
 * re-encoded as JPEG until it fits MAX_IMAGE_CHARS.
 */

export interface ImageAttachment extends ProcessImage {
  /** file name or "Seite 3 von plan.pdf" */
  name: string;
  /** small preview (data URL) for the list */
  thumb: string;
  width: number;
  height: number;
}

const LONG_EDGE = 1568;

/** Image file (JPEG, PNG, WebP, GIF, …) → attachment. */
export async function imageFileToAttachment(file: File): Promise<ImageAttachment> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (/\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type)) {
      throw new Error(`„${file.name}“: HEIC-Fotos kann der Browser nicht lesen – auf dem iPhone unter Einstellungen › Kamera › Formate „Maximale Kompatibilität“ wählen oder das Foto als JPG teilen.`);
    }
    throw new Error(`„${file.name}“ ist kein lesbares Bild.`);
  }
  try {
    return encode(bitmap, bitmap.width, bitmap.height, file.name);
  } finally {
    bitmap.close();
  }
}

/** A drawn canvas (e.g. a rendered PDF page) → attachment. */
export function canvasToAttachment(canvas: HTMLCanvasElement, name: string): ImageAttachment {
  return encode(canvas, canvas.width, canvas.height, name);
}

/** base64 image data (e.g. embedded in a Word file) → attachment; undefined if unreadable or tiny. */
export async function base64ToAttachment(data: string, mediaType: string, name: string, minSide = 160): Promise<ImageAttachment | undefined> {
  try {
    const blob = await (await fetch(`data:${mediaType};base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      if (Math.min(bitmap.width, bitmap.height) < minSide) return undefined; // icons, logos
      return encode(bitmap, bitmap.width, bitmap.height, name);
    } finally {
      bitmap.close();
    }
  } catch {
    return undefined; // EMF/WMF and other formats the browser cannot draw
  }
}

function encode(source: CanvasImageSource, w: number, h: number, name: string): ImageAttachment {
  let scale = Math.min(1, LONG_EDGE / Math.max(w, h));
  for (let attempt = 0; attempt < 8; attempt++) {
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // transparent PNGs: white paper, not black
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(source, 0, 0, cw, ch);
    for (const quality of [0.82, 0.7, 0.6]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      const data = url.slice(url.indexOf(",") + 1);
      if (data.length <= MAX_IMAGE_CHARS) {
        return { name, mediaType: "image/jpeg", data, thumb: thumbnail(canvas), width: cw, height: ch };
      }
    }
    scale *= 0.8;
  }
  throw new Error(`„${name}“ lässt sich nicht klein genug speichern.`);
}

function thumbnail(canvas: HTMLCanvasElement): string {
  const s = Math.min(1, 96 / Math.max(canvas.width, canvas.height));
  const t = document.createElement("canvas");
  t.width = Math.max(1, Math.round(canvas.width * s));
  t.height = Math.max(1, Math.round(canvas.height * s));
  t.getContext("2d")!.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.7);
}

export const imagesLeft = (current: number) => Math.max(0, MAX_IMAGES - current);
