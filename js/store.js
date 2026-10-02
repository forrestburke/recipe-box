// Data layer. Everything lives in an in-memory cache, persisted to localStorage, and mirrored to
// Firestore when Firebase is configured and the user is signed in.
//
// Cloud model
//   Kitchen  (households/{hid})        one meal plan, shopping list and pantry. Members share all of it.
//   Family   (families/{fid})          a group of kitchens that pool their recipes.
//   Recipe   (families/{fid}/recipes)  tagged with the kitchen that added it; only that kitchen can edit it.
//
// Sync rules
//   - Local changes are queued in data.pending / data.stateDirty (kept in localStorage) until the cloud
//     confirms them, so nothing is lost if the app is closed while offline.
//   - The cloud copy of the plan/list wins unless this device has unsaved changes for that same kitchen.
//   - Our own writes echoing back are recognised and skipped; everyone else's changes are applied.
import { config } from './config.js';

const KEY = 'recipe-planner.v1';
// Last kitchen each person used in this browser (several people may share a browser)
const kitchenKey = () => 'recipe-planner.kitchen.' + (fbUser?.uid || '');

const DEFAULT_PANTRY = ['salt', 'black pepper', 'olive oil', 'vegetable oil', 'water', 'sugar', 'all-purpose flour'];

function defaultState() {
  return {
    plan: null,
    shopping: { overrides: {}, custom: [] },
    settings: {
      pantry: DEFAULT_PANTRY,
      filters: { excludeProteins: [], excludeTags: [], requireTags: [], excludeIngredients: '', kitchens: [] },
      avoidBackToBack: true,
      planMeals: ['dinner'],
      people: 4,
    },
  };
}
function defaults() {
  return {
    recipes: [],
    ...defaultState(),
    stateKitchen: undefined, // kitchen the plan/list/pantry belong to (undefined = this browser only)
    stateUpdatedAt: 0,
    stateDirty: false,       // plan/list/pantry changed here and not yet saved to the cloud
    pending: { up: [], del: [] }, // recipe ids saved/deleted here and not yet confirmed by the cloud
    updatedAt: 0,
  };
}

let data = defaults();
const listeners = new Set();
let cloud = null;       // set once connected to a kitchen, see connectKitchen()
let cloudError = '';
let cloudOffline = false;
let cloudReady = false; // false while Firebase is checking the sign-in or connecting
const notify = (changed) => listeners.forEach(fn => fn(changed));

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const d = defaults();
    data = { ...d, ...saved, settings: { ...d.settings, ...saved.settings } };
    if (!saved.pending) {
      // saved by an older version: recipes never tied to a kitchen still need uploading
      data.pending = { up: data.recipes.filter(r => !r.kitchen).map(r => r.id), del: [] };
      data.stateUpdatedAt = saved.updatedAt || 0;
    }
  } catch (e) { console.warn('Could not read saved data', e); }
}

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { alert('Could not save to this browser (storage full?). Export a backup from Settings.'); }
}

const mark = (list, id) => { if (!data.pending[list].includes(id)) data.pending[list].push(id); };
const unmark = (list, id) => { data.pending[list] = data.pending[list].filter(x => x !== id); };

