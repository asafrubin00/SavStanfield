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
    type W = { text: string; confidence: number; bbox: { x0: number; x1: number; y0: number; y1: number } };
    const lines = (data.blocks ?? []).flatMap((b: { paragraphs: { lines: { words: W[] }[] }[] }) => b.paragraphs.flatMap((p) => p.lines));
    if (!lines.length) return data.text;
    // Words it's unsure of are mostly the album cover and icons, not titles
    const strong = (w: W) => (w.confidence >= 55 && /[\p{L}\p{N}@]/u.test(w.text)) || (w.confidence >= 30 && /^(?:&|\/|\+|-|–|—|\.{3}|…)$/.test(w.text));
    const good = lines.map((l: { words: W[] }) => l.words.filter((w, i, ws) => strong(w)
      // a less certain word in the middle of a title ("Blaine, I Won.") is kept
      || (w.confidence >= 30 && ws.slice(0, i).some(strong) && ws.slice(i + 1).some(strong) && w.bbox.x0 - ws[i - 1].bbox.x1 < (w.bbox.y1 - w.bbox.y0) * 1.6)));
    // The song titles start in one column; anything well left of it is the cover
    const starts = good.filter((ws: W[]) => ws.length >= 3).map((ws: W[]) => ws[0].bbox.x0).sort((a: number, b: number) => a - b);
    const col = starts.length >= 3 ? starts[Math.floor(starts.length * 0.3)] : 0;
    const slack = 40;
    // Columns on one line (song | artist | time) are far apart: keep them apart with a tab so the artist isn't glued onto the title
    return good.map((ws: W[]) => {
      const kept = ws.filter((w) => w.bbox.x1 > col - slack && (w.bbox.x0 >= col - slack || /^\d{1,3}[.)]?$/.test(w.text)));
      const h = Math.max(...kept.map((w) => w.bbox.y1 - w.bbox.y0), 10);
      return kept.map((w, i) => (i && w.bbox.x0 - kept[i - 1].bbox.x1 > h * 1.6 ? '\t' : i ? ' ' : '') + w.text).join('');
    }).join('\n');
  }
  finally { await worker.terminate(); }
}

/**
 * Tidy what came out of a music-app screenshot into one song per line: drops track numbers, ★/• marks, run times,
 * "•••" menus, lone numbers and the grey line that repeats under every song (the artist or label).
 */
export function cleanOcrTracklist(text: string, drop: string[] = []): string {
  /*
   * "Highlander⇥Jay Electronica⇥1:58" → "Highlander"; "Is It Possible…⇥Jay Electronica & DRAM" → "Is It Possible… (feat. DRAM)".
   * The first real column is the song; the album's own artist is dropped; anyone else credited becomes a feature.
   */
  function splitColumns(line: string): string {
    if (!line.includes('\t')) return line;
    const cols = line.split('\t').map((c) => c.trim()).filter((c) => c.replace(/[^\p{L}\p{N}]/gu, '').length > 1 && !/^\d{1,2}[:.]\d{2}$/.test(c));
    if (!cols.length) return '';
    const isNum = /^\d{1,3}[.)]?$/.test(cols[0]);
    const lead = isNum ? `${cols[0]} ` : ''; const rest = isNum ? cols.slice(1) : cols;
    const [title, ...others] = rest;
    if (!title) return '';
    const extra: string[] = [];
    for (const o of others) for (const n of o.split(/\s*(?:,|&|\bx\b)\s*/i)) {
      const name = n.trim();
      if (!name || /(?:\.{2,}|…)$/.test(name)) continue; // cut off on screen ("Hit…")
      if (dropKeysEarly.has(name.toLowerCase().replace(/[^a-z0-9]+/g, ''))) continue;
      if (!/[a-z]/i.test(name)) continue;
      extra.push(name);
    }
    if (!extra.length) return `${lead}${title}`;
    const names = extra.join(', ').replace(/, ([^,]*)$/, ' & $1');
    // Already has "(feat. X)": add the others into it
    if (/[([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/i.test(title)) return `${lead}${title.replace(/([([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*?)\s*([)\]])/i, `$1, ${names}$2`)}`;
    if (/\s(?:feat\.?|ft\.?|featuring)\s/i.test(title)) return `${lead}${title}, ${names}`;
    return `${lead}${title} (feat. ${names})`;
  }
  // Misreads like "6.0.0.D. Music" for "G.O.O.D. Music" still count as the same line
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/0/g, 'o').replace(/6/g, 'g').replace(/[1|]/g, 'l').replace(/5/g, 's');
  const k0 = (d: string) => d.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const dropKeysEarly = new Set(drop.map(k0).filter(Boolean));
  // A name in the artist column on most lines is the album's own artist, even if we weren't told it
  const tabLines = text.split(/\r?\n/).filter((l) => l.includes('\t'));
  const seen = new Map<string, number>();
  for (const l of tabLines) for (const n of new Set(l.split('\t').slice(1).flatMap((c) => c.split(/\s*(?:,|&|\bx\b)\s*/i)).map(k0).filter(Boolean))) seen.set(n, (seen.get(n) ?? 0) + 1);
  for (const [n, c] of seen) if (c >= Math.max(3, tabLines.length * 0.5)) dropKeysEarly.add(n);
  const raw = text.split(/\r?\n/).map(splitColumns).map((l) => l.replace(/[★☆✩✭*•·]+/g, ' ').replace(/(?:\s*(?:\.{3}|…)|\s+(?:ooo|eee|o o o))\s*$/i, '').replace(/\s+/g, ' ').trim());
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
      .replace(/\s\|\s/g, ' I ') // "|" is nearly always a misread capital I
      .replace(/^(?!\.{3}|…|@)[^\p{L}\p{N}("'“‘]+/u, '').replace(/[^\p{L}\p{N})"'”’!?.]+$/u, '').trim();
    if (l.length > 1) out.push(l);
  }
  return out.join('\n');
}
