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

// How many pages to read at once. Phones get fewer (each OCR worker needs memory).
export function ocrWorkerCount() {
  const phone = /iPhone|iPad|Android/i.test(navigator.userAgent);
  return phone ? 2 : Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
}

// A pool of OCR workers shared by single and bulk imports
let schedulerPromise = null;
function getScheduler(onProgress) {
  schedulerPromise ??= (async () => {
    const Tesseract = await loadTesseract();
    onProgress?.('Loading the text reader (first time only)…');
    const scheduler = Tesseract.createScheduler();
    const n = ocrWorkerCount();
    // first worker before returning so a single import can start; others join in the background
    scheduler.addWorker(await Tesseract.createWorker('eng', 1));
    for (let i = 1; i < n; i++) Tesseract.createWorker('eng', 1).then(w => scheduler.addWorker(w)).catch(() => {});
    return scheduler;
  })();
  schedulerPromise.catch(() => { schedulerPromise = null; });
  return schedulerPromise;
}

async function ocr(image, onProgress) {
  const scheduler = await getScheduler(onProgress);
  onProgress?.('Reading text…');
  const { data } = await scheduler.addJob('recognize', image);
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

// ---------- PDFs, page by page ----------

export const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

export async function openPdf(file) {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
}

async function renderPdfPage(pdf, n, scale) {
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
  return canvas;
}

export async function pdfPageImage(pdf, n, width = 180) {
  const page = await pdf.getPage(n);
  const scale = width / page.getViewport({ scale: 1 }).width;
  return (await renderPdfPage(pdf, n, scale)).toDataURL('image/jpeg', 0.7);
}

// Uses the PDF's own text if it has any (typed PDFs, scanner apps with OCR), otherwise OCRs the page image
export async function pdfPageText(pdf, n, onProgress) {
  const page = await pdf.getPage(n);
  const content = await page.getTextContent();
  let text = '', lastY = null;
  for (const item of content.items) {
    const y = item.transform?.[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
    text += item.str;
    if (item.hasEOL) text += '\n';
    lastY = y;
  }
  if (text.replace(/\s/g, '').length >= 40) return text;
  return ocr(await renderPdfPage(pdf, n, 2), onProgress);
}

// ---------- Photos ----------

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

export async function imagePreview(file, width = 180) {
  const bmp = await createImageBitmap(file);
  const scale = width / bmp.width;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

export async function imageText(file, onProgress) {
  onProgress?.('Preparing image…');
  return ocr(await prepareImage(file), onProgress);
}

// ---------- Single-file import ----------

export async function importFromFile(file, onProgress) {
  let text;
  if (isPdf(file)) {
    const pdf = await openPdf(file);
    text = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      onProgress?.(`Reading PDF page ${p} of ${pdf.numPages}…`);
      text += (await pdfPageText(pdf, p, onProgress)) + '\n';
    }
  } else if (file.type.startsWith('image/')) text = await imageText(file, onProgress);
  else if (file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)) text = await file.text();
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

// Pasted text; several recipes can be separated by a line of --- (or ===)
export function splitPastedRecipes(text) {
  return String(text || '').split(/^\s*(?:-{3,}|={3,})\s*$/m).map(t => t.trim()).filter(t => t.length > 10);
}

export function importFromText(text) {
  const draft = parseRecipeText(text);
  draft.rawText = text;
  draft.source = { type: 'text' };
  return draft;
}