function persist(changed) {
  if (changed.all || changed.plan || changed.shopping || changed.settings) {
    data.stateUpdatedAt = Date.now();
    data.stateDirty = true;
  }
  if (changed.recipe) { mark('up', changed.recipe.id); unmark('del', changed.recipe.id); }
  if (changed.deletedRecipe) { mark('del', changed.deletedRecipe); unmark('up', changed.deletedRecipe); }
  if (changed.all) data.recipes.filter(isMine).forEach(r => mark('up', r.id));
  data.updatedAt = Date.now();
  saveLocal();
  flush();
  notify(changed);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// The kitchen this device is working in: the connected one, or (while connecting / offline) the last one
const homeKitchen = () => cloud?.hid ?? (data.stateKitchen && data.stateKitchen !== 'switching' ? data.stateKitchen : null);
const isMine = (r) => !r?.kitchen || r.kitchen === homeKitchen();
const kitchenName = (id) => cloud?.kitchens?.[id] || (id === cloud?.hid ? cloud.kitchenName : '') || data.recipes.find(r => r.kitchen === id)?.kitchenName || 'another kitchen';

function assertMine(r) {
  if (r && !isMine(r)) throw new Error(`This recipe belongs to ${kitchenName(r.kitchen)}. Use "Copy to my kitchen" to make your own version.`);
}

export const store = {
  init() {
    load();
    if (config.firebase) initCloud().catch(e => { cloudError = e.message; cloudReady = true; notify({ cloud: true }); });
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  recipes() { return data.recipes; },
  recipeMap() { return new Map(data.recipes.map(r => [r.id, r])); },
  getRecipe(id) { return data.recipes.find(r => r.id === id); },
  isMine,
  kitchenName,
  saveRecipe(r) {
    const prev = data.recipes.find(x => x.id === r.id);
    assertMine(prev);
    r = { ...r, id: r.id || uid(), updatedAt: Date.now(), createdAt: prev?.createdAt || r.createdAt || Date.now() };
    // who added it (kept through edits) so it can show as "new" for everyone else
    if (prev?.addedBy) Object.assign(r, { addedBy: prev.addedBy, addedByName: prev.addedByName });
    else if (!prev && myEmail()) Object.assign(r, { addedBy: myEmail(), addedByName: myFirstName() });
    const home = homeKitchen();
    if (home) { r.kitchen = home; r.kitchenName = cloud?.kitchenName || r.kitchenName || kitchenName(home); }
    const i = data.recipes.findIndex(x => x.id === r.id);
    if (i === -1) data.recipes.push(r); else data.recipes[i] = r;
    persist({ recipe: r });
    return r;
  },
  deleteRecipe(id) {
    assertMine(data.recipes.find(x => x.id === id));
    data.recipes = data.recipes.filter(r => r.id !== id);
    persist({ deletedRecipe: id });
  },
  copyRecipe(id) {
    const src = data.recipes.find(r => r.id === id);
    if (!src) return null;
    const { id: _, kitchen, kitchenName: __, createdAt, updatedAt, addedBy, addedByName, ...rest } = src;
    return store.saveRecipe({ ...rest, copiedFrom: { id: src.id, kitchen: src.kitchen || null } });
  },

  get(key) { return data[key]; },
  set(key, value) { data[key] = value; persist({ [key]: true }); },
  settings() { return data.settings; },
  updateSettings(patch) { data.settings = { ...data.settings, ...patch }; persist({ settings: true }); },

  exportJSON() {
    const { pending, stateDirty, stateKitchen, ...rest } = data;
    return JSON.stringify({ app: 'recipe-planner', version: 2, ...rest, recipes: data.recipes.filter(isMine) }, null, 2);
  },
  importJSON(text, mode = 'merge') {
    const incoming = JSON.parse(text);
    if (!Array.isArray(incoming.recipes)) throw new Error('Not a recipe-planner backup file');
    const home = homeKitchen();
    const now = Date.now();
    // restored recipes become this kitchen's, stamped now so they are uploaded rather than taken for deletions
    const mine = incoming.recipes.map(r => ({ ...r, kitchen: home || undefined, kitchenName: home ? kitchenName(home) : undefined, updatedAt: now }));
    const byId = new Map((mode === 'replace' ? [] : data.recipes).map(r => [r.id, r]));
    for (const r of mine) if (isMine(byId.get(r.id))) byId.set(r.id, r);
    data.recipes = [...byId.values()];
    if (mode === 'replace') Object.assign(data, { plan: incoming.plan ?? null, shopping: incoming.shopping || data.shopping, settings: { ...data.settings, ...(incoming.settings || {}) } });
    mine.forEach(r => mark('up', r.id));
    persist({ all: true });
  },

  // Kitchens in the family, for filters: [{ id, name, mine }]
  kitchens() {
    if (!cloud) return [];
    const ids = new Set([...Object.keys(cloud.kitchens || {}), ...data.recipes.map(r => r.kitchen).filter(Boolean), cloud.hid]);
    return [...ids].map(id => ({ id, name: kitchenName(id), mine: id === cloud.hid }))
      .sort((a, b) => (b.mine - a.mine) || a.name.localeCompare(b.name));
  },
  currentKitchen() { return homeKitchen() || 'local'; },

  // "New" recipes: added by someone else in the last 30 days and not opened by you yet
  isNew,
  newRecipes() { return data.recipes.filter(isNew); },
  markSeen(id) { if (isNew(data.recipes.find(r => r.id === id))) { seen.add(id); saveSeen(); notify({ seen: true }); } },
  markAllSeen() { data.recipes.filter(isNew).forEach(r => seen.add(r.id)); saveSeen(); notify({ seen: true, all: true }); },

  cloudStatus() {
    if (!config.firebase) return null;
    if (!cloud) return { signedIn: false, loading: !cloudReady, error: cloudError, offline: cloudOffline, email: fbUser ? normEmail(fbUser.email) : '' };
    return {
      signedIn: true, loading: !cloudReady, error: cloudError, offline: cloudOffline,
      name: cloud.name, email: cloud.email, photo: cloud.photo,
      kitchenId: cloud.hid, kitchenName: cloud.kitchenName, members: cloud.members, isOwner: cloud.owner === cloud.uid,
      familyMembers: cloud.familyMembers || [], isFamilyAdmin: cloud.familyCreatedBy === cloud.uid, kitchens: store.kitchens(),
      myKitchens: cloud.myKitchens || [],
    };
  },
  signIn: () => cloudSignIn(),
  signOut: () => cloudSignOut(),
  addMember: (email) => updateKitchenMembers(email, 'add'),
  removeMember: (email) => updateKitchenMembers(email, 'remove'),
  addFamilyMember: (email) => updateFamilyMembers(email, 'add'),
  removeFamilyMember: (email) => updateFamilyMembers(email, 'remove'),
  renameKitchen: (name) => renameKitchen(name),
  switchKitchen: (hid) => switchKitchen(hid),
};

// ---------------- Firebase ----------------
const FB = 'https://www.gstatic.com/firebasejs/12.19.0/';
let fbAuth = null, fbMods = null, fbDb = null, fbUser = null, unsubscribers = [];
let connection = 0; // bumped whenever a new connect starts; older ones stop at their next step
const clean = (o) => JSON.parse(JSON.stringify(o)); // Firestore rejects undefined
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const STALE = Symbol('stale');
const isOfflineError = (e) => e?.code === 'unavailable' || /offline|network|unavailable/i.test(e?.message || '');

async function initCloud() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js'),
  ]);
  // Local testing against the Firebase emulators: http://localhost:5173/?emulator
  const emulator = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('emulator');
  const app = initializeApp(config.firebase, emulator ? 'emulator' : undefined);
  fbMods = { auth, fs };
  fbAuth = auth.getAuth(app);
  fbDb = fs.getFirestore(app);
  if (emulator) {
    auth.connectAuthEmulator(fbAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
    fs.connectFirestoreEmulator(fbDb, '127.0.0.1', 8080);
    // lets a test sign in as a pretend Google user without a popup
    window.__emulatorSignIn = (email, name) => auth.signInWithCredential(fbAuth,
      auth.GoogleAuthProvider.credential(JSON.stringify({ sub: 'test-' + email, email, email_verified: true, name })));
  }
  notify({ cloud: true }); // "connecting…" while Firebase checks the sign-in
  auth.getRedirectResult(fbAuth).catch(() => {});
  auth.onAuthStateChanged(fbAuth, (user) => connectUser(user));
  // came back online after failing to connect: try again
  window.addEventListener('online', () => { if (fbUser && !cloud) connectUser(fbUser); });
}

