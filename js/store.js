// Data layer. Everything lives in an in-memory cache, persisted to localStorage, and mirrored to
// Firestore when Firebase is configured and the user is signed in.
//
// Cloud model
//   Kitchen  (households/{hid})        one meal plan, shopping list and pantry. Members share all of it.
//   Family   (families/{fid})          a group of kitchens that pool their recipes.
//   Recipe   (families/{fid}/recipes)  tagged with the kitchen that added it; only that kitchen can edit it.
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
  // stateKitchen: which kitchen plan/shopping/settings belong to (undefined = this browser only)
  return { recipes: [], ...defaultState(), updatedAt: 0, stateKitchen: undefined };
}

let data = defaults();
const listeners = new Set();
let cloud = null;     // set while signed in, see connectKitchen()
let cloudError = '';
let cloudReady = false; // false until Firebase has told us whether someone is signed in
const notify = (changed) => listeners.forEach(fn => fn(changed));

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const d = defaults();
      data = { ...d, ...saved, settings: { ...d.settings, ...saved.settings } };
    }
  } catch (e) { console.warn('Could not read saved data', e); }
}

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { alert('Could not save to this browser (storage full?). Export a backup from Settings.'); }
}

function persist(changed) {
  data.updatedAt = Date.now();
  saveLocal();
  if (cloud) pushCloud(changed).catch(e => { console.warn('Cloud sync failed', e); cloudError = 'Sync failed: ' + e.message; notify({ cloud: true }); });
  notify(changed);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const isMine = (r) => !cloud || !r?.kitchen || r.kitchen === cloud.hid;
const kitchenName = (id) => cloud?.kitchens?.[id] || (id === cloud?.hid ? cloud.kitchenName : '') || 'another kitchen';

function assertMine(r) {
  if (r && !isMine(r)) throw new Error(`This recipe belongs to ${kitchenName(r.kitchen)}. Use "Copy to my kitchen" to make your own version.`);
}

export const store = {
  init() { load(); if (config.firebase) initCloud().catch(e => { cloudError = e.message; cloudReady = true; notify({ cloud: true }); }); },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  recipes() { return data.recipes; },
  recipeMap() { return new Map(data.recipes.map(r => [r.id, r])); },
  getRecipe(id) { return data.recipes.find(r => r.id === id); },
  isMine,
  kitchenName,
  saveRecipe(r) {
    assertMine(data.recipes.find(x => x.id === r.id));
    r = { ...r, id: r.id || uid(), updatedAt: Date.now(), createdAt: r.createdAt || Date.now() };
    if (cloud) { r.kitchen = cloud.hid; r.kitchenName = cloud.kitchenName; }
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
    const { id: _, kitchen, kitchenName: __, createdAt, updatedAt, ...rest } = src;
    return store.saveRecipe({ ...rest, copiedFrom: { id: src.id, kitchen: src.kitchen || null } });
  },

  get(key) { return data[key]; },
  set(key, value) { data[key] = value; persist({ [key]: true }); },
  settings() { return data.settings; },
  updateSettings(patch) { data.settings = { ...data.settings, ...patch }; persist({ settings: true }); },

  exportJSON() { return JSON.stringify({ app: 'recipe-planner', version: 2, ...data, recipes: data.recipes.filter(isMine) }, null, 2); },
  importJSON(text, mode = 'merge') {
    const incoming = JSON.parse(text);
    if (!Array.isArray(incoming.recipes)) throw new Error('Not a recipe-planner backup file');
    const mine = incoming.recipes.map(r => cloud ? { ...r, kitchen: cloud.hid, kitchenName: cloud.kitchenName } : r);
    if (mode === 'replace') data = { ...defaults(), ...incoming, recipes: mine };
    else {
      const byId = new Map(data.recipes.map(r => [r.id, r]));
      for (const r of mine) if (isMine(byId.get(r.id))) byId.set(r.id, r);
      data.recipes = [...byId.values()];
    }
    persist({ all: true });
  },

  // Kitchens in the family, for filters: [{ id, name, mine }]
  kitchens() {
    if (!cloud) return [];
    const ids = new Set([...Object.keys(cloud.kitchens || {}), ...data.recipes.map(r => r.kitchen).filter(Boolean), cloud.hid]);
    return [...ids].map(id => ({ id, name: kitchenName(id), mine: id === cloud.hid }))
      .sort((a, b) => (b.mine - a.mine) || a.name.localeCompare(b.name));
  },
  currentKitchen() { return cloud ? cloud.hid : 'local'; },

  cloudStatus() {
    if (!config.firebase) return null;
    if (!cloud) return { signedIn: false, loading: !cloudReady, error: cloudError };
    return {
      signedIn: true, loading: !cloudReady, error: cloudError,
      name: cloud.name, email: cloud.email, photo: cloud.photo,
      kitchenId: cloud.hid, kitchenName: cloud.kitchenName, members: cloud.members, isOwner: cloud.owner === cloud.uid,
      familyMembers: cloud.familyMembers || [], kitchens: store.kitchens(),
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
const clean = (o) => JSON.parse(JSON.stringify(o)); // Firestore rejects undefined
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

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
  auth.onAuthStateChanged(fbAuth, async (user) => {
    stopListening();
    cloud = null;
    cloudError = '';
    fbUser = user;
    if (!user) { cloudReady = true; return notify({ cloud: true }); }
    cloudReady = false;
    notify({ cloud: true });
    try {
      const kitchens = await myKitchens(user);
      const saved = localStorage.getItem(kitchenKey());
      await connectKitchen(kitchens.find(k => k.id === saved) || kitchens[0], kitchens);
    } catch (e) {
      console.error(e);
      cloud = null;
      cloudError = 'Could not connect to your kitchen: ' + e.message;
    }
    cloudReady = true;
    notify({ all: true, cloud: true });
  });
}

function stopListening() {
  unsubscribers.forEach(u => u());
  unsubscribers = [];
}

// Kitchens this person belongs to. Creates one ("Forrest's kitchen") on first sign-in.
async function myKitchens(user) {
  const { fs } = fbMods;
  const email = normEmail(user.email);
  const snap = await fs.getDocs(fs.query(fs.collection(fbDb, 'households'), fs.where('members', 'array-contains', email)));
  let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!list.length) {
    const first = (user.displayName || email).split(/[\s@]/)[0];
    const hh = { owner: user.uid, members: [email], name: `${first}'s kitchen`, createdAt: Date.now() };
    await fs.setDoc(fs.doc(fbDb, 'households', user.uid), hh);
    list = [{ id: user.uid, ...hh }];
  }
  // Default: a kitchen shared with others (e.g. the one your partner invited you to), then your own
  const shared = k => (k.members.length > 1 ? 1 : 0);
  return list.sort((a, b) => (shared(b) - shared(a)) || ((b.owner === user.uid) - (a.owner === user.uid)) || (b.members.length - a.members.length));
}

async function switchKitchen(hid) {
  if (!cloud || hid === cloud.hid) return;
  const kitchens = await myKitchens(fbUser); // fresh, complete kitchen records
  const target = kitchens.find(k => k.id === hid);
  if (!target) throw new Error('Kitchen not found');
  localStorage.setItem(kitchenKey(), hid);
  stopListening();
  // The other kitchen has its own plan, list and pantry: start from its cloud copy
  Object.assign(data, defaultState(), { stateKitchen: 'switching', updatedAt: 0 });
  cloud = null;
  cloudReady = false;
  notify({ all: true, cloud: true });
  try { await connectKitchen(target, kitchens); }
  catch (e) { cloudError = 'Could not open that kitchen: ' + e.message; }
  cloudReady = true;
  notify({ all: true, cloud: true });
}

async function connectKitchen(hh, allKitchens) {
  const { fs } = fbMods;
  const email = normEmail(fbUser.email);
  const name = hh.name || `${(fbUser.displayName || email).split(/[\s@]/)[0]}'s kitchen`;
  const hhRef = fs.doc(fbDb, 'households', hh.id);
  const legacy = !hh.family; // created before families existed: recipes still live under the kitchen

  const fam = await resolveFamily(hh, email, name);
  cloud = {
    uid: fbUser.uid, email, name: fbUser.displayName || fbUser.email, photo: fbUser.photoURL || '',
    hid: hh.id, kitchenName: name, members: hh.members, owner: hh.owner,
    fid: fam.id, familyMembers: fam.members, kitchens: { ...(fam.kitchens || {}), [hh.id]: name },
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

  // Move recipes into the family library
  if (legacy) await copyRecipes(fs.collection(fbDb, 'households', hh.id, 'recipes'), fam.id, hh.id, name);
  if (hh.family && hh.family !== fam.id) {
    // joined a bigger family: bring this kitchen's recipes along from the old one
    const old = fs.query(fs.collection(fbDb, 'families', hh.family, 'recipes'), fs.where('kitchen', '==', hh.id));
    await copyRecipes(old, fam.id, hh.id, name).catch(e => console.warn('Could not copy from old family', e));
  }

  await syncRecipes();
  await syncState();
  localStorage.setItem(kitchenKey(), hh.id);
  listenForChanges();
}

// The family this kitchen uses: the largest one this person belongs to; creates one if needed
async function resolveFamily(hh, email, name) {
  const { fs } = fbMods;
  const snap = await fs.getDocs(fs.query(fs.collection(fbDb, 'families'), fs.where('members', 'array-contains', email)));
  const fams = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.members.length - a.members.length) || ((b.id === hh.family) - (a.id === hh.family)) || a.id.localeCompare(b.id));
  if (fams.length) return fams[0];
  const fam = { members: [...new Set([email, ...hh.members])], kitchens: { [hh.id]: name }, createdBy: fbUser.uid, createdAt: Date.now() };
  await fs.setDoc(fs.doc(fbDb, 'families', fbUser.uid), fam);
  return { id: fbUser.uid, ...fam };
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

const recipesCol = () => fbMods.fs.collection(fbDb, 'families', cloud.fid, 'recipes');
const recipeDoc = (id) => fbMods.fs.doc(fbDb, 'families', cloud.fid, 'recipes', id);
const stateDoc = () => fbMods.fs.doc(fbDb, 'households', cloud.hid, 'meta', 'state');

// Merge this browser's recipes with the family library
async function syncRecipes() {
  const { fs } = fbMods;
  const joinedKey = `recipe-planner.joined.${cloud.fid}.${cloud.hid}`;
  const legacyKey = `recipe-planner.joined.${cloud.hid}`;
  const lastSync = +localStorage.getItem(joinedKey) || +localStorage.getItem(legacyKey) || 0;
  const remote = (await fs.getDocs(recipesCol())).docs.map(d => ({ ...d.data(), id: d.id }));
  const byId = new Map(remote.map(r => [r.id, r]));
  const upload = [];
  for (const r of data.recipes) {
    if (r.kitchen && r.kitchen !== cloud.hid) continue; // someone else's: the cloud copy wins
    const other = byId.get(r.id);
    const mine = { ...r, kitchen: cloud.hid, kitchenName: cloud.kitchenName };
    if (other) {
      if (other.kitchen === cloud.hid && (r.updatedAt || 0) > (other.updatedAt || 0)) { byId.set(r.id, mine); upload.push(mine); }
    } else if (!r.kitchen && (!lastSync || (r.updatedAt || 0) > lastSync)) {
      // only in this browser: new since last sync (otherwise it was deleted elsewhere)
      byId.set(r.id, mine); upload.push(mine);
    }
  }
  data.recipes = [...byId.values()];
  saveLocal();
  for (const r of upload) await fs.setDoc(recipeDoc(r.id), clean(r));
  localStorage.setItem(joinedKey, String(Date.now()));
}

async function syncState() {
  const { fs } = fbMods;
  const snap = await fs.getDoc(stateDoc());
  const s = snap.exists() ? snap.data() : null;
  const ours = data.stateKitchen === cloud.hid || data.stateKitchen === undefined; // undefined: this browser before sign-in
  if (s && (!ours || (s.updatedAt || 0) >= (data.updatedAt || 0))) applyState(s);
  data.stateKitchen = cloud.hid;
  saveLocal();
  if (!s || (ours && (s.updatedAt || 0) < (data.updatedAt || 0))) await pushState();
}

function applyState(s) {
  const d = defaultState();
  Object.assign(data, {
    plan: s.plan ?? null,
    shopping: s.shopping || d.shopping,
    settings: { ...d.settings, ...(s.settings || {}) },
    updatedAt: s.updatedAt || 0,
  });
}

// Live updates from the rest of the kitchen / family
function listenForChanges() {
  const { fs } = fbMods;
  const joinedKey = `recipe-planner.joined.${cloud.fid}.${cloud.hid}`;
  const onError = (e) => { cloudError = 'Live sync stopped: ' + e.message; notify({ cloud: true }); };

  unsubscribers.push(fs.onSnapshot(recipesCol(), snap => {
    if (snap.metadata.hasPendingWrites) return; // our own write echoing back
    let changed = false;
    for (const ch of snap.docChanges()) {
      const r = { ...ch.doc.data(), id: ch.doc.id };
      const i = data.recipes.findIndex(x => x.id === r.id);
      if (ch.type === 'removed') { if (i !== -1) { data.recipes.splice(i, 1); changed = true; } }
      else if (i === -1) { data.recipes.push(r); changed = true; }
      else if ((r.updatedAt || 0) > (data.recipes[i].updatedAt || 0) || r.kitchen !== data.recipes[i].kitchen) { data.recipes[i] = r; changed = true; }
    }
    if (changed) { saveLocal(); notify({ all: true, remote: true }); }
    localStorage.setItem(joinedKey, String(Date.now()));
  }, onError));

  unsubscribers.push(fs.onSnapshot(stateDoc(), snap => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    const s = snap.data();
    if ((s.updatedAt || 0) > (data.updatedAt || 0)) { applyState(s); saveLocal(); notify({ all: true, remote: true }); }
  }, onError));

  unsubscribers.push(fs.onSnapshot(fs.doc(fbDb, 'households', cloud.hid), snap => {
    if (!snap.exists() || !cloud) return;
    const h = snap.data();
    cloud.members = h.members;
    if (h.name) cloud.kitchenName = h.name;
    notify({ cloud: true });
  }, onError));

  unsubscribers.push(fs.onSnapshot(fs.doc(fbDb, 'families', cloud.fid), snap => {
    if (!snap.exists() || !cloud) return;
    const f = snap.data();
    cloud.familyMembers = f.members;
    cloud.kitchens = { ...(f.kitchens || {}), [cloud.hid]: cloud.kitchenName };
    notify({ cloud: true, all: true });
  }, onError));
}

function pushState() {
  return fbMods.fs.setDoc(stateDoc(), clean({ plan: data.plan, shopping: data.shopping, settings: data.settings, updatedAt: data.updatedAt }));
}

async function pushCloud(changed) {
  const { fs } = fbMods;
  if (changed.recipe) await fs.setDoc(recipeDoc(changed.recipe.id), clean(changed.recipe));
  if (changed.deletedRecipe) await fs.deleteDoc(recipeDoc(changed.deletedRecipe));
  if (changed.all) for (const r of data.recipes.filter(isMine)) await fs.setDoc(recipeDoc(r.id), clean({ ...r, kitchen: cloud.hid, kitchenName: cloud.kitchenName }));
  if (changed.all || changed.plan || changed.shopping || changed.settings) await pushState();
}

function checkEmail(email) {
  if (!cloud) throw new Error('Sign in first');
  const e = normEmail(email);
  if (!validEmail(e)) throw new Error('Enter a valid email address');
  return e;
}

// Kitchen members share the meal plan and shopping list (and are also in the family)
async function updateKitchenMembers(email, action) {
  const e = checkEmail(email);
  if (action === 'remove' && e === cloud.email) throw new Error("You can't remove yourself");
  const { fs } = fbMods;
  if (action === 'add') await fs.updateDoc(fs.doc(fbDb, 'families', cloud.fid), { members: fs.arrayUnion(e) });
  await fs.updateDoc(fs.doc(fbDb, 'households', cloud.hid), { members: action === 'add' ? fs.arrayUnion(e) : fs.arrayRemove(e) });
}

// Family members see everyone's recipes but get their own kitchen
async function updateFamilyMembers(email, action) {
  const e = checkEmail(email);
  if (action === 'remove' && cloud.members.includes(e)) throw new Error(`${e} shares your kitchen. Remove them from your kitchen first.`);
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
  await fbMods.auth.signOut(fbAuth);
  // Don't leave the family's recipes behind in this browser
  data = { ...defaults(), recipes: data.recipes.filter(r => !r.kitchen) };
  saveLocal();
  notify({ all: true, cloud: true });
}
