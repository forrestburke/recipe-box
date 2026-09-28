// Bulk import: a big scanned PDF, a batch of photos, a CSV, or several pasted recipes
// -> one checklist of recipes -> save them all at once.
//
// Pages become recipes one-to-one; a page that looks like it continues the previous
// recipe (no ingredient list of its own) is joined to it automatically, and the user
// can join/split pages by hand.
import { parseRecipeText, parseIngredients } from './parser.js';
import { categorize } from './categorize.js';
import { isPdf, openPdf, pdfPageImage, pdfPageText, imagePreview, imageText, ocrWorkerCount } from './importers.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Not enough to be a recipe on its own: probably the back half of the previous page's recipe
export function looksLikeContinuation(text) {
  const t = String(text || '');
  if (/\bingredients?\b/i.test(t)) return false;
  return parseRecipeText(t).ingredients.length < 2;
}
export const isBlankPage = (text) => String(text || '').replace(/\s/g, '').length < 15;

// A draft is "weak" if it's worth a second look before trusting it
export function isWeak(d, title) {
  return (d.ingredients?.length || 0) < 3 || !(d.steps?.length) || !title || /^untitled/i.test(title);
}

export function createBulk({ root, store, toast, onReview, onFinish }) {
  let st = null;
  let renderTimer = null;

  // ---------- building the list ----------
  function items() {
    const out = [];
    let cur = null;
    st.pages.forEach((p, i) => {
      if (st.skipped.has(i)) return;
      if (cur && st.joins[i]) cur.pages.push(i);
      else { cur = { key: 'p' + i, pages: [i] }; out.push(cur); }
    });
    st.drafts.forEach((d, i) => out.push({ key: 'd' + i, draft: d }));
    return out;
  }

  const draftCache = new Map();
  function draftFor(item) {
    if (item.draft) return item.draft;
    const sig = item.pages.join(',') + ':' + item.pages.map(i => st.pages[i].status).join(',');
    const cached = draftCache.get(item.key);
    if (cached?.sig === sig) return cached.d;
    const text = item.pages.map(i => st.pages[i].text || '').join('\n\n');
    const d = parseRecipeText(text);
    d.rawText = text;
    const pageLabel = item.pages.length > 1 ? `pages ${item.pages[0] + 1}–${item.pages.at(-1) + 1}` : `page ${item.pages[0] + 1}`;
    d.source = { type: 'scan', name: `${st.label}, ${pageLabel}` };
    d.pageLabel = pageLabel;
    draftCache.set(item.key, { sig, d });
    return d;
  }
  const titleFor = (item, d) => st.titles[item.key] ?? (d.title === 'Untitled recipe' ? '' : d.title);
  const itemReady = (item) => !item.pages || item.pages.every(i => ['done', 'error'].includes(st.pages[i].status));

  // ---------- rendering ----------
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 300);
  }

  function progressHtml(all) {
    if (!st.pages.length) return '';
    const reading = st.processed < st.pages.length;
    const pct = Math.round(100 * st.processed / st.pages.length);
    return `<div class="bar"><span style="width:${pct}%"></span></div>
      <p class="muted small">${reading
        ? `Reading page ${Math.min(st.processed + 1, st.pages.length)} of ${st.pages.length} (${ocrWorkerCount()} at a time). Keep this tab open; you can check titles as they appear.`
        : `Read ${st.pages.length} page${st.pages.length === 1 ? '' : 's'} → ${all.filter(it => it.pages).length} recipe${all.filter(it => it.pages).length === 1 ? '' : 's'}${st.skipped.size ? ` (${st.skipped.size} blank page${st.skipped.size === 1 ? '' : 's'} skipped)` : ''}.`}</p>`;
  }

  function render() {
    if (!st) { root.hidden = true; root.innerHTML = ''; return; }
    const all = items();
    // Don't rebuild the list under someone typing a title; just update the progress bar
    const typing = root.contains(document.activeElement) && document.activeElement.dataset.bulk === 'title';
    if (typing) { const p = root.querySelector('[data-progress]'); if (p) p.innerHTML = progressHtml(all); return; }

    const toSave = all.filter(it => !st.excluded.has(it.key) && !st.saved.has(it.key) && itemReady(it));
    const reading = st.processed < st.pages.length;
    root.hidden = false;
    root.innerHTML = `
      <div class="editor-head">
        <h1>Bulk import <span class="count">${esc(st.label)}</span></h1>
        <div class="row wrap">
          <button class="btn ghost" data-bulk="cancel">${st.saved.size ? 'Done' : 'Cancel'}</button>
          <button class="btn primary" data-bulk="save-all" ${reading || !toSave.length ? 'disabled' : ''}>Save ${toSave.length} recipe${toSave.length === 1 ? '' : 's'}</button>
        </div>
      </div>
      <div class="bulk-progress" data-progress>${progressHtml(all)}</div>
      <p class="method-note">Check the titles, untick anything that isn't a recipe, then <strong>Save</strong>. Recipes marked <strong>⚠ check</strong> look incomplete. They're saved with a "needs review" flag so you can fix them later (Recipes → "Needs review"), or use <strong>Review</strong> to fix one now.${st.pages.length > 1 ? ' Pages that continue a recipe are joined automatically; use <strong>⤴ Join with previous</strong> or <strong>✂</strong> to fix.' : ''}</p>
      <div class="bulk-list">${all.length ? all.map((it, n) => itemHtml(it, n, all[n - 1])).join('') : '<p class="muted">Nothing to import.</p>'}</div>`;
  }

  function itemHtml(it, n, prev) {
    const ready = itemReady(it);
    const d = ready ? draftFor(it) : null;
    const title = d ? titleFor(it, d) : '';
    const saved = st.saved.has(it.key);
    const excluded = st.excluded.has(it.key);
    const weak = d && isWeak(d, title);
    const thumbs = it.pages
      ? it.pages.map((i, k) => `<div class="bulk-thumb">${st.pages[i].thumb ? `<img src="${st.pages[i].thumb}" alt="Page ${i + 1}">` : '<span>…</span>'}${k > 0 && !saved ? `<button class="split" data-bulk="split" data-page="${i}" title="Start a new recipe at page ${i + 1}">✂</button>` : ''}<small>p${i + 1}</small></div>`).join('')
      : '<div class="bulk-thumb doc">📄</div>';
    const status = !ready
      ? `<span class="muted small">${it.pages.some(i => st.pages[i].status === 'reading') ? 'Reading…' : 'Waiting…'}</span>`
      : `<span class="muted small">${d.ingredients.length} ingredient${d.ingredients.length === 1 ? '' : 's'} · ${d.steps.length} step${d.steps.length === 1 ? '' : 's'}${d.pageLabel ? ' · ' + d.pageLabel : ''}</span>
         ${it.pages?.some(i => st.pages[i].status === 'error') ? '<span class="badge warn">couldn\'t read a page</span>' : weak ? '<span class="badge warn">⚠ check</span>' : ''}`;
    return `<div class="bulk-item card ${saved ? 'saved' : ''} ${excluded ? 'excluded' : ''}" data-key="${it.key}">
      <label class="bulk-inc" title="Include">${saved ? '✅' : `<input type="checkbox" data-bulk="include" ${excluded ? '' : 'checked'} ${ready ? '' : 'disabled'}>`}</label>
      <div class="bulk-thumbs">${thumbs}</div>
      <div class="bulk-main">
        ${saved ? `<strong>${esc(store.getRecipe(st.saved.get(it.key))?.title || title)}</strong> <span class="muted small">saved</span>`
          : `<input class="bulk-title" data-bulk="title" value="${esc(title)}" placeholder="${ready ? 'Recipe title' : ''}" ${ready ? '' : 'disabled'} aria-label="Recipe title">`}
        <div class="bulk-meta">${status}</div>
      </div>
      <div class="bulk-actions">
        ${it.pages && prev?.pages && !saved ? `<button class="btn small ghost" data-bulk="join" title="This page continues the recipe above">⤴ Join with previous</button>` : ''}
        ${!saved && ready ? `<button class="btn small" data-bulk="review">Review</button>` : ''}
      </div>
    </div>`;
  }

  // ---------- actions ----------
  root.addEventListener('input', e => {
    if (!st || e.target.dataset.bulk !== 'title') return;
    st.titles[e.target.closest('[data-key]').dataset.key] = e.target.value;
  });
  root.addEventListener('change', e => {
    if (!st || e.target.dataset.bulk !== 'include') return;
    const key = e.target.closest('[data-key]').dataset.key;
    if (e.target.checked) st.excluded.delete(key); else st.excluded.add(key);
    render();
  });
  root.addEventListener('click', async e => {
    const btn = e.target.closest('[data-bulk]');
    if (!st || !btn || btn.tagName === 'INPUT') return;
    const act = btn.dataset.bulk;
    const key = btn.closest('[data-key]')?.dataset.key;
    const item = key && items().find(it => it.key === key);
    if (act === 'join' && item?.pages) { st.joins[item.pages[0]] = true; st.touched.add(item.pages[0]); render(); }
    if (act === 'split') { const p = +btn.dataset.page; st.joins[p] = false; st.touched.add(p); render(); }
    if (act === 'review' && item) {
      const d = { ...draftFor(item), title: titleFor(item, draftFor(item)) };
      if (item.pages) d.scanImages = await Promise.all(item.pages.map(i => st.pages[i].bigImage?.() || st.pages[i].thumb));
      onReview(d, (saved) => { st.saved.set(key, saved.id); render(); });
    }
    if (act === 'save-all') saveAll();
    if (act === 'cancel') {
      if (st.processed < st.pages.length && !confirm('Stop reading and discard the pages not saved yet?')) return;
      finish();
    }
  });

  function toRecipe(item) {
    const d = draftFor(item);
    const title = titleFor(item, d).trim() || `Untitled (${d.pageLabel || 'import'})`;
    const auto = categorize({ ...d, title, ingredients: d.ingredients });
    return {
      title,
      mealTypes: d.mealTypes?.length ? d.mealTypes : auto.mealTypes,
      proteins: d.proteins ?? auto.proteins,
      tags: d.tags?.length ? d.tags : auto.tags,
      servings: d.servings || null,
      totalTime: d.totalTime || null,
      sourceUrl: d.sourceUrl || '',
      image: d.image || '',
      ingredients: parseIngredients(d.ingredients),
      steps: d.steps,
      notes: d.notes || '',
      rawText: d.rawText,
      source: d.source,
      needsReview: isWeak(d, titleFor(item, d)) || undefined,
    };
  }

  function saveAll() {
    const todo = items().filter(it => !st.excluded.has(it.key) && !st.saved.has(it.key) && itemReady(it));
    let n = 0;
    for (const it of todo) {
      const saved = store.saveRecipe(toRecipe(it));
      st.saved.set(it.key, saved.id);
      n++;
    }
    const flagged = todo.filter(it => isWeak(draftFor(it), titleFor(it, draftFor(it)))).length;
    toast(`Saved ${n} recipe${n === 1 ? '' : 's'}${flagged ? ` — ${flagged} marked "needs review"` : ''}`);
    finish(n);
  }

  function finish(savedNow = 0) {
    if (st) st.cancelled = true;
    const total = st ? st.saved.size : 0;
    st = null;
    render();
    onFinish(total || savedNow);
  }

  // ---------- reading pages ----------
  async function readAll() {
    const my = st;
    let next = 0;
    const worker = async () => {
      while (!my.cancelled && next < my.pages.length) {
        const i = next++;
        const p = my.pages[i];
        p.status = 'reading';
        scheduleRender();
        try {
          if (!p.thumb) p.thumb = await p.preview();
          p.text = await p.read();
          p.status = 'done';
          if (isBlankPage(p.text)) my.skipped.add(i);
          else if (i > 0 && !my.touched.has(i) && looksLikeContinuation(p.text)) my.joins[i] = true;
        } catch (err) {
          console.error(err);
          p.status = 'error';
          p.text = '';
        }
        my.processed++;
        if (st === my) scheduleRender();
      }
    };
    await Promise.all(Array.from({ length: ocrWorkerCount() }, worker));
    if (st === my) { render(); toast('Finished reading — check the list and save'); }
  }

  function begin(label) {
    st = { label, pages: [], drafts: [], joins: [], touched: new Set(), skipped: new Set(), titles: {}, excluded: new Set(), saved: new Map(), processed: 0, cancelled: false };
    draftCache.clear();
  }

  return {
    isActive: () => !!st,

    // PDFs (one page each) and photos (one per photo), in the order given
    async startFiles(files) {
      begin(files.length === 1 ? files[0].name : `${files.length} files`);
      render();
      for (const f of files) {
        if (isPdf(f)) {
          const pdf = await openPdf(f);
          for (let n = 1; n <= pdf.numPages; n++) {
            st.pages.push({ status: 'queued', preview: () => pdfPageImage(pdf, n, 180), bigImage: () => pdfPageImage(pdf, n, 900), read: () => pdfPageText(pdf, n) });
          }
        } else if (f.type.startsWith('image/')) {
          st.pages.push({ status: 'queued', preview: () => imagePreview(f, 180), bigImage: () => imagePreview(f, 900), read: () => imageText(f) });
        }
      }
      if (!st.pages.length) { toast('No PDFs or photos in that selection'); st = null; render(); return; }
      render();
      readAll();
    },

    // Already-structured drafts (CSV rows, pasted recipes)
    startDrafts(drafts, label) {
      begin(label);
      st.drafts = drafts;
      render();
    },
  };
}