async function connectUser(user, preferredKitchen) {
  const my = ++connection;
  stopListening();
  cloud = null;
  cloudError = '';
  cloudOffline = false;
  fbUser = user;
  if (!user) { cloudReady = true; return notify({ cloud: true }); }
  cloudReady = false;
  notify({ cloud: true });
  try {
    const kitchens = await myKitchens(user);
    if (my !== connection) return;
    const want = preferredKitchen || localStorage.getItem(kitchenKey());
    await connectKitchen(kitchens.find(k => k.id === want) || kitchens[0], kitchens, my);
  } catch (e) {
    if (e === STALE || my !== connection) return;
    console.error(e);
    cloud = null;
    if (isOfflineError(e)) { cloudOffline = true; cloudError = ''; }
    else cloudError = 'Could not connect to your kitchen: ' + e.message;
  }
  if (my !== connection) return;
  cloudReady = true;
  notify({ all: true, cloud: true });
}

function stopListening() {
  unsubscribers.forEach(u => u());
  unsubscribers = [];
}

// Kitchens this person belongs to. Creates one ("Forrest's kitchen") on first sign-in, but only once
// the server itself confirms there's none (a cached empty answer while offline must never create one).
async function myKitchens(user) {
  const { fs } = fbMods;
  const email = normEmail(user.email);
  const snap = await fs.getDocsFromServer(fs.query(fs.collection(fbDb, 'households'), fs.where('members', 'array-contains', email)));
  let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!list.length) {
    const ref = fs.doc(fbDb, 'households', user.uid);
    let exists = false;
    try { exists = (await fs.getDocFromServer(ref)).exists(); }
    catch (e) { if (e.code === 'permission-denied') throw new Error('Your kitchen exists but you are no longer a member of it. Ask a family member to add you back.'); throw e; }
    if (exists) throw new Error('Your kitchen could not be loaded. Please try again.');
    const first = (user.displayName || email).split(/[\s@]/)[0];
    const hh = { owner: user.uid, members: [email], name: `${first}'s kitchen`, createdAt: Date.now() };
    await fs.setDoc(ref, hh);
    list = [{ id: user.uid, ...hh }];
  }
  // Default: a kitchen shared with others (e.g. the one your partner invited you to), then your own
  const shared = k => (k.members.length > 1 ? 1 : 0);
  return list.sort((a, b) => (shared(b) - shared(a)) || ((b.owner === user.uid) - (a.owner === user.uid)) || (b.members.length - a.members.length));
}

