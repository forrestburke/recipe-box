// Turn a URL, image, PDF or pasted text into a draft recipe. No AI services:
// OCR runs in the browser with Tesseract.js, PDFs are read with pdf.js.
import { config } from './config.js';
import { extractRecipeFromHtml, parseRecipeText, cleanOcrText } from './parser.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/';
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';

let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ??= import(PDFJS + 'pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    return m;
  });
  return pdfjsPromise;
}

let tesseractPromise = null;
function loadTesseract() {
  tesseractPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error('Could not load the OCR engine (check your internet connection).'));
    document.head.appendChild(s);
  });
  return tesseractPromise;
}

let worker = null;
async function ocr(image, onProgress) {
  const Tesseract = await loadTesseract();
  if (!worker) {
    onProgress?.('Loading OCR engine (first time only)…');
    worker = await Tesseract.createWorker('eng', 1, {
      logger: m => { if (m.status === 'recognizing text') onProgress?.(`Reading text… ${Math.round(m.progress * 100)}%`); },
    });
  }
  const { data } = await worker.recognize(image);
  return cleanOcrText(data.text);
}

export async function importFromUrl(url) {
  let res;
  try {
    res = await fetch(`${config.fetchProxy}?url=${encodeURIComponent(url)}`);
  } catch {
    throw new Error('Could not reach the page-fetch service. If this is hosted without the Cloud Function, paste the recipe text instead.');
  }
  const body = await res.json().catch(() => null);
  if (!body) throw new Error('Link import isn\'t switched on for this site. Use the 📌 "Save to Recipe Box" bookmark button below (it works on any recipe page), or paste the recipe text.');
  if (!res.ok) throw new Error(body.error || `Fetch failed (${res.status})`);
  const draft = extractRecipeFromHtml(body.html, body.finalUrl || url);
  draft.source = { type: 'url', url: body.finalUrl || url };
  return draft;
}

async function pdfToText(file, onProgress) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    onProgress?.(`Reading PDF page ${p} of ${pdf.numPages}…`);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
      text += item.str;
      if (item.hasEOL) text += '\n';
      lastY = y;
    }
    text += '\n';
  }
  // Scanned PDFs have no text layer: render each page and OCR it
  if (text.replace(/\s/g, '').length < 40) {
    text = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      onProgress?.(`Scanned PDF — OCR page ${p} of ${pdf.numPages}…`);
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
      text += (await ocr(canvas, onProgress)) + '\n';
    }
  }
  return text;
}

// Downscale huge phone photos and boost contrast a little; helps OCR speed and accuracy
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const max = 2400;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.3)';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function importFromFile(file, onProgress) {
  let text;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) text = await pdfToText(file, onProgress);
  else if (file.type.startsWith('image/')) {
    onProgress?.('Preparing image…');
    text = await ocr(await prepareImage(file), onProgress);
  } else if (file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)) text = await file.text();
  else if (/\.html?$/i.test(file.name)) {
    const draft = extractRecipeFromHtml(await file.text(), '');
    draft.source = { type: 'file', name: file.name };
    return draft;
  } else throw new Error(`Unsupported file type: ${file.name}`);

  const draft = parseRecipeText(text);
  draft.rawText = text;
  draft.source = { type: 'file', name: file.name };
  if (draft.title === 'Untitled recipe') draft.title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  return draft;
}

export function importFromText(text) {
  const draft = parseRecipeText(text);
  draft.rawText = text;
  draft.source = { type: 'text' };
  return draft;
}
