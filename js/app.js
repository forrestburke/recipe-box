import { store } from './store.js';
import { categorize, MEAL_TYPES, PROTEIN_LIST } from './categorize.js';
import { parseIngredients, parseRecipeText, extractRecipeFromHtml, parseIngredientLine, parseQuantity, normalizeUnit, normalizeName, UNIT_NAMES } from './parser.js';
import { importFromUrl, importFromFile, importFromText } from './importers.js';
import { dateRange, formatDay, generatePlan, matchesFilters, pickOne } from './planner.js';
import { buildShoppingList, groupByAisle, listToText, listToCsv } from './shopping.js';
import { formatQty, unitLabel } from './shopping.js';
import { SAMPLE_RECIPES } from './samples.js';
import { findDishImages, photoToDataUrl, CONFIDENT } from './images.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

const TAG_OPTIONS = ['vegetarian', 'vegan', 'quick', 'contains dairy', 'contains gluten', 'contains nuts', 'spicy', 'soup', 'salad', 'pasta', 'slow cooker', 'instant pot', 'grill', 'mexican', 'italian', 'asian', 'indian'];
const PROTEIN_EMOJI = { chicken: '🍗', beef: '🥩', pork: '🥓', lamb: '🍖', turkey: '🦃', duck: '🦆', fish: '🐟', shellfish: '🦐', tofu: '🧈', legumes: '🫘', eggs: '🥚' };
const MEAL_EMOJI = { breakfast: '🥞', lunch: '🥪', dinner: '🍽️', side: '🥗', dessert: '🍰', 'baked good': '🍞', snack: '🧀' };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printHtml(html) {
  $('#print-root').innerHTML = html;
  window.print();
}

function recipeEmoji(r) {
  return PROTEIN_EMOJI[r.proteins?.[0]] || MEAL_EMOJI[r.mealTypes?.[0]] || '🍲';
}

// Photo, falling back to the emoji if the image is missing or fails to load
function thumbHtml(r, cls = 'thumb') {
  return `<div class="${cls}"><span aria-hidden="true">${recipeEmoji(r)}</span>${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>`;
}

// ---------------- Automatic dish photos ----------------
const imageLookups = new Set();
async function autoImage(id, force = false) {
  const r = store.getRecipe(id);
  if (!r || r.image || (r.imageTried && !force) || imageLookups.has(id)) return false;
  imageLookups.add(id);
  try {
    const [best] = await findDishImages(r.title, { limit: 12 });
    const cur = store.getRecipe(id);
    if (!cur || cur.image) return false;
    const found = best && best.recall >= CONFIDENT;
    store.saveRecipe(found ? { ...cur, image: best.url, imageCredit: best.credit, imagePage: best.page, imageTried: true } : { ...cur, imageTried: true });
    if (found && view !== 'add') render();
    return found;
  } catch { return false; } finally { imageLookups.delete(id); }
}
async function fillMissingImages(force = false) {
  let n = 0;
  for (const r of store.recipes().filter(r => !r.image)) if (await autoImage(r.id, force)) n++;
  return n;
}

function chipsHtml(r, { tags = true } = {}) {
  return (r.mealTypes || []).map(m => `<span class="chip meal">${esc(m)}</span>`).join('')
    + (r.proteins || []).map(p => `<span class="chip protein">${PROTEIN_EMOJI[p] || ''} ${esc(p)}</span>`).join('')
    + (tags ? (r.tags || []).filter(t => !t.startsWith('contains')).map(t => `<span class="chip tag">${esc(t)}</span>`).join('') : '');
}

// ---------------- Navigation ----------------
let view = 'library';
function show(v) {
  view = v;
  $$('.view').forEach(el => el.hidden = el.id !== 'view-' + v);
  $$('.tabs [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (view === 'library') renderLibrary();
  if (view === 'plan') renderPlan();
  if (view === 'shop') renderShop();
  if (view === 'settings') renderSettings();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-view],[data-go]');
  if (b) show(b.dataset.view || b.dataset.go);
});

// ---------------- Library ----------------
function initLibrary() {
  $('#lib-meal').innerHTML = '<option value="">All meals</option>' + MEAL_TYPES.map(m => `<option value="${m}">${cap(m)}</option>`).join('');
  $('#lib-protein').innerHTML = '<option value="">Any protein</option>' + PROTEIN_LIST.map(p => `<option value="${p}">${cap(p)}</option>`).join('') + '<option value="__none">No main protein</option>';
  ['#lib-search', '#lib-meal', '#lib-protein'].forEach(s => $(s).addEventListener('input', renderLibrary));
  $('#lib-grid').addEventListener('click', e => {
    const card = e.target.closest('[data-recipe]');
    if (card) openRecipe(card.dataset.recipe);
    if (e.target.closest('#empty-samples')) loadSamples();
  });
}