async function switchKitchen(hid) {
  if (!cloud || hid === cloud.hid) return;
  const previous = cloud.hid;
  // save this kitchen's pending changes first (don't wait forever if offline)
  await Promise.race([flushing, new Promise(r => setTimeout(r, 4000))]);
  // The other kitchen has its own plan, list and pantry: start from its cloud copy
  Object.assign(data, defaultState(), { stateKitchen: 'switching', stateUpdatedAt: 0, stateDirty: false });
  saveLocal();
  await connectUser(fbUser, hid);
  if (!cloud || cloud.hid !== hid) {
    const err = cloudError || 'Could not open that kitchen.';
    await connectUser(fbUser, previous); // go back to where we were
    throw new Error(err);
  }
}

async function connectKitchen(hh, allKitchens, my) {
  const { fs } = fbMods;
  const live = () => { if (my !== connection) throw STALE; };
  const email = normEmail(fbUser.email);
  const name = hh.name || `${(fbUser.displayName || email).split(/[\s@]/)[0]}'s kitchen`;
  const hhRef = fs.doc(fbDb, 'households', hh.id);
  const legacy = !hh.family; // created before families existed: recipes still live under the kitchen

  const fam = await resolveFamily(hh, email, name);
  live();
  const c = {
    uid: fbUser.uid, email, name: fbUser.displayName || fbUser.email, photo: fbUser.photoURL || '',
    hid: hh.id, kitchenName: name, members: hh.members, owner: hh.owner,
    fid: fam.id, familyMembers: fam.members, familyCreatedBy: fam.createdBy, kitchens: { ...(fam.kitchens || {}), [hh.id]: name },
    myKitchens: allKitchens.map(k => ({ id: k.id, name: k.id === hh.id ? name : (k.name || 'Kitchen') })),
  };

  // Keep the kitchen and family pointing at each other, and every kitchen member in the family
  const famRef = fs.doc(fbDb, 'families', fam.id);
  const famPatch = {};
  if (fam.kitchens?.[hh.id] !== name) famPatch[`kitchens.${hh.id}`] = name;
  const missing = hh.members.filter(m => !fam.members.includes(m));
  if (missing.length) famPatch.members = fs.arrayUnion(...missing);
  if (Object.keys(famPatch).length) await fs.updateDoc(famRef, famPatch);
  if (hh.family !== fam.id || !hh.name) await fs.updateDoc(hhRef, { family: fam.id, name });
  live();

  // Move recipes into the family library
  if (legacy) await copyRecipes(fs.collection(fbDb, 'households', hh.id, 'recipes'), fam.id, hh.id, name);
  if (hh.family && hh.family !== fam.id) {
    // joined a bigger family: bring this kitchen's recipes along from the old one
    const old = fs.query(fs.collection(fbDb, 'families', hh.family, 'recipes'), fs.where('kitchen', '==', hh.id));
    await copyRecipes(old, fam.id, hh.id, name).catch(e => console.warn('Could not copy from old family', e));
  }
  live();

  await syncRecipes(c);
  live();
  await syncState(c);
  live();
  await syncSeen(c);
  live();
  cloud = c;
  localStorage.setItem(kitchenKey(), hh.id);
  saveLocal();
  listenForChanges(c);
  flush();
}

