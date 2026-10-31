/*
 * Read a tracklist out of a screenshot, in the browser (Tesseract; free, nothing uploaded to a service).
 * The library and its English data (~a few MB) load the first time it's used.
 */

/** Prepare the picture: greyscale, light text on dark turned into dark on light, small images enlarged. */
async function prepare(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file);
  const scale = bmp.width < 1400 ? 2 : 1;
  const c = document.createElement('canvas'); c.width = bmp.width * scale; c.height = bmp.height * scale;
  const g = c.getContext('2d')!; g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height); const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = y; sum += y; }
  if (sum / (d.length / 4) < 128) for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
  g.putImageData(img, 0, 0);
  return c;
}

export async function readImageText(file: Blob, onProgress?: (p: number) => void): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, { logger: (m: { status: string; progress: number }) => { if (m.status === 'recognizing text') onProgress?.(m.progress); } });
  try {
    const { data } = await worker.recognize(await prepare(file), {}, { blocks: true, text: true });
    type W = { text: string; confidence: number; bbox: { x0: number; x1: number } };
    const lines = (data.blocks ?? []).flatMap((b: { paragraphs: { lines: { words: W[] }[] }[] }) => b.paragraphs.flatMap((p) => p.lines));
    if (!lines.length) return data.text;
    // Words it's unsure of are mostly the album cover and icons, not titles
    const good = lines.map((l: { words: W[] }) => l.words.filter((w) => w.confidence >= 55 && /[\p{L}\p{N}]/u.test(w.text)));
    // The song titles start in one column; anything well left of it is the cover
    const starts = good.filter((ws: W[]) => ws.length >= 3).map((ws: W[]) => ws[0].bbox.x0).sort((a: number, b: number) => a - b);
    const col = starts.length >= 3 ? starts[Math.floor(starts.length * 0.3)] : 0;
    const slack = 40;
    return good.map((ws: W[]) => ws.filter((w) => w.bbox.x1 > col - slack && (w.bbox.x0 >= col - slack || /^\d{1,3}[.)]?$/.test(w.text))).map((w) => w.text).join(' ')).join('\n');
  }
  finally { await worker.terminate(); }
}

/**
 * Tidy what came out of a music-app screenshot into one song per line: drops track numbers, ★/• marks, run times,
 * "•••" menus, lone numbers and the grey line that repeats under every song (the artist or label).
 */
export function cleanOcrTracklist(text: string, drop: string[] = []): string {
  // Misreads like "6.0.0.D. Music" for "G.O.O.D. Music" still count as the same line
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/0/g, 'o').replace(/6/g, 'g').replace(/[1|]/g, 'l').replace(/5/g, 's');
  const raw = text.split(/\r?\n/).map((l) => l.replace(/[★☆✩✭*•·]+/g, ' ').replace(/(?:\s*(?:\.{3}|…)|\s+(?:ooo|eee|o o o))\s*$/i, '').replace(/\s+/g, ' ').trim());
  const counts = new Map<string, number>();
  for (const l of raw) { const k = key(l); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
  const dropKeys = new Set(drop.map(key).filter(Boolean));
  const out: string[] = [];
  for (let l of raw) {
    const k = key(l);
    if (!k || !/[a-z]/i.test(l)) continue; // blank, a lone number, a run time
    if (dropKeys.has(k) || ((counts.get(k) ?? 0) >= 3 && l.length < 40)) continue; // the repeated artist/label line
    l = l.replace(/^[a-z]\s+(?=[A-Z0-9])/, '') // a stray mark read as a letter: "a The Joy"
      .replace(/^\d{1,3}\s*[.)]?\s+(?=\S)/, '') // track number
      .replace(/\s+\d{1,2}[:.]\d{2}\s*$/, '') // run time
      .replace(/^[^\p{L}\p{N}("'“‘]+/u, '').replace(/[^\p{L}\p{N})"'”’!?.]+$/u, '').trim();
    if (l.length > 1) out.push(l);
  }
  return out.join('\n');
}