function renderLibrary() {
  const all = store.recipes();
  const q = $('#lib-search').value.trim().toLowerCase();
  const meal = $('#lib-meal').value;
  const protein = $('#lib-protein').value;
  const list = all.filter(r => {
    if (meal && !r.mealTypes?.includes(meal)) return false;
    if (protein === '__none' && r.proteins?.length) return false;
    if (protein && protein !== '__none' && !r.proteins?.includes(protein)) return false;
    if (q && !(r.title.toLowerCase().includes(q) || r.ingredients?.some(i => i.raw.toLowerCase().includes(q)))) return false;
    return true;
  }).sort((a, b) => a.title.localeCompare(b.title));

  $('#lib-count').textContent = all.length ? `${list.length}${list.length !== all.length ? ' of ' + all.length : ''}` : '';
  if (!all.length) {
    $('#lib-grid').innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">📖</div>
      <p>Your recipe box is empty.</p>
      <p><button class="btn primary" data-go="add">Add your first recipe</button> <button class="btn" id="empty-samples">Load sample recipes</button></p></div>`;
    return;
  }
  if (!list.length) { $('#lib-grid').innerHTML = '<div class="empty" style="grid-column:1/-1">No recipes match.</div>'; return; }
  $('#lib-grid').innerHTML = list.map(r => `
    <button class="card recipe-card" data-recipe="${r.id}">
      ${thumbHtml(r)}
      <div class="body">
        <h3>${esc(r.title)}</h3>
        <div class="chips">${chipsHtml(r)}</div>
        <div class="meta">${r.ingredients?.length || 0} ingredients${r.totalTime ? ' · ' + r.totalTime + ' min' : ''}${r.servings ? ' · serves ' + r.servings : ''}</div>
      </div>
    </button>`).join('');
}

function loadSamples() {
  const existing = new Set(store.recipes().map(r => r.title));
  let n = 0;
  for (const text of SAMPLE_RECIPES) {
    const d = parseRecipeText(text);
    if (existing.has(d.title)) continue;
    store.saveRecipe({ ...d, ...categorize(d), ingredients: parseIngredients(d.ingredients), source: { type: 'sample' } });
    n++;
  }
  toast(n ? `Added ${n} sample recipes — finding photos…` : 'Samples already loaded');
  render();
  fillMissingImages();
}

// ---------------- Recipe dialog ----------------
function openRecipe(id) {
  const r = store.getRecipe(id);
  if (!r) return;
  const dlg = $('#recipe-dialog');
  dlg.innerHTML = `
    ${r.image ? `<div class="dlg-hero"><img src="${esc(r.image)}" alt="${esc(r.title)}" onerror="this.parentElement.remove()">${r.imageCredit ? `<a class="credit" href="${esc(r.imagePage || r.image)}" target="_blank" rel="noopener">Photo: ${esc(r.imageCredit)}</a>` : ''}</div>` : ''}
    <div class="dlg-body">
      <h1>${esc(r.title)}</h1>
      <div class="chips">${chipsHtml(r)}${(r.tags || []).filter(t => t.startsWith('contains')).map(t => `<span class="chip tag">${esc(t)}</span>`).join('')}</div>
      <p class="muted">${[r.servings && 'Serves ' + r.servings, r.totalTime && r.totalTime + ' min', r.sourceUrl && `<a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">Original recipe ↗</a>`].filter(Boolean).join(' · ')}</p>
      <div class="dlg-cols">
        <div><h2>Ingredients</h2><ul>${uniqueLines(r.ingredients || []).map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>
        <div><h2>Method</h2><ol>${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>${r.notes ? `<h2>Notes</h2><p>${esc(r.notes)}</p>` : ''}</div>
      </div>
      <div class="dlg-actions">
        <button class="btn danger" data-act="delete">Delete</button>
        <button class="btn" data-act="print">Print</button>
        <button class="btn" data-act="edit">Edit</button>
        <button class="btn primary" data-act="close">Close</button>
      </div>
    </div>`;
  dlg.onclick = e => {
    if (e.target === dlg) return dlg.close();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') dlg.close();
    if (act === 'edit') { dlg.close(); show('add'); startReview([{ ...r, _existing: true }]); }
    if (act === 'print') printHtml(`<h1>${esc(r.title)}</h1><h2>Ingredients</h2>${uniqueLines(r.ingredients).map(l => `<div class="p-item">${esc(l)}</div>`).join('')}<h2>Method</h2><ol>${r.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`);
    if (act === 'delete' && confirm(`Delete "${r.title}"?`)) { store.deleteRecipe(r.id); dlg.close(); toast('Recipe deleted'); render(); }
  };
  dlg.showModal();
}

// ---------------- Import + review ----------------
let reviewQueue = [];
let reviewIndex = 0;

function setStatus(msg, isError = false) {
  const el = $('#import-status');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}

function initAdd() {
  $('#url-form').addEventListener('submit', async e => {
    e.preventDefault();
    const url = $('#url-input').value.trim();
    setStatus('Fetching recipe…');
    try {
      const draft = await importFromUrl(url);
      setStatus('');
      $('#url-input').value = '';
      startReview([draft]);
    } catch (err) { setStatus(err.message, true); }
  });

  const fileInput = $('#file-input');
  fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });
  const dz = $('#dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); handleFiles([...e.dataTransfer.files]); });

  $('#paste-btn').addEventListener('click', () => {
    const t = $('#paste-input').value.trim();
    if (!t) return setStatus('Paste some recipe text first.', true);
    $('#paste-input').value = '';
    startReview([importFromText(t)]);
  });
  initIngredientEditor($('#review'));
  $('#blank-btn').addEventListener('click', () => startReview([{ title: '', ingredients: [], steps: [], source: { type: 'manual' }, method: 'manual' }]));

  // Bookmarklet: runs on the recipe page in the user's own browser, so sites can't block it.
  const appUrl = location.origin + location.pathname;
  const code = `(()=>{const f=d=>{if(!d||typeof d!='object')return null;if(Array.isArray(d)){for(const x of d){const r=f(x);if(r)return r}return null}const t=[].concat(d['@type']||[]);if(t.some(x=>String(x).toLowerCase()=='recipe'))return d;return f(d['@graph'])||f(d.mainEntity)};let r=null;for(const s of document.querySelectorAll('script[type="application/ld+json"]')){try{r=f(JSON.parse(s.textContent))}catch(e){}if(r)break}const p={u:location.href,n:document.title};if(r)p.r=r;else p.t=document.body.innerText.slice(0,20000);window.open(${JSON.stringify(appUrl)}+'#import='+encodeURIComponent(JSON.stringify(p)),'_blank')})()`;
  $('#bookmarklet').href = 'javascript:' + encodeURIComponent(code);
  $('#bookmarklet').addEventListener('click', e => { e.preventDefault(); toast('Drag this button to your bookmarks bar'); });
}

// Handles #import=... links created by the bookmarklet
function handleImportHash() {
  if (!location.hash.startsWith('#import=')) return false;
  let payload;
  try { payload = JSON.parse(decodeURIComponent(location.hash.slice(8))); } catch { payload = null; }
  history.replaceState(null, '', '#add');
  if (!payload) { toast('Could not read that recipe'); return false; }
  let draft;
  if (payload.r) {
    const html = `<script type="application/ld+json">${JSON.stringify(payload.r).replace(/</g, '\\u003c')}</script>`;
    draft = extractRecipeFromHtml(html, payload.u);
  } else {
    draft = importFromText(payload.t || '');
    if (payload.n) draft.title = payload.n.split(/\s[|–-]\s/)[0];
    draft.sourceUrl = payload.u;
  }
  draft.source = { type: 'url', url: payload.u };
  show('add');
  startReview([draft]);
  return true;
}

async function handleFiles(files) {
  if (!files.length) return;
  const drafts = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const prefix = files.length > 1 ? `File ${i + 1} of ${files.length} (${f.name}): ` : '';
    try {
      setStatus(prefix + 'Starting…');
      drafts.push(await importFromFile(f, msg => setStatus(prefix + msg)));
    } catch (err) {
      console.error(err);
      setStatus(prefix + err.message, true);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  setStatus('');
  if (drafts.length) startReview(drafts);
}

function startReview(drafts) {
  reviewQueue = drafts;
  reviewIndex = 0;
  renderReview();
}

// ---------- Ingredient row editor ----------
// Each row: { raw, qty, qtyMax, unit, name, key, display, note, dirty, keyEdited }
let ingRows = [];
let ingTextMode = false;

const qtyText = r => r.qty == null ? '' : formatQty(r.qty) + (r.qtyMax != null ? '–' + formatQty(r.qtyMax) : '');

function toRows(ingredients) {
  const objs = (ingredients || []).some(i => typeof i === 'string') ? parseIngredients(ingredients.map(i => typeof i === 'string' ? i : i.raw)) : ingredients || [];
  return objs.map(i => ({ ...i, display: i.display || i.key, dirty: false, keyEdited: false }));
}

// Rebuild the printed line from the fields when the user changed them
function rowRaw(r) {
  if (!r.dirty) return r.raw;
  return [qtyText(r), r.note && `(${r.note})`, unitLabel(r.unit, r.qtyMax ?? r.qty), r.name].filter(Boolean).join(' ').trim();
}

// "Salt and pepper" is stored as two items sharing one original line; show that line once
function uniqueLines(ingredients) {
  return ingredients.map(i => i.raw).filter((raw, i, all) => raw !== all[i - 1]);
}

function rowsToIngredients() {
  return ingRows
    .filter(r => (r.name || '').trim() || (r.key || '').trim())
    .map(r => ({
      raw: rowRaw(r), qty: r.qty, qtyMax: r.qtyMax ?? null, unit: r.unit || null,
      name: (r.name || '').trim(), key: r.key || normalizeName(r.name || ''), display: r.display || r.key, note: r.note || '',
    }));
}

function renderIngredientEditor() {
  const el = $('#ing-editor');
  if (!el) return;
  if (ingTextMode) {
    el.innerHTML = `
      <textarea id="ing-text" rows="12" aria-label="Ingredients, one per line">${esc(uniqueLines(rowsToIngredients()).join('\n'))}</textarea>
      <div class="row end"><button type="button" class="btn small primary" data-ing="text-done">Done — back to table</button></div>`;
    return;
  }
  el.innerHTML = `
    <div class="ing-head" aria-hidden="true"><span>Amount</span><span>Unit</span><span>Ingredient</span><span></span></div>
    ${ingRows.map((r, i) => `
      <div class="ing-row" data-i="${i}">
        <input class="ing-qty" data-f="qty" value="${esc(qtyText(r))}" placeholder="—" aria-label="Amount" inputmode="decimal">
        <input class="ing-unit" data-f="unit" list="unit-options" value="${esc(r.unit || '')}" placeholder="—" aria-label="Unit">
        <div class="ing-name-wrap">
          <input class="ing-name" data-f="name" value="${esc(r.name)}" placeholder="e.g. garlic, minced" aria-label="Ingredient">
          <label class="ing-key">🛒 <input data-f="key" value="${esc(r.display || r.key || '')}" placeholder="name on shopping list" aria-label="Name on shopping list" title="Items with the same shopping-list name are combined"></label>
        </div>
        <div class="ing-actions">
          <button type="button" class="btn icon small" data-ing="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn icon small" data-ing="down" title="Move down" ${i === ingRows.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn icon small" data-ing="remove" title="Remove ingredient">✕</button>
        </div>
      </div>`).join('')}
    ${ingRows.length ? '' : '<p class="muted">No ingredients yet.</p>'}
    <div class="row wrap" style="margin-top:8px">
      <button type="button" class="btn small" data-ing="add">+ Add ingredient</button>
      <button type="button" class="btn small ghost" data-ing="text">Edit as text</button>
    </div>
    <datalist id="unit-options">${UNIT_NAMES.map(u => `<option value="${u}">`).join('')}</datalist>`;
}

function initIngredientEditor(box) {
  box.addEventListener('input', e => {
    const f = e.target.dataset.f;
    const rowEl = e.target.closest('.ing-row');
    if (!f || !rowEl) return;
    const r = ingRows[+rowEl.dataset.i];
    const v = e.target.value;
    r.dirty = true;
    if (f === 'qty') Object.assign(r, parseQuantity(v));
    if (f === 'unit') r.unit = normalizeUnit(v);
    if (f === 'name') {
      r.name = v;
      if (!r.keyEdited) {
        const p = parseIngredientLine('1 ' + v);
        r.key = p.key; r.display = p.display;
        $('[data-f="key"]', rowEl).value = r.display || '';
      }
    }
    if (f === 'key') { r.keyEdited = true; r.display = v.trim(); r.key = normalizeName(v) || v.trim().toLowerCase(); }
  });
  // Tidy the amount/unit fields when leaving them (e.g. "tablespoons" -> "tbsp")
  box.addEventListener('focusout', e => {
    const f = e.target.dataset.f;
    const rowEl = e.target.closest('.ing-row');
    if (!rowEl || !ingRows[+rowEl.dataset.i]?.dirty) return;
    const r = ingRows[+rowEl.dataset.i];
    if (f === 'qty' && e.target.value.trim() && r.qty == null) e.target.classList.add('invalid');
    else if (f === 'qty') { e.target.classList.remove('invalid'); e.target.value = qtyText(r); }
    if (f === 'unit') e.target.value = r.unit || '';
  });
  // Enter in a row adds a new row below
  box.addEventListener('keydown', e => {
    const rowEl = e.target.closest('.ing-row');
    if (e.key !== 'Enter' || !rowEl) return;
    e.preventDefault();
    const i = +rowEl.dataset.i + 1;
    ingRows.splice(i, 0, { raw: '', qty: null, unit: null, name: '', key: '', display: '', note: '', dirty: true });
    renderIngredientEditor();
    $(`.ing-row[data-i="${i}"] .ing-qty`)?.focus();
  });
}

function handleIngredientAction(action, target) {
  const i = +target.closest('.ing-row')?.dataset.i;
  if (action === 'add') {
    ingRows.push({ raw: '', qty: null, unit: null, name: '', key: '', display: '', note: '', dirty: true });
    renderIngredientEditor();
    $(`.ing-row[data-i="${ingRows.length - 1}"] .ing-qty`)?.focus();
    return;
  }
  if (action === 'remove') ingRows.splice(i, 1);
  if (action === 'up' && i > 0) [ingRows[i - 1], ingRows[i]] = [ingRows[i], ingRows[i - 1]];
  if (action === 'down' && i < ingRows.length - 1) [ingRows[i + 1], ingRows[i]] = [ingRows[i], ingRows[i + 1]];
  if (action === 'text') ingTextMode = true;
  if (action === 'text-done') {
    // Keep rows (and any custom shopping-list names) for lines that weren't changed
    const previous = new Map();
    for (const r of ingRows) {
      const raw = rowRaw(r);
      if (!previous.has(raw)) previous.set(raw, []);
      previous.get(raw).push({ ...r, raw, dirty: false });
    }
    ingRows = $('#ing-text').value.split('\n').map(l => l.trim()).filter(Boolean)
      .flatMap(line => previous.get(line) || toRows([line]));
    ingTextMode = false;
  }
  renderIngredientEditor();
}

// Turn any draft (import result or saved recipe) into editor state
function toEditorState(d) {
  const lines = (d.ingredients || []).map(i => typeof i === 'string' ? i : i.raw);
  const suggested = d._existing ? {} : categorize({ ...d, ingredients: lines });
  return {
    id: d._existing ? d.id : undefined,
    createdAt: d.createdAt,
    title: d.title || '',
    mealTypes: d.mealTypes || suggested.mealTypes || [],
    proteins: d.proteins || suggested.proteins || [],
    tags: d.tags || suggested.tags || [],
    servings: d.servings || '',
    totalTime: d.totalTime || '',
    sourceUrl: d.sourceUrl || d.source?.url || '',
    image: d.image || '',
    imageCredit: d.imageCredit || '',
    imagePage: d.imagePage || '',
    imageTried: !!d.imageTried,
    ingredients: d.ingredients || [],
    stepsText: (d.steps || []).join('\n'),
    notes: d.notes || '',
    rawText: d.rawText || '',
    source: d.source,
    method: d.method,
    hints: d.hints || [],
    existing: !!d._existing,
  };
}

function chipToggleGroup(name, options, selected, cls = '') {
  return `<div class="chips" data-group="${name}">` + options.map(o =>
    `<button type="button" class="chip ${cls}" data-value="${esc(o)}" aria-pressed="${selected.includes(o)}">${esc(o)}</button>`).join('') + '</div>';
}

function renderReview() {
  const box = $('#review');
  const sources = $('#add-sources');
  if (reviewIndex >= reviewQueue.length) {
    box.hidden = true; sources.hidden = false; box.innerHTML = '';
    return;
  }
  sources.hidden = true; box.hidden = false;
  const s = toEditorState(reviewQueue[reviewIndex]);
  const methodMsg = {
    structured: '✅ This page publishes structured recipe data, so the details should be accurate.',
    heuristic: '👀 Detected by reading the text — please check ingredients and steps are split correctly.',
    manual: '✍️ Type or paste the recipe details.',
  }[s.method] || '';
  const tagOpts = [...new Set([...TAG_OPTIONS, ...s.tags])];

  box.innerHTML = `
    <div class="editor-head">
      <h1>${s.existing ? 'Edit recipe' : 'Review recipe'}${reviewQueue.length > 1 ? ` <span class="count">${reviewIndex + 1} of ${reviewQueue.length}</span>` : ''}</h1>
      <div class="row wrap">
        <button class="btn ghost" data-act="cancel">${reviewQueue.length > 1 ? 'Skip' : 'Cancel'}</button>
        <button class="btn primary" data-act="save">${reviewIndex < reviewQueue.length - 1 ? 'Save & next' : 'Save recipe'}</button>
      </div>
    </div>
    ${methodMsg && !s.existing ? `<p class="method-note">${methodMsg}</p>` : ''}
    <form class="editor card" id="editor-form" onsubmit="return false">
      <div class="full">
        <label class="field">Title<input name="title" value="${esc(s.title)}" placeholder="Recipe name" required></label>
      </div>
      <div>
        <div class="group"><div class="label">Meal type</div>${chipToggleGroup('mealTypes', MEAL_TYPES, s.mealTypes)}</div>
        <div class="group"><div class="label">Main protein</div>${chipToggleGroup('proteins', PROTEIN_LIST, s.proteins)}</div>
        <div class="group"><div class="label">Tags <button type="button" class="btn ghost small" data-act="redetect">↻ Re-detect from ingredients</button></div>${chipToggleGroup('tags', tagOpts, s.tags)}
          <div class="row" style="margin-top:8px"><input id="new-tag" placeholder="Add your own tag (e.g. family favourite)"><button type="button" class="btn small" data-act="add-tag">Add</button></div>
        </div>
      </div>
      <div>
        <div class="row">
          <label class="field" style="flex:1">Serves<input name="servings" type="number" min="1" value="${esc(s.servings)}"></label>
          <label class="field" style="flex:1">Total time (min)<input name="totalTime" type="number" min="1" value="${esc(s.totalTime)}"></label>
        </div>
        <label class="field">Source link<input name="sourceUrl" type="url" value="${esc(s.sourceUrl)}" placeholder="https://…"></label>
        <div class="group">
          <div class="label">Photo</div>
          <div class="img-picker">
            <div class="img-preview" id="img-preview"></div>
            <div class="row wrap">
              <button type="button" class="btn small" data-act="find-photos">🔍 Find photos</button>
              <label class="btn small">📷 Upload my own<input type="file" id="photo-upload" accept="image/*" hidden></label>
              <button type="button" class="btn small ghost" data-act="remove-photo">Remove</button>
            </div>
            <input id="photo-url" type="url" placeholder="…or paste an image link" aria-label="Image link" value="${esc(s.image.startsWith('data:') ? '' : s.image)}">
          </div>
          <div id="photo-results" class="photo-results"></div>
        </div>
      </div>
      <div class="full">
        <div class="group">
          <div class="label">Ingredients <span class="hint">Edit any amount, unit or name. 🛒 is how it's listed and combined on the shopping list.</span></div>
          <div id="ing-editor"></div>
        </div>
        <label class="field">Steps — one per line<textarea name="stepsText" rows="8">${esc(s.stepsText)}</textarea></label>
        <label class="field">Notes<textarea name="notes" rows="2">${esc(s.notes)}</textarea></label>
        ${s.rawText ? `<details><summary>Scanned text (edit and re-read if the split above looks wrong)</summary>
          <textarea id="raw-text" rows="10" style="margin-top:8px">${esc(s.rawText)}</textarea>
          <div class="row end"><button type="button" class="btn" data-act="reparse">Re-read from this text</button></div></details>` : ''}
      </div>
    </form>`;

  const form = $('#editor-form');
  ingRows = toRows(s.ingredients);
  ingTextMode = false;
  renderIngredientEditor();

  // Photo picker state lives on s (image, imageCredit, imagePage)
  const renderPhoto = () => {
    $('#img-preview').innerHTML = s.image
      ? `<img src="${esc(s.image)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'Image could not be loaded'}))">${s.imageCredit ? `<small>${esc(s.imageCredit)}</small>` : ''}`
      : `<span class="muted">No photo yet</span>`;
  };
  const setPhoto = (image, credit = '', page = '') => { Object.assign(s, { image, imageCredit: credit, imagePage: page }); renderPhoto(); };
  renderPhoto();
  $('#photo-url').addEventListener('change', e => setPhoto(e.target.value.trim(), '', ''));
  $('#photo-upload').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { setPhoto(await photoToDataUrl(f), 'Your photo'); $('#photo-url').value = ''; }
    catch { toast('Could not read that image'); }
  });
  const findPhotos = async () => {
    const out = $('#photo-results');
    const title = form.title.value.trim();
    if (!title) return toast('Add a title first');
    out.innerHTML = '<p class="muted">Searching for photos…</p>';
    const found = await findDishImages(title, { limit: 12 }).catch(() => []);
    out.innerHTML = found.length
      ? `<p class="muted">Click a photo to use it:</p><div class="photo-grid">${found.map((c, i) => `
          <button type="button" class="photo-option ${c.url === s.image ? 'selected' : ''}" data-photo="${i}" title="${esc(c.title)} — ${esc(c.credit)}">
            <img src="${esc(c.thumb)}" alt="${esc(c.title)}" loading="lazy" onerror="this.parentElement.remove()"><span>${esc(c.credit)}</span>
          </button>`).join('')}</div>`
      : '<p class="muted">No photos found for this name. Try a simpler title, upload your own, or paste an image link.</p>';
    out.onclick = e => {
      const b = e.target.closest('[data-photo]');
      if (!b) return;
      const c = found[+b.dataset.photo];
      setPhoto(c.url, c.credit, c.page);
      $('#photo-url').value = c.url;
      $$('.photo-option', out).forEach(o => o.classList.toggle('selected', o === b));
    };
  };
  // New imports without a photo: show suggestions straight away
  if (!s.image && !s.existing && s.title) findPhotos();

  box.onclick = e => {
    const ingBtn = e.target.closest('[data-ing]');
    if (ingBtn) return handleIngredientAction(ingBtn.dataset.ing, ingBtn);
    const chip = e.target.closest('.chips[data-group] .chip');
    if (chip) chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') !== 'true');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') { reviewIndex++; renderReview(); }
    if (act === 'find-photos') findPhotos();
    if (act === 'remove-photo') { setPhoto(''); s.imageTried = true; $('#photo-url').value = ''; }
    if (act === 'save') saveReview(s);
    if (act === 'add-tag') {
      const v = $('#new-tag').value.trim().toLowerCase();
      if (!v) return;
      const grp = $('[data-group="tags"]', box);
      if (!$(`[data-value="${CSS.escape(v)}"]`, grp)) grp.insertAdjacentHTML('beforeend', `<button type="button" class="chip" data-value="${esc(v)}" aria-pressed="true">${esc(v)}</button>`);
      $('#new-tag').value = '';
    }
    if (act === 'redetect') {
      const c = categorize({ title: form.title.value, hints: s.hints, ingredients: rowsToIngredients().map(i => i.raw), totalTime: +form.totalTime.value || null });
      for (const [g, vals] of Object.entries({ mealTypes: c.mealTypes, proteins: c.proteins, tags: c.tags })) {
        $$(`[data-group="${g}"] .chip`, box).forEach(ch => ch.setAttribute('aria-pressed', vals.includes(ch.dataset.value)));
      }
      toast('Categories re-detected');
    }
    if (act === 'reparse') {
      const d = parseRecipeText($('#raw-text').value);
      form.title.value = d.title !== 'Untitled recipe' ? d.title : form.title.value;
      ingRows = toRows(d.ingredients);
      ingTextMode = false;
      renderIngredientEditor();
      form.stepsText.value = d.steps.join('\n');
      toast('Re-read from text');
    }
  };
}

function saveReview(s) {
  const form = $('#editor-form');
  const title = form.title.value.trim();
  if (!title) { form.title.focus(); return toast('Give the recipe a title'); }
  if (ingTextMode) handleIngredientAction('text-done', form);
  const pressed = g => $$(`[data-group="${g}"] .chip[aria-pressed="true"]`).map(c => c.dataset.value);
  const recipe = {
    id: s.id,
    createdAt: s.createdAt,
    title,
    mealTypes: pressed('mealTypes'),
    proteins: pressed('proteins'),
    tags: pressed('tags'),
    servings: +form.servings.value || null,
    totalTime: +form.totalTime.value || null,
    sourceUrl: form.sourceUrl.value.trim(),
    image: s.image,
    imageCredit: s.image ? s.imageCredit : '',
    imagePage: s.image ? s.imagePage : '',
    imageTried: s.imageTried,
    ingredients: rowsToIngredients(),
    steps: form.stepsText.value.split('\n').map(l => l.trim()).filter(Boolean),
    notes: form.notes.value.trim(),
    source: s.source || { type: 'manual' },
  };
  if (!recipe.mealTypes.length) recipe.mealTypes = ['dinner'];
  const saved = store.saveRecipe(recipe);
  toast(`Saved "${title}"`);
  if (!saved.image && !saved.imageTried) autoImage(saved.id); // look up a dish photo in the background
  reviewIndex++;
  if (reviewIndex >= reviewQueue.length) {
    renderReview();
    show('library');
    if (s.existing) openRecipe(saved.id); // back to the recipe you were editing
  } else renderReview();
}

// ---------------- Meal plan ----------------
function todayIso(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function getPlan() {
  return store.get('plan') || { start: todayIso(), end: todayIso(6), days: [], warnings: [] };
}

function renderPlan() {
  const plan = getPlan();
  const st = store.settings();
  const f = st.filters;
  const recipes = store.recipes();
  const matching = recipes.filter(r => matchesFilters(r, f));
  const proteinsInLib = PROTEIN_LIST.filter(p => recipes.some(r => r.proteins?.includes(p)));

  $('#plan-filters').innerHTML = `
    <h3>Dates</h3>
    <div class="dates">
      <label class="field">From<input type="date" id="plan-start" value="${plan.start}"></label>
      <label class="field">To<input type="date" id="plan-end" value="${plan.end}"></label>
    </div>
    <h3>Meal type to plan</h3>
    ${chipToggleGroup('f-mealTypes', MEAL_TYPES, f.mealTypes)}
    <h3>Skip these proteins this time</h3>
    ${chipToggleGroup('f-excludeProteins', proteinsInLib.length ? proteinsInLib : PROTEIN_LIST, f.excludeProteins, 'exclude')}
    <h3>Must be</h3>
    ${chipToggleGroup('f-requireTags', ['vegetarian', 'vegan', 'quick'], f.requireTags || [])}
    <h3>Leave out</h3>
    ${chipToggleGroup('f-excludeTags', ['contains dairy', 'contains gluten', 'contains nuts', 'spicy', 'pasta', 'soup', 'slow cooker'], f.excludeTags, 'exclude')}
    <label class="field" style="margin-top:12px">Avoid ingredients (comma separated)<input id="f-excludeIngredients" value="${esc(f.excludeIngredients)}" placeholder="e.g. mushroom, cilantro"></label>
    <label class="check"><input type="checkbox" id="f-b2b" ${st.avoidBackToBack ? 'checked' : ''}> Don't repeat a protein two nights in a row</label>
    <div class="match"><strong>${matching.length}</strong> of ${recipes.length} recipes match</div>
    <button class="btn primary" id="plan-generate" style="width:100%">${plan.days.length ? '🎲 Re-shuffle unlocked days' : '🎲 Generate meal plan'}</button>`;

  const dates = dateRange(plan.start, plan.end);
  const byDate = new Map(plan.days.map(d => [d.date, d]));
  const map = store.recipeMap();
  $('#plan-warnings').innerHTML = (plan.warnings || []).map(w => `<div class="warning">${esc(w)}</div>`).join('')
    + (dates.length === 0 ? '<div class="warning">Choose an end date on or after the start date.</div>' : '');

  if (!plan.days.length) {
    $('#plan-days').innerHTML = `<div class="card empty"><div class="big">🗓️</div><p>${recipes.length ? 'Pick your dates and filters, then generate a plan.' : 'Add some recipes first, then come back to plan.'}</p></div>`;
    return;
  }
  const options = [...matching, ...recipes.filter(r => !matching.includes(r))];
  $('#plan-days').innerHTML = dates.map(date => {
    const d = byDate.get(date) || { date };
    const r = map.get(d.recipeId);
    const [dow, ...rest] = formatDay(date).split(' ');
    return `<div class="card day ${d.skip ? 'skip' : ''} ${d.locked ? 'locked' : ''}" data-date="${date}">
      <div class="date">${esc(dow.replace(',', ''))}<small>${esc(rest.join(' '))}</small></div>
      <div>
        ${d.skip ? '<span class="muted">No cooking — eating out / leftovers</span>'
          : r ? `<div class="day-meal"><button class="day-thumb-btn" data-open="${r.id}" aria-label="Open ${esc(r.title)}">${thumbHtml(r, 'day-thumb')}</button><div><button class="title" data-open="${r.id}">${esc(r.title)}</button><div class="chips" style="margin-top:4px">${chipsHtml(r, { tags: false })}</div></div></div>`
          : '<span class="muted">Nothing planned</span>'}
        ${d.skip ? '' : `<select data-choose aria-label="Choose recipe"><option value="">${r ? 'Pick a different recipe…' : 'Choose a recipe…'}</option>${options.filter(o => o.id !== d.recipeId).map(o => `<option value="${o.id}">${esc(o.title)}${matching.includes(o) ? '' : ' (outside filters)'}</option>`).join('')}</select>`}
      </div>
      <div class="actions">
        <button class="btn icon" data-day="swap" title="Swap for another recipe" ${d.skip ? 'disabled' : ''}>🔀</button>
        <button class="btn icon" data-day="lock" title="${d.locked ? 'Unlock' : 'Lock (keep when re-shuffling)'}" aria-pressed="${!!d.locked}">${d.locked ? '🔒' : '🔓'}</button>
        <button class="btn icon" data-day="skip" title="${d.skip ? 'Cook this night' : 'No cooking this night'}" aria-pressed="${!!d.skip}">🚫</button>
      </div>
    </div>`;
  }).join('') + `<div class="plan-footer"><button class="btn primary" data-go="shop">🛒 View shopping list</button></div>`;
}

function initPlan() {
  const filtersEl = $('#plan-filters');
  const saveFilters = () => {
    const pressed = g => $$(`[data-group="${g}"] .chip[aria-pressed="true"]`, filtersEl).map(c => c.dataset.value);
    store.updateSettings({
      filters: {
        mealTypes: pressed('f-mealTypes'),
        excludeProteins: pressed('f-excludeProteins'),
        excludeTags: pressed('f-excludeTags'),
        requireTags: pressed('f-requireTags'),
        excludeIngredients: $('#f-excludeIngredients').value,
      },
      avoidBackToBack: $('#f-b2b').checked,
    });
  };
  filtersEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip) { chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') !== 'true'); saveFilters(); renderPlan(); }
    if (e.target.closest('#plan-generate')) {
      const plan = getPlan();
      const dates = dateRange(plan.start, plan.end);
      if (!dates.length) return toast('Check your dates');
      const st = store.settings();
      const { days, warnings } = generatePlan(store.recipes(), st.filters, dates, plan.days, { avoidBackToBack: st.avoidBackToBack });
      store.set('plan', { ...plan, days, warnings });
      renderPlan();
    }
  });
  filtersEl.addEventListener('change', e => {
    if (e.target.id === 'plan-start' || e.target.id === 'plan-end') {
      const plan = getPlan();
      plan[e.target.id === 'plan-start' ? 'start' : 'end'] = e.target.value;
      if (plan.start > plan.end && e.target.id === 'plan-start') plan.end = plan.start;
      const valid = new Set(dateRange(plan.start, plan.end));
      plan.days = plan.days.filter(d => valid.has(d.date));
      store.set('plan', plan);
      renderPlan();
    }
    if (e.target.id === 'f-excludeIngredients' || e.target.id === 'f-b2b') { saveFilters(); renderPlan(); }
  });

  $('#plan-days').addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) return openRecipe(open.dataset.open);
    const btn = e.target.closest('[data-day]');
    if (!btn) return;
    const date = btn.closest('[data-date]').dataset.date;
    updateDay(date, d => {
      if (btn.dataset.day === 'lock') d.locked = !d.locked;
      if (btn.dataset.day === 'skip') { d.skip = !d.skip; if (d.skip) d.locked = false; }
      if (btn.dataset.day === 'swap') {
        const used = getPlan().days.map(x => x.recipeId).filter(Boolean);
        const r = pickOne(store.recipes(), store.settings().filters, used);
        if (r) d.recipeId = r.id; else toast('No other recipes match your filters');
      }
    });
  });
  $('#plan-days').addEventListener('change', e => {
    if (!e.target.matches('[data-choose]')) return;
    const date = e.target.closest('[data-date]').dataset.date;
    if (!e.target.value) return;
    updateDay(date, d => { d.recipeId = e.target.value; d.locked = true; });
  });
}

function updateDay(date, fn) {
  const plan = getPlan();
  let d = plan.days.find(x => x.date === date);
  if (!d) { d = { date, recipeId: null }; plan.days.push(d); }
  fn(d);
  store.set('plan', { ...plan, days: [...plan.days] });
  renderPlan();
}

// ---------------- Shopping list ----------------
let showHave = false;

function currentList() {
  const st = store.settings();
  return buildShoppingList(getPlan(), store.recipeMap(), st.pantry, store.get('shopping'));
}

function renderShop() {
  const plan = getPlan();
  const list = currentList();
  const cooking = plan.days.filter(d => d.recipeId && !d.skip).length;
  $('#shop-sub').textContent = cooking
    ? `${cooking} meal${cooking === 1 ? '' : 's'}, ${formatDay(plan.start)} – ${formatDay(plan.end)}. Tick anything you already have — it drops off the printed list. ⭐ marks pantry staples you always have.`
    : 'Generate a meal plan first — the list is built from its recipes. You can still add your own items.';
  $('#shop-share').hidden = !navigator.share;

  const need = list.filter(i => !i.have);
  const have = list.filter(i => i.have);
  const pantry = store.settings().pantry.map(p => p.toLowerCase());
  const itemHtml = i => `
    <div class="item ${i.have ? 'have' : ''}" data-key="${esc(i.key)}">
      <input type="checkbox" ${i.have ? 'checked' : ''} aria-label="Have ${esc(i.name)}" title="I already have this">
      <div><div class="name">${esc(i.name)}</div>${i.recipes.length ? `<div class="for">${esc(i.recipes.join(', '))}</div>` : ''}</div>
      <div class="amt" title="${esc(i.raw.join('\n'))}">${esc(i.amount)}</div>
      ${i.custom ? `<button class="star" data-remove title="Remove">✕</button>` : `<button class="star ${pantry.includes(i.key) ? 'on' : ''}" data-star title="${pantry.includes(i.key) ? 'Remove from' : 'Add to'} always-have pantry">⭐</button>`}
    </div>`;
  const section = items => [...groupByAisle(items)].map(([aisle, its]) => `<div class="aisle"><h2>${esc(aisle)}</h2><div class="items">${its.map(itemHtml).join('')}</div></div>`).join('');

  $('#shop-list').innerHTML = (need.length ? section(need) : (list.length ? '<div class="card empty">🎉 You have everything!</div>' : ''))
    + (have.length ? `<details class="have-section" ${showHave ? 'open' : ''}><summary>Already have (${have.length})</summary>${section(have)}</details>` : '');
}

function initShop() {
  const shopState = () => structuredClone(store.get('shopping') || { overrides: {}, custom: [] });
  $('#shop-list').addEventListener('change', e => {
    if (e.target.type !== 'checkbox') return;
    const key = e.target.closest('[data-key]').dataset.key;
    const s = shopState();
    if (key.startsWith('custom:')) {
      const c = s.custom.find(c => 'custom:' + c.id === key);
      if (c) c.have = e.target.checked;
    } else s.overrides[key] = e.target.checked;
    store.set('shopping', s);
    renderShop();
  });
  $('#shop-list').addEventListener('click', e => {
    const row = e.target.closest('[data-key]');
    if (!row) return;
    const key = row.dataset.key;
    if (e.target.closest('[data-remove]')) {
      const s = shopState();
      s.custom = s.custom.filter(c => 'custom:' + c.id !== key);
      store.set('shopping', s);
      renderShop();
    }
    if (e.target.closest('[data-star]')) {
      const pantry = store.settings().pantry.slice();
      const i = pantry.findIndex(p => p.toLowerCase() === key);
      if (i === -1) { pantry.push(key); toast(`"${key}" will always be ticked`); } else { pantry.splice(i, 1); toast(`Removed "${key}" from pantry`); }
      const s = shopState(); delete s.overrides[key]; store.set('shopping', s);
      store.updateSettings({ pantry });
      renderShop();
    }
  });
  $('#shop-list').addEventListener('toggle', e => { if (e.target.matches('.have-section')) showHave = e.target.open; }, true);
  $('#shop-add').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#shop-add-input').value.trim();
    if (!name) return;
    const s = shopState();
    s.custom.push({ id: Date.now().toString(36), name, have: false });
    store.set('shopping', s);
    $('#shop-add-input').value = '';
    renderShop();
  });

  const title = () => { const p = getPlan(); return `Shopping list — ${formatDay(p.start)} to ${formatDay(p.end)}`; };
  $('#shop-print').addEventListener('click', () => {
    const need = currentList().filter(i => !i.have);
    printHtml(`<h1>${esc(title())}</h1><div class="p-cols">${[...groupByAisle(need)].map(([a, its]) =>
      `<div class="p-aisle"><h2>${esc(a)}</h2>${its.map(i => `<div class="p-item">${esc(i.name)} <span class="p-amt">${esc(i.amount)}</span></div>`).join('')}</div>`).join('')}</div>`);
  });
  $('#shop-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(listToText(currentList(), title())); toast('Copied to clipboard'); }
    catch { toast('Copy failed — try Download instead'); }
  });
  $('#shop-share').addEventListener('click', () => navigator.share({ title: title(), text: listToText(currentList(), title()) }).catch(() => {}));
  $('#shop-txt').addEventListener('click', () => download('shopping-list.txt', listToText(currentList(), title())));
  $('#shop-csv').addEventListener('click', () => download('shopping-list.csv', listToCsv(currentList()), 'text/csv'));
}

// ---------------- Settings ----------------
function renderSettings() {
  $('#pantry-input').value = store.settings().pantry.join('\n');
  const c = store.cloudStatus();
  $('#cloud-body').innerHTML = !c
    ? `<p class="muted">Recipes are saved in this browser only. To sync between your phone and computer, add your Firebase config to <code>js/config.js</code> (see README).</p>`
    : c.signedIn
      ? `<p>Signed in as <strong>${esc(c.name)}</strong>. Recipes sync automatically.</p><button class="btn" id="signout-btn">Sign out</button>`
      : `<p class="muted">Sign in to sync your recipes across devices.</p><button class="btn primary" id="signin-btn">Sign in with Google</button>`;
}

function initSettings() {
  $('#pantry-save').addEventListener('click', () => {
    store.updateSettings({ pantry: $('#pantry-input').value.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean) });
    toast('Pantry saved');
  });
  $('#backup-btn').addEventListener('click', () => download(`recipe-box-backup-${todayIso()}.json`, store.exportJSON(), 'application/json'));
  $('#restore-input').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { store.importJSON(await f.text()); toast('Backup restored'); } catch (err) { alert(err.message); }
    e.target.value = '';
  });
  $('#samples-btn').addEventListener('click', loadSamples);
  $('#photos-btn').addEventListener('click', async e => {
    const missing = store.recipes().filter(r => !r.image).length;
    if (!missing) return toast('Every recipe already has a photo');
    e.target.disabled = true;
    e.target.textContent = `Searching ${missing} recipe${missing === 1 ? '' : 's'}…`;
    const n = await fillMissingImages(true);
    e.target.disabled = false;
    e.target.textContent = 'Find missing photos';
    toast(n ? `Added ${n} photo${n === 1 ? '' : 's'}${missing - n ? ` — ${missing - n} had no good match (pick one in Edit)` : ''}` : 'No good matches found — use Edit → Find photos to choose one');
  });
  $('#wipe-btn').addEventListener('click', () => {
    if (confirm('Delete ALL recipes? Download a backup first if unsure.')) {
      for (const r of store.recipes().slice()) store.deleteRecipe(r.id);
      store.set('plan', null);
      toast('All recipes deleted');
    }
  });
  $('#cloud-body').addEventListener('click', e => {
    if (e.target.id === 'signin-btn') store.signIn().catch(err => alert(err.message));
    if (e.target.id === 'signout-btn') store.signOut();
  });
}

// ---------------- Boot ----------------
store.init();
store.onChange(ch => { if (ch.cloud || ch.all) render(); });
setTimeout(() => fillMissingImages(), 1500); // quietly find photos for recipes saved before this feature
initLibrary(); initAdd(); initPlan(); initShop(); initSettings();
if (!handleImportHash()) {
  const start = location.hash.slice(1);
  show(['library', 'add', 'plan', 'shop', 'settings'].includes(start) ? start : 'library');
}
window.addEventListener('hashchange', () => {
  if (handleImportHash()) return;
  const v = location.hash.slice(1);
  if (v && v !== view) show(v);
});