// The family this kitchen uses. A kitchen stays in its family if that family is actually shared;
// a kitchen whose family is just itself joins a family it has been invited to (the largest one).
async function resolveFamily(hh, email, name) {
  const { fs } = fbMods;
  const snap = await fs.getDocsFromServer(fs.query(fs.collection(fbDb, 'families'), fs.where('members', 'array-contains', email)));
  const fams = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const current = fams.find(f => f.id === hh.family);
  const shared = (f) => Object.keys(f.kitchens || {}).some(k => k !== hh.id) || f.members.some(m => !hh.members.includes(m));
  if (current && shared(current)) return current;
  const best = fams.sort((a, b) => (b.members.length - a.members.length) || ((b.id === hh.family) - (a.id === hh.family)) || a.id.localeCompare(b.id))[0];
  if (best) return best;
  // Create one (id = your user id, or your id plus a number if that one exists but isn't yours any more)
  const fam = { members: [...new Set([email, ...hh.members])], kitchens: { [hh.id]: name }, createdBy: fbUser.uid, createdAt: Date.now() };
  for (let n = 0; n < 5; n++) {
    const id = n ? `${fbUser.uid}-${n}` : fbUser.uid;
    const ref = fs.doc(fbDb, 'families', id);
    try { if ((await fs.getDocFromServer(ref)).exists()) continue; }
    catch (e) { if (e.code === 'permission-denied') continue; throw e; }
    await fs.setDoc(ref, fam);
    return { id, ...fam };
  }
  throw new Error('Could not set up your family library.');
}

async function copyRecipes(sourceQuery, fid, hid, name) {
  const { fs } = fbMods;
  const snap = await fs.getDocs(sourceQuery);
  for (const d of snap.docs) {
    const target = fs.doc(fbDb, 'families', fid, 'recipes', d.id);
    if ((await fs.getDoc(target)).exists()) continue;
    await fs.setDoc(target, clean({ ...d.data(), id: d.id, kitchen: hid, kitchenName: name }));
  }
}

const recipesCol = (c) => fbMods.fs.collection(fbDb, 'families', c.fid, 'recipes');
const recipeDoc = (c, id) => fbMods.fs.doc(fbDb, 'families', c.fid, 'recipes', id);
const stateDoc = (c) => fbMods.fs.doc(fbDb, 'households', c.hid, 'meta', 'state');
const seenDoc = (c) => fbMods.fs.doc(fbDb, 'households', c.hid, 'seen', c.uid);

// ---------- "New" recipes ----------
// Each person's opened-recipe list is kept in this browser and in households/{hid}/seen/{uid},
// so a recipe opened on the computer isn't "new" again on the phone.
const NEW_DAYS = 30;
let seen = new Set();
let seenTimer = null;
const seenKey = () => 'recipe-planner.seen.' + (fbUser?.uid || '');
const myEmail = () => cloud?.email || (fbUser ? normEmail(fbUser.email) : '');
const myFirstName = () => String(fbUser?.displayName || fbUser?.email || '').split(/[\s@]/)[0];

function isNew(r) {
  if (!r?.addedBy || !fbUser || r.addedBy === myEmail()) return false;
  if ((r.createdAt || 0) < Date.now() - NEW_DAYS * 864e5) return false;
  return !seen.has(r.id);
}

function saveSeen() {
  if (cloud) {
    // forget recipes that are too old to be "new" anyway, so the list stays small
    const cutoff = Date.now() - (NEW_DAYS + 15) * 864e5;
    seen = new Set([...seen].filter(id => (data.recipes.find(r => r.id === id)?.createdAt || 0) >= cutoff));
  }
  const ids = [...seen];
  try { localStorage.setItem(seenKey(), JSON.stringify(ids)); } catch {}
  clearTimeout(seenTimer);
  const c = cloud;
  seenTimer = setTimeout(() => { if (c && cloud === c) fbMods.fs.setDoc(seenDoc(c), { ids, updatedAt: Date.now() }).catch(() => {}); }, 1500);
}

async function syncSeen(c) {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(seenKey()) || 'null'); } catch {}
  let remote = null;
  try { const snap = await fbMods.fs.getDoc(seenDoc(c)); if (snap.exists()) remote = snap.data().ids || []; } catch {}
  seen = new Set([...(local || []), ...(remote || [])]);
  // First time for this person: what's already in the library isn't "new" to them
  if (!local && !remote) data.recipes.forEach(r => seen.add(r.id));
  try { localStorage.setItem(seenKey(), JSON.stringify([...seen])); } catch {}
  if (!remote || (local && local.some(id => !remote.includes(id)))) fbMods.fs.setDoc(seenDoc(c), { ids: [...seen], updatedAt: Date.now() }).catch(() => {});
}

// Merge with the family library: the cloud copy wins, except for changes made on this device that
// haven't been confirmed yet (data.pending), which are kept and uploaded by flush()
async function syncRecipes(c) {
  const { fs } = fbMods;
  const remote = (await fs.getDocsFromServer(recipesCol(c))).docs.map(d => ({ ...d.data(), id: d.id }));
  const byId = new Map(remote.map(r => [r.id, r]));
  for (const r of data.recipes) {
    if (!data.pending.up.includes(r.id)) continue;
    const other = byId.get(r.id);
    if ((r.kitchen && r.kitchen !== c.hid) || (other && other.kitchen && other.kitchen !== c.hid)) { unmark('up', r.id); continue; } // not ours to change
    byId.set(r.id, { ...r, kitchen: c.hid, kitchenName: c.kitchenName });
  }
  for (const id of data.pending.del) {
    const other = byId.get(id);
    if (other && other.kitchen && other.kitchen !== c.hid) { unmark('del', id); continue; }
    byId.delete(id);
  }
  data.recipes = [...byId.values()];
}

// Plan, list and pantry: the cloud copy wins unless this device has unsaved changes for this kitchen
async function syncState(c) {
  const { fs } = fbMods;
  const snap = await fs.getDocFromServer(stateDoc(c));
  const s = snap.exists() ? snap.data() : null;
  const localForThisKitchen = data.stateKitchen === c.hid;
  const unclaimed = data.stateKitchen === undefined; // this browser before first sign-in
  if (s && !(localForThisKitchen && data.stateDirty)) { applyState(s); data.stateDirty = false; }
  else if (!s) {
    if (!localForThisKitchen && !unclaimed) Object.assign(data, defaultState()); // new kitchen: start fresh
    data.stateDirty = true; // nothing in the cloud yet: save ours
  }
  data.stateKitchen = c.hid;
}

function applyState(s) {
  const d = defaultState();
  Object.assign(data, {
    plan: s.plan ?? null,
    shopping: s.shopping || d.shopping,
    settings: { ...d.settings, ...(s.settings || {}) },
    stateUpdatedAt: s.stateUpdatedAt ?? s.updatedAt ?? 0,
  });
}

const ourStamps = new Set(); // plan/list versions this device wrote, so their echoes are ignored

// Live updates from the rest of the kitchen / family
function listenForChanges(c) {
  const { fs } = fbMods;
  const onError = (e) => { cloudError = 'Live sync stopped: ' + e.message; notify({ cloud: true }); };
  const current = () => cloud === c;

  unsubscribers.push(fs.onSnapshot(recipesCol(c), snap => {
    if (!current()) return;
    let changed = false;
    const arrived = []; // recipes someone else just added
    for (const ch of snap.docChanges()) {
      if (ch.doc.metadata.hasPendingWrites) continue; // our own write
      const id = ch.doc.id;
      if (data.pending.up.includes(id) || data.pending.del.includes(id)) continue; // our unsaved change wins
      const r = { ...ch.doc.data(), id };
      const i = data.recipes.findIndex(x => x.id === id);
      if (ch.type === 'removed') { if (i !== -1) { data.recipes.splice(i, 1); changed = true; } }
      else if (i === -1) { data.recipes.push(r); changed = true; if (isNew(r)) arrived.push(r); }
      else if (JSON.stringify(data.recipes[i]) !== JSON.stringify(r)) { data.recipes[i] = r; changed = true; }
    }
    if (changed) {
      saveLocal();
      notify({ all: true, remote: true, ...(arrived.length ? { newRecipes: arrived } : {}) });
    }
  }, onError));

  unsubscribers.push(fs.onSnapshot(stateDoc(c), snap => {
    if (!current() || !snap.exists() || snap.metadata.hasPendingWrites) return;
    const s = snap.data();
    const stamp = s.stateUpdatedAt ?? s.updatedAt;
    if (ourStamps.has(stamp) || data.stateDirty) return; // our own save echoing back, or ours is about to replace it
    applyState(s);
    saveLocal();
    notify({ all: true, remote: true });
  }, onError));

  unsubscribers.push(fs.onSnapshot(fs.doc(fbDb, 'households', c.hid), snap => {
    if (!current() || !snap.exists()) return;
    const h = snap.data();
    c.members = h.members;
    if (h.name) c.kitchenName = h.name;
    notify({ cloud: true });
  }, onError));

  unsubscribers.push(fs.onSnapshot(fs.doc(fbDb, 'families', c.fid), snap => {
    if (!current() || !snap.exists()) return;
    const f = snap.data();
    c.familyMembers = f.members;
    c.familyCreatedBy = f.createdBy;
    c.kitchens = { ...(f.kitchens || {}), [c.hid]: c.kitchenName };
    notify({ cloud: true, all: true });
  }, onError));
}

// Upload everything waiting in data.pending / stateDirty, one batch at a time
let flushing = Promise.resolve();
function flush() {
  flushing = flushing.then(doFlush).catch(e => {
    console.warn('Cloud sync failed', e);
    if (isOfflineError(e)) cloudOffline = true;
    else cloudError = 'Sync failed: ' + e.message;
    notify({ cloud: true });
  });
  return flushing;
}

async function doFlush() {
  const c = cloud;
  if (!c) return;
  const { fs } = fbMods;
  for (const id of [...data.pending.up]) {
    const r = data.recipes.find(x => x.id === id);
    if (!r || (r.kitchen && r.kitchen !== c.hid)) { unmark('up', id); continue; }
    const version = r.updatedAt;
    await fs.setDoc(recipeDoc(c, id), clean({ ...r, kitchen: c.hid, kitchenName: c.kitchenName }));
    if (cloud !== c) return;
    if (data.recipes.find(x => x.id === id)?.updatedAt === version) unmark('up', id); // unless edited again meanwhile
    saveLocal();
  }
  for (const id of [...data.pending.del]) {
    await fs.deleteDoc(recipeDoc(c, id));
    if (cloud !== c) return;
    unmark('del', id);
    saveLocal();
  }
  if (data.stateDirty && data.stateKitchen === c.hid) {
    const stamp = data.stateUpdatedAt || Date.now();
    ourStamps.add(stamp);
    await fs.setDoc(stateDoc(c), clean({ plan: data.plan, shopping: data.shopping, settings: data.settings, stateUpdatedAt: stamp, updatedAt: stamp }));
    if (cloud !== c) return;
    if (data.stateUpdatedAt === stamp) data.stateDirty = false;
    saveLocal();
  }
  if (cloudOffline || cloudError.startsWith('Sync failed')) { cloudOffline = false; cloudError = ''; notify({ cloud: true }); }
}

function checkEmail(email) {
  if (!cloud) throw new Error('Sign in first');
  const e = normEmail(email);
  if (!validEmail(e)) throw new Error('Enter a valid email address');
  return e;
}

// Kitchen members share the meal plan and shopping list (and are also in the family).
// Anyone in the kitchen can add people; only the kitchen's owner can remove them.
async function updateKitchenMembers(email, action) {
  const e = checkEmail(email);
  if (action === 'remove' && e === cloud.email) throw new Error("You can't remove yourself");
  if (action === 'remove' && cloud.owner !== cloud.uid) throw new Error('Only the person who set up this kitchen can remove people.');
  const { fs } = fbMods;
  if (action === 'add') await fs.updateDoc(fs.doc(fbDb, 'families', cloud.fid), { members: fs.arrayUnion(e) });
  await fs.updateDoc(fs.doc(fbDb, 'households', cloud.hid), { members: action === 'add' ? fs.arrayUnion(e) : fs.arrayRemove(e) });
}

// Family members see everyone's recipes but get their own kitchen.
// Anyone in the family can invite; only the person who set up the family can remove people.
async function updateFamilyMembers(email, action) {
  const e = checkEmail(email);
  if (action === 'remove') {
    if (cloud.members.includes(e)) throw new Error(`${e} shares your kitchen. Remove them from your kitchen first.`);
    if (cloud.familyCreatedBy !== cloud.uid) throw new Error('Only the person who set up the family can remove people from it.');
  }
  const { fs } = fbMods;
  await fs.updateDoc(fs.doc(fbDb, 'families', cloud.fid), { members: action === 'add' ? fs.arrayUnion(e) : fs.arrayRemove(e) });
}

async function renameKitchen(name) {
  if (!cloud) throw new Error('Sign in first');
  const n = String(name || '').trim().slice(0, 40);
  if (!n) throw new Error('Enter a name');
  const { fs } = fbMods;
  await fs.updateDoc(fs.doc(fbDb, 'households', cloud.hid), { name: n });
  await fs.updateDoc(fs.doc(fbDb, 'families', cloud.fid), { [`kitchens.${cloud.hid}`]: n });
  cloud.kitchenName = n;
  cloud.kitchens[cloud.hid] = n;
  const k = cloud.myKitchens.find(k => k.id === cloud.hid);
  if (k) k.name = n;
  notify({ cloud: true, all: true });
}

async function cloudSignIn() {
  if (!fbAuth) throw new Error('Cloud sync is still loading — try again in a moment');
  const provider = new fbMods.auth.GoogleAuthProvider();
  try { await fbMods.auth.signInWithPopup(fbAuth, provider); }
  catch (e) {
    // Some phones block popups: fall back to a full-page redirect
    if (/popup-blocked|operation-not-supported|popup-closed-by-browser/.test(e.code || '')) await fbMods.auth.signInWithRedirect(fbAuth, provider);
    else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') throw e;
  }
}

async function cloudSignOut() {
  if (!fbAuth) return;
  // give unsaved changes a moment to reach the cloud (don't hang if offline)
  await Promise.race([flushing, new Promise(r => setTimeout(r, 4000))]);
  connection++; // stop any connect still in progress
  stopListening();
  cloud = null;
  await fbMods.auth.signOut(fbAuth);
  // Nothing of this person's is left behind for the next person using this browser
  data = defaults();
  seen = new Set();
  saveLocal();
  notify({ all: true, cloud: true });
}
