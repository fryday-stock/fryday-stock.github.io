import { CONFIG } from './config.js';

/* ═════════════ Data layer: Firebase (online) or Local (demo) ═════════════ */
const COLS = ['items', 'locations', 'staff', 'moves', 'stocktakes', 'audit', 'suppliers', 'invoices', 'payments'];
// مجموعات المشتريات: إذا قواعد Firebase بعدها ما تسمح بيها، ما نطلّع الجهاز — بس ننبّه
const PURCH_COLS = ['suppliers', 'invoices', 'payments'];

function localBackend() {
  const key = c => 'inv_' + c;
  const read = c => { try { return JSON.parse(localStorage.getItem(key(c)) || '[]'); } catch { return []; } };
  const write = (c, arr) => { localStorage.setItem(key(c), JSON.stringify(arr)); notify(c); };
  const subs = {};
  const notify = c => (subs[c] || []).forEach(cb => cb(read(c)));
  window.addEventListener('storage', e => { const c = (e.key || '').replace('inv_', ''); if (COLS.includes(c)) notify(c); });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return {
    mode: 'local',
    authed: () => true,
    watch(c, cb) { (subs[c] = subs[c] || []).push(cb); cb(read(c)); },
    async add(c, obj) { const id = uid(); write(c, [...read(c), { ...obj, id }]); return id; },
    async addMany(c, objs) { write(c, [...read(c), ...objs.map(o => ({ ...o, id: uid() }))]); },
    async update(c, id, patch) { write(c, read(c).map(x => x.id === id ? { ...x, ...patch } : x)); },
    async remove(c, id) { write(c, read(c).filter(x => x.id !== id)); },
    newId: () => uid(),
    // صور الفواتير ما تنراقب، تنجاب عند الحاجة
    async images(invoiceId) { return read('invoiceImages').filter(x => x.invoiceId === invoiceId && !x.deleted).sort((a, b) => a.ts - b.ts); },
    async allImages() { return read('invoiceImages'); },
    async batch(ops) {
      for (const o of ops) {
        if (o.type === 'set') write(o.col, [...read(o.col).filter(x => x.id !== o.id), { ...o.data, id: o.id }]);
        else write(o.col, read(o.col).map(x => x.id === o.id ? { ...x, ...o.data } : x));
      }
    }
  };
}

async function firebaseBackend(cfg) {
  const V = '10.12.2', base = `https://www.gstatic.com/firebasejs/${V}/`;
  const { initializeApp } = await import(base + 'firebase-app.js');
  const fs = await import(base + 'firebase-firestore.js');
  const au = await import(base + 'firebase-auth.js');
  const app = initializeApp(cfg);
  let db;
  try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
  catch { db = fs.getFirestore(app); }
  const auth = au.getAuth(app);
  await new Promise(r => { const un = au.onAuthStateChanged(auth, () => { un(); r(); }); });
  return {
    mode: 'firebase',
    authed: () => !!auth.currentUser && !auth.currentUser.isAnonymous,
    signIn: (email, pass) => au.signInWithEmailAndPassword(auth, email, pass),
    signOut: () => au.signOut(auth),
    watch(c, cb, onErr) { fs.onSnapshot(fs.collection(db, c), s => cb(s.docs.map(d => ({ ...d.data(), id: d.id }))), e => onErr && onErr(e)); },
    async add(c, obj) { return (await fs.addDoc(fs.collection(db, c), obj)).id; },
    async addMany(c, objs) {
      for (let i = 0; i < objs.length; i += 400) {
        const b = fs.writeBatch(db);
        objs.slice(i, i + 400).forEach(o => b.set(fs.doc(fs.collection(db, c)), o));
        await b.commit();
      }
    },
    async update(c, id, patch) { await fs.updateDoc(fs.doc(db, c, id), patch); },
    async remove(c, id) { await fs.deleteDoc(fs.doc(db, c, id)); },
    newId: () => fs.doc(fs.collection(db, 'audit')).id,
    // صور الفواتير ما تنراقب، تنجاب عند الحاجة
    async images(invoiceId) {
      const s = await fs.getDocs(fs.query(fs.collection(db, 'invoiceImages'), fs.where('invoiceId', '==', invoiceId)));
      return s.docs.map(d => ({ ...d.data(), id: d.id })).filter(x => !x.deleted).sort((a, b) => a.ts - b.ts);
    },
    async allImages() { return (await fs.getDocs(fs.collection(db, 'invoiceImages'))).docs.map(d => ({ ...d.data(), id: d.id })); },
    async batch(ops) {
      for (let i = 0; i < ops.length; i += 450) {
        const b = fs.writeBatch(db);
        for (const o of ops.slice(i, i + 450)) { const ref = fs.doc(db, o.col, o.id); o.type === 'set' ? b.set(ref, o.data) : b.update(ref, o.data); }
        await b.commit();
      }
    }
  };
}

/* ═════════════ Constants ═════════════ */
const TYPES = {
  in:       { label: 'وارد',          ic: 'in', sign: 'to' },
  out:      { label: 'صرف / سحب',     ic: 'out', sign: 'from' },
  transfer: { label: 'نقل',           ic: 'transfer', sign: 'both' },
  waste:    { label: 'تالف',          ic: 'waste', sign: 'from' },
  return:   { label: 'مرتجع للمورد',  ic: 'return', sign: 'from' },
  opening:  { label: 'رصيد افتتاحي',  ic: 'opening', sign: 'to' },
  adjust:   { label: 'تسوية جرد',     ic: 'adjust', sign: 'adj' }
};
const OUT_REASONS = ['صرف للمطبخ', 'صرف للصالة / البار', 'ضيافة', 'استخدام شخصي (موظفين)', 'أخرى'];
const WASTE_REASONS = ['منتهي الصلاحية', 'تلف / خراب', 'سقوط / كسر', 'خطأ تحضير', 'أخرى'];
const UNITS = ['كغم', 'غم', 'لتر', 'مل', 'قطعة', 'حبة', 'بطل', 'علبة', 'كرتون', 'صندوق', 'كيس', 'شدة', 'ربطة', 'دبة', 'قنينة', 'طبق', 'درزن', 'باكيت', 'رول'];

/* ═════════════ State ═════════════ */
const S = {
  items: [], locations: [], staff: [], moves: [], allMoves: [], stocktakes: [], audit: [], suppliers: [], invoices: [], payments: [],
  aud: { tab: 'edit', from: monthStart(), to: today() },
  loaded: new Set(),
  user: null,
  view: 'home',
  stockLoc: 'all', stockQ: '', stockGroup: '',
  log: { from: monthStart(), to: today(), type: '', staff: '', q: '' },
  rep: { month: today().slice(0, 7) },
  adminTab: 'items',
  st: { loc: '', counts: {} },
  mv: null,
  pur: { tab: 'new', from: monthStart(), to: today(), sup: '', supF: '' },
  inv: null,
  itemCard: null
};
let B;

/* ═════════════ Helpers ═════════════ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r3 = n => Math.round((+n || 0) * 1000) / 1000;
const fmt = (n, d = 3) => (Math.round((+n || 0) * 10 ** d) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });
const money = n => Math.round(+n || 0).toLocaleString('en-US');
const N = (n, plus = false) => `<bdi dir="ltr">${plus && n > 0 ? '+' : ''}${fmt(n)}</bdi>`;
const M = n => `<bdi dir="ltr">${money(n)}</bdi>`;
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function monthStart() { return today().slice(0, 8) + '01'; }
const dayStartTs = s => new Date(s + 'T00:00:00').getTime();
const dayEndTs = s => new Date(s + 'T23:59:59.999').getTime();
const dt = ts => { const d = new Date(ts); return d.toLocaleDateString('en-CA') + ' ' + d.toTimeString().slice(0, 5); };
const itemById = id => S.items.find(i => i.id === id);
const locById = id => S.locations.find(l => l.id === id);
const locName = id => locById(id)?.name || '—';
const isAdmin = () => S.user?.role === 'admin';
const canEdit = () => isAdmin() || S.user?.canEdit === true;
const mName = m => itemById(m.itemId)?.name || m.itemName || '';
const activeItems = () => S.items.filter(i => i.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
const activeLocs = () => S.locations.filter(l => l.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ar'));
const packOf = it => (it?.bigUnit && +it.pack > 0) ? +it.pack : 1;
const unitsOf = it => it ? [it.baseUnit, ...(it.bigUnit && +it.pack > 0 ? [it.bigUnit] : [])] : [];

/* أيقونات SVG للعرض فقط (بدل الإيموجي) */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  move: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  stock: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  log: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  stocktake: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.5h6V4"/><path d="m9 13 2 2 4-4"/>',
  reports: '<path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/>',
  audit: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  admin: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  in: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  out: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 21h16"/>',
  transfer: '<path d="M4 8h15l-4-4"/><path d="M20 16H5l4 4"/>',
  waste: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
  return: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  opening: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  adjust: '<path d="M12 3v18M7 21h10"/><path d="M4 7h16"/><path d="m4 7-2.5 6a3 3 0 0 0 5 0z"/><path d="m20 7-2.5 6a3 3 0 0 0 5 0z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  arrow: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s7-6.1 7-12a7 7 0 0 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/><path d="M6 6V4h11v2"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  save: '<path d="m5 12 5 5 9-10"/>',
  login: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5"/>',
  logout: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 14h10l1-14"/>',
  purchases: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M3 4h2l2.4 11h11.2L21 8H6.2"/>',
  back: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 9"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  minus: '<path d="M5 12h14"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/>'
};
/* وصف بطاقات الحركات بالرئيسية (عرض فقط) */
const ACT_DESC = { in: 'استلام بضاعة من المورد', out: 'صرف مواد للمطبخ أو الأقسام', transfer: 'نقل بين المخازن', waste: 'تسجيل مواد تالفة أو منتهية', return: 'إرجاع بضاعة للمورد' };
const sub = t => t ? `<small class="sub">${t}</small>` : '';
const dtCell = ts => { const [d, t] = dt(ts).split(' '); return `<td class="when"><b>${t}</b><small class="sub">${d}</small></td>`; };
const ico = k => ICONS[k] ? `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>` : '';

function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(t._h); t._h = setTimeout(() => t.className = '', 2600);
}
function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  const close = () => root.innerHTML = '';
  root.querySelector('.modal-bg').addEventListener('click', e => { if (e.target.classList.contains('modal-bg')) close(); });
  onMount && onMount(root.querySelector('.modal'), close);
  return close;
}
function confirmBox(text, okLabel = 'تأكيد', danger = false) {
  return new Promise(res => {
    modal(`<h2>تأكيد</h2><p>${text}</p><div class="foot"><button class="btn ${danger ? 'danger' : ''}" id="cf-ok">${okLabel}</button><button class="btn ghost" id="cf-no">إلغاء</button></div>`,
      (m, close) => {
        m.querySelector('#cf-ok').onclick = () => { close(); res(true); };
        m.querySelector('#cf-no').onclick = () => { close(); res(false); };
      });
  });
}
async function hashPin(staffName, pin) {
  const s = 'inv|' + staffName + '|' + pin;
  if (crypto?.subtle) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  return 'p:' + s;
}
function detailed(it, q, raw = false) {
  const p = packOf(it);
  if (p <= 1 || q <= 0) return '';
  const e = raw ? (x => x) : esc;
  const big = Math.floor(r3(q) / p), rest = r3(q - big * p);
  if (raw) return `${fmt(big)} ${it.bigUnit}` + (rest ? ` + ${fmt(rest)} ${it.baseUnit}` : '');
  return `${N(big)} ${esc(it.bigUnit)}` + (rest ? ` + ${N(rest)} ${esc(it.baseUnit)}` : '');
}
function csvDownload(name, rows) {
  const csv = '﻿' + rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ═════════════ Calculations ═════════════ */
function moveEffects(m) {
  // returns [[locId, deltaBase], ...]
  const q = +m.baseQty || 0;
  switch (m.type) {
    case 'in': case 'opening': return [[m.toLoc, q]];
    case 'out': case 'waste': case 'return': return [[m.fromLoc, -q]];
    case 'transfer': return [[m.fromLoc, -q], [m.toLoc, q]];
    case 'adjust': return [[m.toLoc, q]]; // signed
    default: return [];
  }
}
function balances(moves = S.moves) {
  const map = new Map();
  for (const m of moves) for (const [loc, d] of moveEffects(m)) {
    const k = m.itemId + '|' + loc; map.set(k, (map.get(k) || 0) + d);
  }
  return map;
}
function totalsByItem(bal) {
  const t = new Map();
  for (const [k, v] of bal) { const id = k.split('|')[0]; t.set(id, (t.get(id) || 0) + v); }
  return t;
}
function avgCosts() {
  const c = new Map();
  for (const m of S.moves) if (m.type === 'in' || m.type === 'opening') {
    const x = c.get(m.itemId) || { cost: 0, q: 0 }; x.cost += +m.cost || 0; x.q += +m.baseQty || 0; c.set(m.itemId, x);
  }
  const out = new Map(); for (const [id, x] of c) out.set(id, x.q ? x.cost / x.q : 0); return out;
}
function status(it, q) {
  if (q < -0.0005) return ['رصيد سالب', 'b-bad'];
  if (Math.abs(q) < 0.0005) return ['نفذ', 'b-bad'];
  if (+it.minQty > 0 && q <= +it.minQty) return ['دون حد الأمان', 'b-warn'];
  return ['كافٍ', 'b-ok'];
}

/* ═════════════ Boot ═════════════ */
async function boot() {
  try {
    B = (CONFIG.firebase && CONFIG.firebase.apiKey) ? await firebaseBackend(CONFIG.firebase) : localBackend();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = `<div class="boot">تعذّر الاتصال بقاعدة البيانات. تأكد من الإنترنت وإعدادات Firebase.<br><small>${esc(e.message)}</small></div>`;
    return;
  }
  document.title = CONFIG.title || 'نظام المخزن';
  if (!B.authed()) return renderDevice();
  startData();
}
function renderDevice(err) {
  $('#app').innerHTML = `<div class="login"><div class="box">
    <img class="logo-big" src="logo.png" alt="">
    <h1>${esc(CONFIG.title)}</h1><p class="sub">هذا الجهاز غير مفعّل. يفعّله المدير مرة وحدة بكلمة سر المطعم.</p>
    <div class="field"><label>إيميل المطعم</label><input class="in" id="dv-e" dir="ltr" value="${esc(CONFIG.deviceEmail || '')}"></div>
    <div class="field"><label>كلمة سر المطعم</label><input class="in" id="dv-p" type="password" dir="ltr"></div>
    <button class="btn big" id="dv-go">${ico('shield')}تفعيل الجهاز</button>
    ${err ? `<p class="hint bad">${esc(err)}</p>` : ''}
  </div></div>`;
  const go = async () => {
    const e = $('#dv-e').value.trim(), p = $('#dv-p').value;
    if (!e || !p) return toast('اكتب الإيميل وكلمة السر', true);
    $('#dv-go').disabled = true;
    try { await B.signIn(e, p); startData(); }
    catch (x) { renderDevice(/invalid|wrong|not-found|credential/i.test(x.code || '') ? 'الإيميل أو كلمة السر غير صحيحة' : 'تعذّر التفعيل: ' + (x.code || x.message)); }
  };
  $('#dv-go').onclick = go;
  $('#dv-p').onkeydown = e => { if (e.key === 'Enter') go(); };
}
let started = false;
function startData() {
  if (started) return; started = true;
  $('#app').innerHTML = '<div class="boot">جاري تحميل البيانات…</div>';
  const saved = localStorage.getItem('inv_session');
  const onErr = e => {
    console.error(e);
    if (e.code === 'permission-denied') { started = false; B.signOut && B.signOut(); renderDevice('هذا الجهاز ما عنده صلاحية. فعّله من جديد.'); }
  };
  const purchErr = c => e => {
    console.error(e);
    if (e.code !== 'permission-denied') return;
    S[c] = []; S.loaded.add(c);
    toast('شاشة المشتريات تحتاج تحديث قواعد Firebase (firestore.rules)', true);
    if (S.loaded.size === COLS.length) onData();
  };
  COLS.forEach(c => B.watch(c, rows => {
    if (c === 'moves') { rows.sort((a, b) => a.ts - b.ts); S.allMoves = rows; rows = rows.filter(m => !m.deleted); }
    S[c] = rows; S.loaded.add(c);
    if (c === 'staff' && saved && !S.user) { const u = rows.find(s => s.id === saved && s.active !== false); if (u) S.user = u; }
    if (c === 'staff' && S.user) { const u = rows.find(s => s.id === S.user.id); if (!u || u.active === false) { S.user = null; localStorage.removeItem('inv_session'); } else S.user = u; }
    if (S.loaded.size === COLS.length) onData();
  }, PURCH_COLS.includes(c) ? purchErr(c) : onErr));
}
function onData() {
  // Avoid wiping forms the user is filling
  if (S.user && (S.view === 'move' || S.view === 'stocktake') && $('#view-root')) { refreshLive(); return; }
  if (S.user && S.view === 'purchases' && S.pur.tab === 'new' && !S.pur.sup && $('#iv-lines')) { invRefresh(); return; }
  render();
}

/* ═════════════ Render root ═════════════ */
const NAV = [
  ['home', 'home', 'الرئيسية'],
  ['move', 'move', 'حركة جديدة'],
  ['purchases', 'purchases', 'المشتريات'],
  ['stock', 'stock', 'الأرصدة'],
  ['log', 'log', 'السجل'],
  ['stocktake', 'stocktake', 'الجرد'],
  ['reports', 'reports', 'التقارير'],
  ['audit', 'audit', 'التعديلات والحذف'],
  ['admin', 'admin', 'الإدارة', true]
];
/* مؤشر الاتصال (عرض فقط): يتحدث بمكانه بدون إعادة رسم الصفحة */
const netBadge = () => B?.mode === 'local' ? '' : `<span class="net ${navigator.onLine ? 'on' : 'off'}" role="status">${navigator.onLine ? 'متصل' : 'غير متصل'}</span>`;
const netUpdate = () => document.querySelectorAll('.net').forEach(el => el.outerHTML = netBadge());
window.addEventListener('online', netUpdate);
window.addEventListener('offline', netUpdate);

function render() {
  if (!S.staff.length) return renderSetup();
  if (!S.user) return renderLogin();
  const nav = NAV.filter(n => !n[3] || isAdmin());
  if (!nav.find(n => n[0] === S.view)) S.view = 'home';
  const role = S.user.role === 'admin' ? 'مدير' : S.user.canEdit ? 'موظف (يعدّل)' : 'موظف';
  const day = new Date().toLocaleDateString('ar-IQ-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand"><img class="logo" src="logo.png" alt=""><div>${esc(CONFIG.title)}<small>نظام المخزن</small></div></div>
      ${nav.map(n => `<button class="nav ${S.view === n[0] ? 'on' : ''}" data-go="${n[0]}"><span class="ic">${ico(n[1])}</span>${n[2]}</button>`).join('')}
      <div class="me"><button class="btn ghost sm" id="lo">${ico('logout')}تسجيل خروج</button></div>
    </aside>
    <div class="content">
      <header class="topbar">
        <img class="tlogo" src="logo.png" alt="">
        <div class="hello"><b>مرحباً، ${esc(S.user.name)}</b><small>${day} — خلّينا نشوف حالة المخزن اليوم</small></div>
        <div class="who">${netBadge()}<div class="who-t"><b>${esc(S.user.name)}</b><small>${role}</small></div><span class="avatar">${esc((S.user.name || '؟').trim().charAt(0))}</span><button class="lo2" id="lo2" aria-label="تسجيل خروج">${ico('logout')}</button></div>
      </header>
      <main class="main" id="view-root"></main>
    </div>
  </div>
  <nav class="bottom">${nav.map(n => `<button class="${S.view === n[0] ? 'on' : ''}" data-go="${n[0]}"><span class="ic">${ico(n[1])}</span>${n[2]}</button>`).join('')}</nav>`;
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  const lo = () => { S.user = null; localStorage.removeItem('inv_session'); render(); };
  $('#lo').onclick = lo; $('#lo2').onclick = lo;
  const views = { home: vHome, move: vMove, purchases: vPurch, stock: vStock, log: vLog, stocktake: vStocktake, reports: vReports, audit: vAudit, admin: vAdmin };
  views[S.view]();
  window.scrollTo(0, 0);
}
function go(v, opts = {}) {
  S.view = v;
  if (v === 'move') S.mv = newMove(opts.type || 'out');
  if (v === 'stock' && opts.loc) S.stockLoc = opts.loc;
  if (v === 'stock') S.itemCard = opts.item || null;
  if (v === 'purchases') { S.pur.sup = opts.sup || ''; if (opts.tab) S.pur.tab = opts.tab; }
  render();
}
const modeTag = () => B.mode === 'local' ? `<span class="mode">وضع تجربة — البيانات على هذا الجهاز فقط</span>` : '';

/* ═════════════ Setup & Login ═════════════ */
function renderSetup() {
  $('#app').innerHTML = `<div class="login"><div class="box">
    <img class="logo-big" src="logo.png" alt="">
    <h1>${esc(CONFIG.title)}</h1><p class="sub">أول تشغيل: أنشئ حساب المدير</p>
    <div class="field"><label>اسم المدير</label><input class="in" id="su-n" placeholder="مثلاً: أحمد"></div>
    <div class="field"><label>رمز سري (4 أرقام)</label><input class="in pin" id="su-p" inputmode="numeric" maxlength="6" type="password"></div>
    <button class="btn big" id="su-go">${ico('login')}إنشاء والدخول</button>
    <p class="hint">بعدها تضيف الموظفين وأماكن الخزن والمواد من شاشة الإدارة.</p>
  </div></div>`;
  $('#su-go').onclick = async () => {
    const name = $('#su-n').value.trim(), pin = $('#su-p').value.trim();
    if (!name || !/^\d{4,6}$/.test(pin)) return toast('اكتب الاسم ورمز من 4 إلى 6 أرقام', true);
    const id = await B.add('staff', { name, role: 'admin', pinHash: await hashPin(name, pin), active: true, created: Date.now() });
    localStorage.setItem('inv_session', id);
    S.user = S.staff.find(x => x.id === id) || { id, name, role: 'admin' };
    S.view = 'admin'; render();
  };
}
function renderLogin() {
  const staff = S.staff.filter(s => s.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  let pick = null;
  $('#app').innerHTML = `<div class="login"><div class="box">
    <img class="logo-big" src="logo.png" alt="">
    <h1>${esc(CONFIG.title)}</h1><p class="sub">اختر اسمك واكتب رمزك</p>
    <div class="staff-grid">${staff.map(s => `<button data-id="${s.id}">${esc(s.name)}</button>`).join('')}</div>
    <div class="field"><input class="in pin" id="lg-p" inputmode="numeric" maxlength="6" type="password" placeholder="••••"></div>
    <button class="btn big" id="lg-go">${ico('login')}دخول</button>
    <div style="text-align:center;margin-top:10px">${B.mode === 'local' ? '<span class="mode">وضع تجربة</span>' : ''}</div>
  </div></div>`;
  document.querySelectorAll('.staff-grid button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.staff-grid button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); pick = staff.find(s => s.id === b.dataset.id); $('#lg-p').focus();
  });
  const login = async () => {
    if (!pick) return toast('اختر اسمك أولاً', true);
    if (await hashPin(pick.name, $('#lg-p').value.trim()) !== pick.pinHash) { $('#lg-p').value = ''; return toast('الرمز غير صحيح', true); }
    S.user = pick; localStorage.setItem('inv_session', pick.id); S.view = 'home'; render();
  };
  $('#lg-go').onclick = login;
  $('#lg-p').onkeydown = e => { if (e.key === 'Enter') login(); };
}

/* ═════════════ Home ═════════════ */
function vHome() {
  const bal = balances(), tot = totalsByItem(bal), avg = avgCosts();
  const items = activeItems();
  const value = items.reduce((s, it) => s + Math.max(tot.get(it.id) || 0, 0) * (avg.get(it.id) || 0), 0);
  const low = items.filter(it => { const q = tot.get(it.id) || 0; return status(it, q)[1] !== 'b-ok'; });
  const t0 = dayStartTs(today());
  const todayMoves = S.moves.filter(m => m.ts >= t0);
  const locs = activeLocs();
  const locCount = id => items.filter(it => (bal.get(it.id + '|' + id) || 0) > 0.0005).length;
  $('#view-root').innerHTML = `
    <div class="topline"><h1>الرئيسية</h1>${modeTag()}</div>
    ${storageAlert()}
    <div class="actions">
      ${['in', 'out', 'transfer', 'waste', 'return'].map(t => `<button class="act ${t}" data-t="${t}"><span class="ic">${ico(TYPES[t].ic)}</span><span class="tx"><b>${TYPES[t].label}</b><small>${ACT_DESC[t]}</small></span><span class="bgi" aria-hidden="true">${ico(TYPES[t].ic)}</span><span class="goi" aria-hidden="true">${ico('arrow')}</span></button>`).join('')}
    </div>
    <div class="overview">
      <div class="valcard"><div class="vc-top"><span>قيمة المخزون</span><img src="logo.png" alt=""></div><div class="vc-num">${M(value)}<small>د.ع</small></div><div class="vc-foot"><span>${items.length} مادة</span><span>${locs.length} أماكن خزن</span></div></div>
      <div class="kpis">
        <div class="kpi k-blue"><span class="ki">${ico('stock')}</span><div><div class="l">عدد المواد</div><div class="v">${items.length}</div></div></div>
        <div class="kpi k-amber ${low.length ? 'warn' : ''}"><span class="ki">${ico('alert')}</span><div><div class="l">مواد تحتاج طلب</div><div class="v">${low.length}</div></div></div>
        <div class="kpi k-green"><span class="ki">${ico('clock')}</span><div><div class="l">حركات اليوم</div><div class="v">${todayMoves.length}</div></div></div>
      </div>
    </div>
    <div class="two">
      <div class="card"><h2>أماكن الخزن</h2>
        ${locs.length ? `<div class="locs">${locs.map(l => `<button class="loc" data-loc="${l.id}"><span class="ki">${ico('pin')}</span><span><b>${esc(l.name)}</b><span>${locCount(l.id)} مادة متوفرة</span></span></button>`).join('')}</div>`
        : `<div class="empty">ما اكو أماكن خزن بعد. ${isAdmin() ? 'أضفها من الإدارة.' : ''}</div>`}
      </div>
      <div class="card"><h2>تحتاج طلب</h2>
        ${low.length ? `<div class="tbl-wrap"><table><tr><th>المادة</th><th class="num">الرصيد</th><th>الحالة</th></tr>
          ${low.slice(0, 15).map(it => { const q = tot.get(it.id) || 0, st = status(it, q); return `<tr><td><b>${esc(it.name)}</b>${sub(esc(grpOf(it)))}</td><td class="num">${N(q)} ${esc(it.baseUnit)}</td><td><span class="badge ${st[1]}">${st[0]}</span></td></tr>`; }).join('')}
        </table></div>` : `<div class="empty">${ico('check')} كل المواد كافية</div>`}
      </div>
    </div>
    <div class="card"><h2>آخر الحركات</h2>${movesTable(S.moves.slice(-8).reverse(), false)}</div>`;
  document.querySelectorAll('.act').forEach(b => b.onclick = () => b.dataset.t === 'in' ? go('purchases', { tab: 'new' }) : go('move', { type: b.dataset.t }));
  document.querySelectorAll('[data-loc]').forEach(b => b.onclick = () => go('stock', { loc: b.dataset.loc }));
}

/* ═════════════ Movement form ═════════════ */
function newMove(type) {
  const prev = S.mv || {};
  return { type, itemId: '', unit: '', qty: '', price: '', fromLoc: prev.fromLoc || '', toLoc: prev.toLoc || '', reason: '', note: '', ref: '', q: '' };
}
function vMove() {
  const mv = S.mv || (S.mv = newMove('out'));
  if (mv.type === 'in') { mv.type = 'out'; return go('purchases', { tab: 'new' }); } // الوارد صار بفاتورة المشتريات
  const types = ['in', 'out', 'transfer', 'waste', 'return', ...(isAdmin() ? ['opening'] : [])];
  const it = itemById(mv.itemId);
  const locs = activeLocs();
  if (locs.length === 1) { mv.fromLoc = mv.fromLoc || locs[0].id; mv.toLoc = mv.toLoc || locs[0].id; }
  const locOpts = sel => `<option value="">— اختر —</option>` + locs.map(l => `<option value="${l.id}" ${sel === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const needFrom = ['out', 'transfer', 'waste', 'return'].includes(mv.type);
  const needTo = ['in', 'transfer', 'opening'].includes(mv.type);
  const needPrice = ['in', 'opening'].includes(mv.type);
  const reasons = mv.type === 'out' ? OUT_REASONS : mv.type === 'waste' ? WASTE_REASONS : null;
  $('#view-root').innerHTML = `
    <div class="topline"><h1>حركة جديدة</h1>${modeTag()}</div>
    <div class="card">
      <div class="seg">${types.map(t => `<button data-type="${t}" class="${mv.type === t ? 'on' : ''}">${ico(TYPES[t].ic)}${TYPES[t].label}</button>`).join('')}</div>
      <div class="field"><label>المادة <span class="req">*</span></label>
        ${it ? `<div class="sel-item"><span>${esc(it.name)} <span class="muted small">(${esc(unitsOf(it).join(' / '))})</span></span><button class="link" id="mv-clear">تغيير</button></div>`
             : `<div class="picker"><input class="in" id="mv-q" placeholder="اكتب اسم المادة…" autocomplete="off" value="${esc(mv.q)}"><div class="list" id="mv-list" hidden></div></div>`}
      </div>
      <div class="row">
        <div class="field"><label>الوحدة <span class="req">*</span></label>
          <select class="in" id="mv-unit" ${it ? '' : 'disabled'}>${unitsOf(it).map(u => `<option ${mv.unit === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>الكمية <span class="req">*</span></label>
          <input class="in" id="mv-qty" type="number" inputmode="decimal" min="0" step="any" value="${esc(mv.qty)}" placeholder="0">
          <div class="hint" id="mv-conv"></div>
        </div>
      </div>
      <div class="row">
        ${needFrom ? `<div class="field"><label>${mv.type === 'transfer' ? 'من مكان' : 'المكان'} <span class="req">*</span></label><select class="in" id="mv-from">${locOpts(mv.fromLoc)}</select><div class="hint" id="mv-avail"></div></div>` : ''}
        ${needTo ? `<div class="field"><label>${mv.type === 'transfer' ? 'إلى مكان' : 'يدخل إلى'} <span class="req">*</span></label><select class="in" id="mv-to">${locOpts(mv.toLoc)}</select></div>` : ''}
      </div>
      ${needPrice ? `<div class="row">
        <div class="field"><label>سعر الوحدة المختارة (د.ع) <span class="req">*</span></label><input class="in" id="mv-price" type="number" inputmode="decimal" min="0" step="any" value="${esc(mv.price)}"><div class="hint" id="mv-total"></div></div>
        <div class="field"><label>رقم الوصل / المورد</label><input class="in" id="mv-ref" value="${esc(mv.ref)}"></div>
      </div>` : ''}
      ${reasons ? `<div class="field"><label>السبب <span class="req">*</span></label><select class="in" id="mv-reason"><option value="">— اختر —</option>${reasons.map(r => `<option ${mv.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>ملاحظة</label><input class="in" id="mv-note" value="${esc(mv.note)}"></div>
      <div class="hint" style="margin-bottom:10px">الموظف: <b>${esc(S.user.name)}</b> — الوقت يتسجل تلقائياً</div>
      <button class="btn big t-${mv.type}" id="mv-save">${ico('save')}تأكيد ${TYPES[mv.type].label}</button>
    </div>`;

  document.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { if (b.dataset.type === 'in') return go('purchases', { tab: 'new' }); S.mv.type = b.dataset.type; S.mv.reason = ''; vMove(); });
  const bind = (id, key) => { const el = $(id); if (el) el.oninput = el.onchange = () => { S.mv[key] = el.value; refreshLive(); }; };
  bind('#mv-unit', 'unit'); bind('#mv-qty', 'qty'); bind('#mv-from', 'fromLoc'); bind('#mv-to', 'toLoc');
  bind('#mv-price', 'price'); bind('#mv-reason', 'reason'); bind('#mv-note', 'note'); bind('#mv-ref', 'ref');
  if ($('#mv-clear')) $('#mv-clear').onclick = () => { S.mv.itemId = ''; S.mv.unit = ''; S.mv.q = ''; vMove(); $('#mv-q')?.focus(); };
  if ($('#mv-q')) setupPicker();
  $('#mv-save').onclick = saveMove;
  refreshLive();
}
function setupPicker() {
  const q = $('#mv-q'), list = $('#mv-list');
  let hl = 0, res = [];
  const tot = totalsByItem(balances());
  const draw = () => {
    const s = q.value.trim();
    S.mv.q = q.value;
    res = activeItems().filter(i => !s || i.name.includes(s)).slice(0, 30);
    if (!res.length) { list.innerHTML = `<div class="opt muted">ما اكو مادة بهذا الاسم${isAdmin() ? ' — أضفها من الإدارة' : ''}</div>`; list.hidden = false; return; }
    hl = Math.min(hl, res.length - 1);
    list.innerHTML = res.map((i, n) => `<div class="opt ${n === hl ? 'hl' : ''}" data-id="${i.id}"><span>${esc(i.name)}</span><small>${fmt(tot.get(i.id) || 0)} ${esc(i.baseUnit)}</small></div>`).join('');
    list.hidden = false;
    list.querySelectorAll('[data-id]').forEach(o => o.onmousedown = e => { e.preventDefault(); choose(o.dataset.id); });
  };
  const choose = id => { const it = itemById(id); S.mv.itemId = id; S.mv.unit = it.baseUnit; S.mv.q = ''; vMove(); $('#mv-qty')?.focus(); };
  q.oninput = () => { hl = 0; draw(); };
  q.onfocus = draw;
  q.onblur = () => setTimeout(() => list.hidden = true, 150);
  q.onkeydown = e => {
    if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, res.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && res[hl]) { choose(res[hl].id); e.preventDefault(); }
  };
}
function moveCalc() {
  const mv = S.mv, it = itemById(mv.itemId);
  const factor = it && mv.unit && mv.unit === it.bigUnit ? packOf(it) : 1;
  const qty = +mv.qty || 0;
  return { it, factor, qty, baseQty: r3(qty * factor), cost: (+mv.price || 0) * qty };
}
function refreshLive() {
  if (S.view === 'stocktake') return stRefresh();
  if (S.view !== 'move' || !S.mv) return;
  const { it, factor, qty, baseQty, cost } = moveCalc(), mv = S.mv;
  const conv = $('#mv-conv');
  if (conv) conv.textContent = it && factor > 1 && qty ? `= ${fmt(baseQty)} ${it.baseUnit}` : '';
  const tot = $('#mv-total');
  if (tot) tot.textContent = qty && +mv.price ? `الإجمالي: ${money(cost)} د.ع` + (factor > 1 ? ` — كلفة ${it.baseUnit}: ${fmt(cost / baseQty, 2)}` : '') : '';
  const av = $('#mv-avail');
  if (av) {
    if (it && mv.fromLoc) {
      const have = balances().get(it.id + '|' + mv.fromLoc) || 0;
      const short = baseQty > have + 0.0005;
      av.className = 'hint ' + (short ? 'bad' : 'ok');
      av.textContent = `المتوفر هنا: ${fmt(have)} ${it.baseUnit}` + (detailed(it, have, true) ? ` (${detailed(it, have, true)})` : '') + (short ? ' — الكمية أكثر من المتوفر' : '');
    } else av.textContent = '';
  }
}
async function saveMove() {
  const mv = S.mv, { it, factor, qty, baseQty, cost } = moveCalc();
  const needFrom = ['out', 'transfer', 'waste', 'return'].includes(mv.type);
  const needTo = ['in', 'transfer', 'opening'].includes(mv.type);
  const needPrice = ['in', 'opening'].includes(mv.type);
  const needReason = ['out', 'waste'].includes(mv.type);
  if (!it) return toast('اختر المادة', true);
  if (!(qty > 0)) return toast('اكتب الكمية', true);
  if (needFrom && !mv.fromLoc) return toast('اختر المكان', true);
  if (needTo && !mv.toLoc) return toast('اختر المكان اللي تدخل له', true);
  if (mv.type === 'transfer' && mv.fromLoc === mv.toLoc) return toast('مكان النقل لازم يختلف', true);
  if (needPrice && !(+mv.price > 0)) return toast('اكتب السعر', true);
  if (needReason && !mv.reason) return toast('اختر السبب', true);
  if (needFrom) {
    const have = balances().get(it.id + '|' + mv.fromLoc) || 0;
    if (baseQty > have + 0.0005 && !(await confirmBox(`المتوفر بالدفتر ${fmt(have)} ${esc(it.baseUnit)} فقط، وانت تسحب ${fmt(baseQty)}. متأكد؟`, 'نعم، سجّل'))) return;
  }
  const doc = {
    ts: Date.now(), type: mv.type, itemId: it.id, itemName: it.name, unit: mv.unit || it.baseUnit, qty: r3(qty), factor,
    baseQty, baseUnit: it.baseUnit, price: needPrice ? +mv.price : 0, cost: needPrice ? Math.round(cost) : 0,
    fromLoc: needFrom ? mv.fromLoc : '', toLoc: needTo ? mv.toLoc : '',
    reason: needReason ? mv.reason : '', ref: needPrice ? mv.ref.trim() : '', note: mv.note.trim(),
    staffId: S.user.id, staffName: S.user.name
  };
  $('#mv-save').disabled = true;
  try { await B.add('moves', doc); }
  catch (e) { $('#mv-save').disabled = false; return toast('ما انحفظت: ' + e.message, true); }
  toast(`✔ تسجّل ${TYPES[mv.type].label}: ${fmt(qty)} ${mv.unit} ${it.name}`);
  const keep = { type: mv.type, fromLoc: mv.fromLoc, toLoc: mv.toLoc };
  S.mv = { ...newMove(keep.type), ...keep };
  vMove(); $('#mv-q')?.focus();
}

/* ═════════════ Stock ═════════════ */
const NOGRP = 'بدون مجموعة';
const grpOf = it => normTxt(it.group) || NOGRP;
const allGroups = () => [...new Set(activeItems().map(grpOf))].sort((a, b) => a === NOGRP ? 1 : b === NOGRP ? -1 : a.localeCompare(b, 'ar'));
function vStock() {
  if (S.itemCard) return vItemCard();
  const bal = balances(), tot = totalsByItem(bal), avg = avgCosts();
  const locs = activeLocs(), groups = allGroups();
  if (S.stockLoc !== 'all' && !locById(S.stockLoc)) S.stockLoc = 'all';
  if (S.stockGroup && !groups.includes(S.stockGroup)) S.stockGroup = '';
  const L = S.stockLoc, G = S.stockGroup || '';
  const q = normKey(S.stockQ);
  let rows = activeItems().map(it => ({ it, g: grpOf(it), qty: L === 'all' ? (tot.get(it.id) || 0) : (bal.get(it.id + '|' + L) || 0) }));
  if (L !== 'all') rows = rows.filter(r => Math.abs(r.qty) > 0.0005 || S.moves.some(m => m.itemId === r.it.id && (m.fromLoc === L || m.toLoc === L)));
  if (G) rows = rows.filter(r => r.g === G);
  if (q) rows = rows.filter(r => normKey(r.it.name).includes(q) || normKey(r.g).includes(q));
  rows.forEach(r => r.val = Math.max(r.qty, 0) * (avg.get(r.it.id) || 0));
  rows.sort((a, b) => (a.g === NOGRP) - (b.g === NOGRP) || a.g.localeCompare(b.g, 'ar') || a.it.name.localeCompare(b.it.name, 'ar'));
  // summary
  const byUnit = new Map(); rows.forEach(r => byUnit.set(r.it.baseUnit, (byUnit.get(r.it.baseUnit) || 0) + r.qty));
  const totVal = rows.reduce((a, r) => a + r.val, 0);
  const per = it => locs.map(l => [l, bal.get(it.id + '|' + l.id) || 0]).filter(x => Math.abs(x[1]) > 0.0005);
  const cols = 4 + (L === 'all' ? 2 : 0);
  let body = '', lastG = null;
  for (const r of rows) {
    if (r.g !== lastG) {
      lastG = r.g; const gr = rows.filter(x => x.g === r.g);
      body += `<tr class="grp"><td colspan="${cols}"><b>${ico('folder')} ${esc(r.g)}</b> <span class="small muted">— ${gr.length} مادة — القيمة ${M(gr.reduce((a, x) => a + x.val, 0))} د.ع</span></td></tr>`;
    }
    const { it, qty } = r;
    const st = L === 'all' ? status(it, qty) : (qty < -0.0005 ? ['رصيد سالب', 'b-bad'] : Math.abs(qty) < 0.0005 ? ['فارغ', 'b-muted'] : ['متوفر', 'b-ok']);
    body += `<tr><td><button class="item-link" data-card="${it.id}">${esc(it.name)}</button>${sub(detailed(it, qty))}</td><td class="num ${qty < -0.0005 ? 'neg' : ''}">${N(qty)} ${esc(it.baseUnit)}</td>
      ${L === 'all' ? `<td class="small muted">${per(it).map(([l, v]) => `${esc(l.name)}: ${N(v)}`).join(' · ')}</td><td class="num">${+it.minQty ? N(it.minQty) : '—'}</td>` : ''}
      <td class="num">${M(r.val)}</td>
      <td><span class="badge ${st[1]}">${st[0]}</span></td></tr>`;
  }
  $('#view-root').innerHTML = `
    <div class="topline"><h1>الأرصدة</h1><button class="btn sm" id="sk-csv">${ico('download')}تصدير</button></div>
    <div class="filters">
      <input class="in" id="sk-q" placeholder="بحث باسم المادة أو المجموعة…" value="${esc(S.stockQ)}" style="flex:1;min-width:220px">
      <select class="in" id="sk-g"><option value="">كل المجموعات</option>${groups.map(g => `<option ${G === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
    </div>
    <div class="chips"><button data-l="all" class="${L === 'all' ? 'on' : ''}">كل الأماكن</button>${locs.map(l => `<button data-l="${l.id}" class="${L === l.id ? 'on' : ''}">${esc(l.name)}</button>`).join('')}</div>
    ${rows.length ? `<div class="sumbar">
      <span><span class="muted small">النتائج</span><b>${rows.length} مادة</b></span>
      <span><span class="muted small">الكمية</span><b>${[...byUnit].map(([u, v]) => `${N(v)} ${esc(u)}`).join(' · ')}</b></span>
      <span><span class="muted small">القيمة</span><b>${M(totVal)} د.ع</b></span>
    </div>` : ''}
    <div class="card"><div class="tbl-wrap">${rows.length ? `<table>
      <tr><th>المادة</th><th class="num">الرصيد</th>${L === 'all' ? '<th>التوزيع على الأماكن</th><th class="num">حد الأمان</th>' : ''}<th class="num">القيمة (د.ع)</th><th>الحالة</th></tr>
      ${body}
    </table>` : `<div class="empty">ما اكو مواد ${q ? 'بهذا البحث' : G ? 'بهذي المجموعة' : L !== 'all' ? 'بهذا المكان' : 'بعد'}</div>`}</div></div>`;
  document.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { S.stockLoc = b.dataset.l; vStock(); });
  document.querySelectorAll('[data-card]').forEach(b => b.onclick = () => { S.itemCard = b.dataset.card; vStock(); window.scrollTo(0, 0); });
  $('#sk-g').onchange = e => { S.stockGroup = e.target.value; vStock(); };
  $('#sk-q').oninput = e => { S.stockQ = e.target.value; const p = e.target.selectionStart; vStock(); const n = $('#sk-q'); n.focus(); n.setSelectionRange(p, p); };
  $('#sk-csv').onclick = () => {
    const out = []; let lg = null;
    for (const r of rows) {
      if (r.g !== lg) { lg = r.g; out.push({ group: r.g }); }
      const row = [r.it.name, r3(r.qty), r.it.baseUnit, detailed(r.it, r.qty, true)];
      row.push(Math.round(avg.get(r.it.id) || 0), Math.round(r.val));
      out.push(row);
    }
    exportSheet({ file: `أرصدة_${L === 'all' ? 'كل_المخازن' : locName(L)}_${today()}.xlsx`, title: `${CONFIG.title} — الأرصدة`,
      sub: [`المخزن: ${L === 'all' ? 'كل المخازن' : locName(L)}`, G ? `المجموعة: ${G}` : '', S.stockQ.trim() ? `البحث: ${S.stockQ.trim()}` : '', `بتاريخ: ${dt(Date.now())}`].filter(Boolean).join('   |   '),
      headers: ['المادة', 'الرصيد', 'الوحدة', 'مفصّل', 'متوسط الكلفة (د.ع)', 'القيمة (د.ع)'],
      rows: out, qty: [1], money: [4, 5], totals: { label: 'المجموع', cols: [5] } });
  };
}

/* ═════════════ Log ═════════════ */
function moveText(m) {
  const where = m.type === 'transfer' ? `${locName(m.fromLoc)} ← ${locName(m.toLoc)}`
    : m.toLoc ? locName(m.toLoc) : locName(m.fromLoc);
  return where;
}
function movesTable(list, withDelete) {
  if (!list.length) return `<div class="empty">ما اكو حركات</div>`;
  return `<div class="tbl-wrap"><table>
    <tr><th>الوقت</th><th>النوع</th><th>المادة / الموظف</th><th class="num">الكمية</th><th>المكان</th><th>السبب / ملاحظة</th><th class="num">الكلفة</th>${withDelete ? '<th></th>' : ''}</tr>
    ${list.map(m => `<tr ${m.deleted ? 'style="opacity:.55;text-decoration:line-through"' : ''}>
      ${dtCell(m.ts)}
      <td class="t-${m.type}"><b class="tl">${ico(TYPES[m.type]?.ic)}${TYPES[m.type]?.label || m.type}</b></td>
      <td><b>${esc(mName(m))}</b>${m.editCount ? ' <span class="badge b-warn" title="انعدلت">معدّلة</span>' : ''}${sub(esc(m.staffName))}</td>
      <td class="num">${N(m.qty, m.type === 'adjust')} ${esc(m.unit)}${m.factor > 1 ? `<div class="small muted">${N(m.baseQty)} ${esc(m.baseUnit)}</div>` : ''}</td>
      <td class="small">${esc(moveText(m))}</td>
      <td class="small">${esc([m.supplierName, m.reason, m.ref, m.note].filter(Boolean).join(' — '))}</td>
      <td class="num">${m.cost ? money(m.cost) : ''}</td>
      ${withDelete ? `<td style="white-space:nowrap">${m.invoiceId ? `<button class="link" data-inv="${m.invoiceId}">${ico('purchases')}الفاتورة</button>` : `${m.type !== 'adjust' ? `<button class="link" data-edit="${m.id}">${ico('edit')}تعديل</button>` : ''} <button class="link bad" data-del="${m.id}">${ico('trash')}حذف</button>`}</td>` : ''}
    </tr>`).join('')}
  </table></div>`;
}
function vLog() {
  const f = S.log;
  const list = S.moves.filter(m => m.ts >= dayStartTs(f.from) && m.ts <= dayEndTs(f.to)
    && (!f.type || m.type === f.type) && (!f.staff || m.staffId === f.staff) && (!f.q || mName(m).includes(f.q))).reverse();
  $('#view-root').innerHTML = `
    <div class="topline"><h1>سجل الحركات</h1><button class="btn sm" id="lg-csv">${ico('download')}تصدير</button></div>
    <div class="card">
      <div class="filters">
        <label class="small">من<br><input class="in" type="date" id="f-from" value="${f.from}"></label>
        <label class="small">إلى<br><input class="in" type="date" id="f-to" value="${f.to}"></label>
        <label class="small">النوع<br><select class="in" id="f-type"><option value="">الكل</option>${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
        <label class="small">الموظف<br><select class="in" id="f-staff"><option value="">الكل</option>${S.staff.map(s => `<option value="${s.id}" ${f.staff === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="small">المادة<br><input class="in" id="f-q" value="${esc(f.q)}" placeholder="بحث"></label>
      </div>
      <div class="small muted" style="margin-bottom:8px">${list.length} حركة</div>
      ${movesTable(list.slice(0, 500), canEdit())}
      ${list.length > 500 ? '<div class="hint">يظهر أول 500 حركة — ضيّق التاريخ أو صدّر الملف.</div>' : ''}
    </div>`;
  const on = (id, k) => $(id).onchange = e => { S.log[k] = e.target.value; vLog(); };
  on('#f-from', 'from'); on('#f-to', 'to'); on('#f-type', 'type'); on('#f-staff', 'staff'); on('#f-q', 'q');
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editMove(S.moves.find(x => x.id === b.dataset.edit)));
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteMove(S.moves.find(x => x.id === b.dataset.del)));
  document.querySelectorAll('[data-inv]').forEach(b => b.onclick = () => viewInvoice(S.invoices.find(x => x.id === b.dataset.inv)));
  $('#lg-csv').onclick = () => {
    exportSheet({ file: `سجل_الحركات_${f.from}_${f.to}.xlsx`, title: `${CONFIG.title} — سجل الحركات`, sub: `من ${f.from} إلى ${f.to}   |   ${list.length} حركة`,
      headers: ['التاريخ', 'النوع', 'المادة', 'الكمية', 'الوحدة', 'بالوحدة الأساسية', 'الوحدة الأساسية', 'من', 'إلى', 'سعر الوحدة', 'الكلفة', 'السبب', 'الوصل', 'ملاحظة', 'الموظف'],
      rows: list.map(m => [dt(m.ts), TYPES[m.type]?.label, mName(m), m.qty, m.unit, m.baseQty, m.baseUnit, m.fromLoc ? locName(m.fromLoc) : '', m.toLoc ? locName(m.toLoc) : '', m.price || '', m.cost || '', m.reason, m.ref, m.note, m.staffName]),
      qty: [3, 5], money: [9, 10], totals: { label: 'المجموع', cols: [10] } });
  };
}

/* ═════════════ Edit / delete with audit trail ═════════════ */
const AUD_FIELDS = { unit: 'الوحدة', qty: 'الكمية', price: 'السعر', fromLoc: 'من مكان', toLoc: 'إلى مكان', reason: 'السبب', note: 'ملاحظة', ref: 'الوصل' };
const audVal = (k, v) => (k === 'fromLoc' || k === 'toLoc') ? (v ? locName(v) : '—') : (k === 'qty' || k === 'price') ? fmt(v) : (v || '—');
const moveSnap = m => ({ unit: m.unit, qty: m.qty, factor: m.factor, baseQty: m.baseQty, price: m.price || 0, cost: m.cost || 0, fromLoc: m.fromLoc || '', toLoc: m.toLoc || '', reason: m.reason || '', note: m.note || '', ref: m.ref || '' });
function editMove(m) {
  if (!m || !canEdit()) return;
  if (m.invoiceId) return editInvoice(S.invoices.find(x => x.id === m.invoiceId)); // حركات الفاتورة تتعدل من الفاتورة
  const it = itemById(m.itemId);
  if (!it) return toast('المادة محذوفة من البطاقة', true);
  const locs = activeLocs();
  const needFrom = ['out', 'transfer', 'waste', 'return'].includes(m.type), needTo = ['in', 'transfer', 'opening'].includes(m.type), needPrice = ['in', 'opening'].includes(m.type);
  const reasons = m.type === 'out' ? OUT_REASONS : m.type === 'waste' ? WASTE_REASONS : null;
  const lo = sel => locs.map(l => `<option value="${l.id}" ${sel === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  modal(`<h2>تعديل حركة ${TYPES[m.type].label}</h2>
    <p class="small muted" style="margin-top:-6px">${esc(mName(m))} — سجّلها ${esc(m.staffName)} بتاريخ ${dt(m.ts)}<br>نوع الحركة والمادة ما يتغيرن؛ إذا غلط احذف الحركة وسجّل وحدة جديدة.</p>
    <div class="row">
      <div class="field"><label>الوحدة</label><select class="in" id="e-u">${unitsOf(it).map(u => `<option ${m.unit === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></div>
      <div class="field"><label>الكمية</label><input class="in" id="e-q" type="number" min="0" step="any" value="${m.qty}"></div>
    </div>
    <div class="row">
      ${needFrom ? `<div class="field"><label>${m.type === 'transfer' ? 'من مكان' : 'المكان'}</label><select class="in" id="e-f">${lo(m.fromLoc)}</select></div>` : ''}
      ${needTo ? `<div class="field"><label>${m.type === 'transfer' ? 'إلى مكان' : 'يدخل إلى'}</label><select class="in" id="e-t">${lo(m.toLoc)}</select></div>` : ''}
    </div>
    ${needPrice ? `<div class="row"><div class="field"><label>سعر الوحدة</label><input class="in" id="e-p" type="number" min="0" step="any" value="${m.price || ''}"></div><div class="field"><label>الوصل / المورد</label><input class="in" id="e-r" value="${esc(m.ref)}"></div></div>` : ''}
    ${reasons ? `<div class="field"><label>السبب</label><select class="in" id="e-rs">${reasons.map(r => `<option ${m.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label>ملاحظة</label><input class="in" id="e-n" value="${esc(m.note)}"></div>
    <div class="field"><label>سبب التعديل <span class="req">*</span></label><input class="in" id="e-why" placeholder="مثلاً: الكمية انكتبت غلط"></div>
    <div class="foot"><button class="btn" id="e-s">${ico('save')}حفظ التعديل</button><button class="btn ghost" id="e-c">إلغاء</button></div>`,
    (md, close) => {
      md.querySelector('#e-c').onclick = close;
      md.querySelector('#e-s').onclick = async () => {
        const g = id => md.querySelector(id)?.value;
        const unit = g('#e-u'), qty = +g('#e-q') || 0, why = g('#e-why').trim();
        if (!(qty > 0)) return toast('اكتب الكمية', true);
        if (!why) return toast('اكتب سبب التعديل', true);
        const fromLoc = needFrom ? g('#e-f') : '', toLoc = needTo ? g('#e-t') : '';
        if (m.type === 'transfer' && fromLoc === toLoc) return toast('مكان النقل لازم يختلف', true);
        const price = needPrice ? (+g('#e-p') || 0) : 0;
        if (needPrice && !(price > 0)) return toast('اكتب السعر', true);
        const factor = unit === it.bigUnit ? packOf(it) : 1;
        const after = { unit, qty: r3(qty), factor, baseQty: r3(qty * factor), price, cost: needPrice ? Math.round(price * qty) : 0, fromLoc, toLoc,
          reason: reasons ? g('#e-rs') : (m.reason || ''), note: (g('#e-n') || '').trim(), ref: needPrice ? (g('#e-r') || '').trim() : (m.ref || '') };
        const before = moveSnap(m);
        const changed = Object.keys(AUD_FIELDS).filter(k => String(before[k] ?? '') !== String(after[k] ?? ''));
        if (!changed.length) return toast('ما غيّرت شي', true);
        const aid = B.newId();
        await B.batch([
          { type: 'set', col: 'audit', id: aid, data: { ts: Date.now(), action: 'edit', moveId: m.id, moveType: m.type, itemId: m.itemId, itemName: mName(m), moveTs: m.ts, moveStaff: m.staffName, by: S.user.name, byId: S.user.id, why, changed, before, after } },
          { type: 'update', col: 'moves', id: m.id, data: { ...after, lastAuditId: aid, editCount: (m.editCount || 0) + 1, editedBy: S.user.name, editedAt: Date.now() } }
        ]);
        close(); toast('✔ انعدلت الحركة وانسجل التعديل');
      };
    });
}
function deleteMove(m) {
  if (!m || !canEdit()) return;
  if (m.invoiceId) return deleteInvoice(S.invoices.find(x => x.id === m.invoiceId));
  modal(`<h2>حذف حركة</h2>
    <p><b>${TYPES[m.type].label}</b> — ${esc(mName(m))} ${N(m.qty)} ${esc(m.unit)}<br><span class="small muted">سجّلها ${esc(m.staffName)} بتاريخ ${dt(m.ts)}</span></p>
    <p class="small">الحركة تنشال من الأرصدة والسجل، وتروح لخانة «المحذوفات» باسمك.</p>
    <div class="field"><label>سبب الحذف <span class="req">*</span></label><input class="in" id="d-why" placeholder="مثلاً: انسجلت مرتين"></div>
    <div class="foot"><button class="btn danger" id="d-s">حذف</button><button class="btn ghost" id="d-c">إلغاء</button></div>`,
    (md, close) => {
      md.querySelector('#d-c').onclick = close;
      md.querySelector('#d-s').onclick = async () => {
        const why = md.querySelector('#d-why').value.trim();
        if (!why) return toast('اكتب سبب الحذف', true);
        const aid = B.newId();
        await B.batch([
          { type: 'set', col: 'audit', id: aid, data: { ts: Date.now(), action: 'delete', moveId: m.id, moveType: m.type, itemId: m.itemId, itemName: mName(m), moveTs: m.ts, moveStaff: m.staffName, by: S.user.name, byId: S.user.id, why, before: moveSnap(m) } },
          { type: 'update', col: 'moves', id: m.id, data: { deleted: true, deletedBy: S.user.name, deletedAt: Date.now(), lastAuditId: aid } }
        ]);
        close(); toast('انحذفت الحركة وانسجلت بالمحذوفات');
      };
    });
}
const audWhat = x => x.kind === 'invoice'
  ? `<td class="t-in"><b class="tl">${ico('purchases')}فاتورة مشتريات</b> — ${esc(x.supplierName)}${sub(x.ref ? 'وصل ' + esc(x.ref) : '')}</td>`
  : x.kind === 'image' ? `<td class="t-in"><b class="tl">${ico('image')}صورة فاتورة</b> — ${esc(x.supplierName)}${sub(x.ref ? 'وصل ' + esc(x.ref) : '')}</td>`
  : `<td class="t-transfer"><b class="tl">${ico('wallet')}تسديد</b> — ${esc(x.supplierName)}</td>`;
function vAudit() {
  const a = S.aud;
  const inRange = x => x.ts >= dayStartTs(a.from) && x.ts <= dayEndTs(a.to);
  const edits = S.audit.filter(x => x.action === 'edit' && inRange(x)).sort((p, q) => q.ts - p.ts);
  const dels = S.audit.filter(x => x.action === 'delete' && inRange(x)).sort((p, q) => q.ts - p.ts);
  const where = (t, b) => t === 'transfer' ? `${locName(b.fromLoc)} ← ${locName(b.toLoc)}` : locName(b.toLoc || b.fromLoc);
  $('#view-root').innerHTML = `
    <div class="topline"><h1>التعديلات والحذف</h1>
      <div class="filters" style="margin:0"><label class="small">من<br><input class="in" type="date" id="a-from" value="${a.from}"></label><label class="small">إلى<br><input class="in" type="date" id="a-to" value="${a.to}"></label></div></div>
    <div class="tabs">
      <button data-at="edit" class="${a.tab === 'edit' ? 'on' : ''}">التعديلات (${edits.length})</button>
      <button data-at="delete" class="${a.tab === 'delete' ? 'on' : ''}">المحذوفات (${dels.length})</button>
    </div>
    <div class="card"><div class="tbl-wrap">
    ${a.tab === 'edit' ? (edits.length ? `<table>
      <tr><th>وقت التعديل</th><th>منو عدّل</th><th>الحركة</th><th>شنو تغيّر</th><th>السبب</th><th>سجّلها أصلاً</th></tr>
      ${edits.map(x => `<tr>${dtCell(x.ts)}<td><b>${esc(x.by)}</b></td>
        ${x.kind ? audWhat(x) : `<td class="t-${x.moveType}"><b>${TYPES[x.moveType]?.label || ''}</b> — ${esc(x.itemName)}</td>`}
        <td class="small">${x.kind ? (x.summary || []).map(esc).join('<br>') : ''}${(x.changed || []).map(k => `${AUD_FIELDS[k]}: <span style="text-decoration:line-through;color:var(--bad)">${esc(audVal(k, x.before?.[k]))}</span> ← <b>${esc(audVal(k, x.after?.[k]))}</b>`).join('<br>')}</td>
        <td class="small">${esc(x.why)}</td><td class="small">${esc(x.moveStaff)}<br><span class="muted">${dt(x.moveTs)}</span></td></tr>`).join('')}
    </table>` : '<div class="empty">ما اكو تعديلات بهذي الفترة</div>')
    : (dels.length ? `<table>
      <tr><th>وقت الحذف</th><th>منو حذف</th><th>الحركة المحذوفة</th><th class="num">الكمية</th><th>المكان</th><th>السبب</th><th>سجّلها أصلاً</th></tr>
      ${dels.map(x => `<tr>${dtCell(x.ts)}<td><b>${esc(x.by)}</b></td>
        ${x.kind === 'image' ? `${audWhat(x)}<td class="num">${Math.round((x.before?.bytes || 0) / 1024)}KB</td><td class="small"></td>`
        : x.kind ? `${audWhat(x)}<td class="num">${M(x.kind === 'invoice' ? x.before?.total : x.before?.amount)} د.ع</td><td class="small">${esc(x.kind === 'invoice' ? locName(x.before?.locId) + ' — ' + (x.before?.lines || []).length + ' مادة' : PAY_METHODS[x.before?.method] || '')}</td>`
        : `<td class="t-${x.moveType}"><b>${TYPES[x.moveType]?.label || ''}</b> — ${esc(x.itemName)}</td>
        <td class="num">${N(x.before?.qty)} ${esc(x.before?.unit)}</td><td class="small">${esc(where(x.moveType, x.before || {}))}</td>`}
        <td class="small">${esc(x.why)}</td><td class="small">${esc(x.moveStaff)}<br><span class="muted">${dt(x.moveTs)}</span></td></tr>`).join('')}
    </table>` : '<div class="empty">ما اكو محذوفات بهذي الفترة</div>')}
    </div></div>`;
  document.querySelectorAll('[data-at]').forEach(b => b.onclick = () => { S.aud.tab = b.dataset.at; vAudit(); });
  $('#a-from').onchange = e => { S.aud.from = e.target.value; vAudit(); };
  $('#a-to').onchange = e => { S.aud.to = e.target.value; vAudit(); };
}

/* ═════════════ Stocktake ═════════════ */
function vStocktake() {
  const locs = activeLocs();
  if (!S.st.loc || !locById(S.st.loc)) S.st.loc = locs[0]?.id || '';
  const L = S.st.loc;
  const bal = balances();
  const items = activeItems().filter(it => Math.abs(bal.get(it.id + '|' + L) || 0) > 0.0005 || S.moves.some(m => m.itemId === it.id && (m.fromLoc === L || m.toLoc === L)));
  const past = S.stocktakes.slice().sort((a, b) => b.ts - a.ts).slice(0, 10);
  $('#view-root').innerHTML = `
    <div class="topline"><h1>الجرد الفعلي</h1></div>
    ${locs.length ? `
    <div class="chips">${locs.map(l => `<button data-l="${l.id}" class="${L === l.id ? 'on' : ''}">${esc(l.name)}</button>`).join('')}</div>
    <div class="card">
      <p class="small muted" style="margin-top:0">اكتب العدد الموجود فعلاً بهذا المكان. المواد اللي تتركها فارغة ما تنجرد. عند الحفظ، الفرق يتسجل كحركة «تسوية جرد» والرصيد يصير مطابق للواقع.</p>
      ${items.length ? `<div class="tbl-wrap"><table>
        <tr><th>المادة</th><th class="num">الدفتري</th><th>العدد: وحدة كبيرة</th><th>العدد: وحدة أساسية</th><th class="num">الفعلي</th><th class="num">الفرق</th><th class="num">قيمة الفرق</th></tr>
        ${items.map(it => { const c = S.st.counts[it.id] || {}; return `<tr data-row="${it.id}">
          <td><b>${esc(it.name)}</b>${sub(esc(grpOf(it)))}</td>
          <td class="num">${N(bal.get(it.id + '|' + L) || 0)} ${esc(it.baseUnit)}</td>
          <td>${packOf(it) > 1 ? `<input class="in" style="width:90px" type="number" inputmode="decimal" min="0" step="any" data-big="${it.id}" value="${esc(c.big ?? '')}"> <span class="small muted">${esc(it.bigUnit)} (${fmt(packOf(it))})</span>` : '<span class="muted">—</span>'}</td>
          <td><input class="in" style="width:90px" type="number" inputmode="decimal" min="0" step="any" data-small="${it.id}" value="${esc(c.small ?? '')}"> <span class="small muted">${esc(it.baseUnit)}</span></td>
          <td class="num" data-cnt="${it.id}"></td><td class="num" data-var="${it.id}"></td><td class="num" data-val="${it.id}"></td></tr>`; }).join('')}
      </table></div>
      <div style="display:flex;gap:12px;align-items:center;margin-top:14px;flex-wrap:wrap">
        <button class="btn" id="st-save">${ico('save')}حفظ الجرد وتسوية الأرصدة</button>
        <span id="st-sum" class="small"></span>
      </div>` : `<div class="empty">ما اكو مواد بهذا المكان بعد.</div>`}
    </div>` : `<div class="card empty">أضف أماكن الخزن أولاً من الإدارة.</div>`}
    <div class="card"><h2>جرودات سابقة</h2>
      ${past.length ? `<div class="tbl-wrap"><table><tr><th>التاريخ</th><th>المكان</th><th class="num">مواد مجرودة</th><th class="num">مواد بيها فرق</th><th class="num">قيمة العجز</th><th class="num">قيمة الزيادة</th><th>بواسطة</th></tr>
        ${past.map(s => `<tr>${dtCell(s.ts)}<td>${esc(locName(s.locId))}</td><td class="num">${s.counted}</td><td class="num">${s.diffs}</td><td class="num neg">${M(s.shortValue)}</td><td class="num">${M(s.overValue)}</td><td class="small">${esc(s.staffName)}</td></tr>`).join('')}
      </table></div>` : `<div class="empty">ما اكو جرد سابق</div>`}
    </div>`;
  document.querySelectorAll('[data-l]').forEach(b => b.onclick = async () => {
    if (Object.keys(S.st.counts).length && !(await confirmBox('عندك أرقام جرد ما محفوظة. تتركها؟', 'نعم'))) return;
    S.st = { loc: b.dataset.l, counts: {} }; vStocktake();
  });
  const upd = (id, k, v) => { S.st.counts[id] = { ...(S.st.counts[id] || {}), [k]: v }; if (S.st.counts[id].big === '' && S.st.counts[id].small === '') delete S.st.counts[id]; stRefresh(); };
  document.querySelectorAll('[data-big]').forEach(i => i.oninput = () => upd(i.dataset.big, 'big', i.value));
  document.querySelectorAll('[data-small]').forEach(i => i.oninput = () => upd(i.dataset.small, 'small', i.value));
  if ($('#st-save')) $('#st-save').onclick = saveStocktake;
  stRefresh();
}
function stLines() {
  const L = S.st.loc, bal = balances(), avg = avgCosts();
  return Object.entries(S.st.counts).map(([id, c]) => {
    const it = itemById(id); if (!it) return null;
    if ((c.big ?? '') === '' && (c.small ?? '') === '') return null;
    const counted = r3((+c.big || 0) * packOf(it) + (+c.small || 0));
    const book = r3(bal.get(id + '|' + L) || 0);
    const v = r3(counted - book);
    return { it, counted, book, v, value: v * (avg.get(id) || 0) };
  }).filter(Boolean);
}
function stRefresh() {
  if (S.view !== 'stocktake') return;
  const lines = stLines(), byId = Object.fromEntries(lines.map(l => [l.it.id, l]));
  document.querySelectorAll('[data-cnt]').forEach(td => {
    const id = td.dataset.cnt, l = byId[id];
    td.innerHTML = l ? N(l.counted) : '';
    const vt = document.querySelector(`[data-var="${id}"]`), vv = document.querySelector(`[data-val="${id}"]`);
    vt.innerHTML = l ? N(l.v, true) : ''; vt.className = 'num' + (l && l.v < 0 ? ' neg' : '');
    vv.innerHTML = l && l.v ? M(l.value) : ''; vv.className = 'num' + (l && l.v < 0 ? ' neg' : '');
  });
  const s = $('#st-sum');
  if (s) {
    const short = lines.filter(l => l.v < 0).reduce((a, l) => a + l.value, 0), over = lines.filter(l => l.v > 0).reduce((a, l) => a + l.value, 0);
    s.innerHTML = lines.length ? `مجرود: <b>${lines.length}</b> — بيها فرق: <b>${lines.filter(l => l.v).length}</b> — عجز: <b style="color:var(--bad)">${M(short)}</b> — زيادة: <b>${M(over)}</b> د.ع` : '';
  }
}
async function saveStocktake() {
  const lines = stLines(), L = S.st.loc;
  if (!lines.length) return toast('ما كتبت أي عدد', true);
  const diffs = lines.filter(l => Math.abs(l.v) > 0.0005);
  if (!(await confirmBox(`حفظ جرد <b>${esc(locName(L))}</b>: ${lines.length} مادة، ${diffs.length} بيها فرق. الفروقات راح تتسجل كتسوية.`, 'حفظ'))) return;
  const ts = Date.now();
  $('#st-save').disabled = true;
  try {
    await B.addMany('moves', diffs.map(l => ({
      ts, type: 'adjust', itemId: l.it.id, itemName: l.it.name, unit: l.it.baseUnit, qty: l.v, factor: 1, baseQty: l.v, baseUnit: l.it.baseUnit,
      price: 0, cost: 0, fromLoc: '', toLoc: L, reason: l.v < 0 ? 'عجز بالجرد' : 'زيادة بالجرد', ref: '', note: `دفتري ${fmt(l.book)} / فعلي ${fmt(l.counted)}`,
      staffId: S.user.id, staffName: S.user.name
    })));
    await B.add('stocktakes', {
      ts, locId: L, staffId: S.user.id, staffName: S.user.name, counted: lines.length, diffs: diffs.length,
      shortValue: Math.round(diffs.filter(l => l.v < 0).reduce((a, l) => a + l.value, 0)),
      overValue: Math.round(diffs.filter(l => l.v > 0).reduce((a, l) => a + l.value, 0)),
      lines: lines.map(l => ({ itemId: l.it.id, itemName: l.it.name, book: l.book, counted: l.counted, variance: l.v, value: Math.round(l.value) }))
    });
  } catch (e) { $('#st-save').disabled = false; return toast('ما انحفظ: ' + e.message, true); }
  S.st.counts = {};
  toast('✔ انحفظ الجرد وتعدلت الأرصدة');
  vStocktake();
}

/* ═════════════ Reports ═════════════ */
function vReports() {
  const [y, mo] = S.rep.month.split('-').map(Number);
  const t0 = new Date(y, mo - 1, 1).getTime(), t1 = new Date(y, mo, 1).getTime();
  const avg = avgCosts();
  const rows = activeItems().map(it => {
    const r = { it, open: 0, in: 0, out: 0, waste: 0, return: 0, adjust: 0, inCost: 0 };
    for (const m of S.moves) {
      if (m.itemId !== it.id || m.type === 'transfer') continue;
      const q = +m.baseQty || 0;
      const sign = (m.type === 'in' || m.type === 'opening' || m.type === 'adjust') ? 1 : -1;
      if (m.ts < t0) r.open += sign * q;
      else if (m.ts < t1) {
        if (m.type === 'opening') r.in += q; else r[m.type] += q;
        if (m.type === 'in' || m.type === 'opening') r.inCost += +m.cost || 0;
      }
    }
    r.close = r.open + r.in - r.out - r.waste - r.return + r.adjust;
    r.avg = avg.get(it.id) || 0;
    return r;
  }).filter(r => [r.open, r.in, r.out, r.waste, r.return, r.adjust].some(v => Math.abs(v) > 0.0005));
  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const purchases = sum('inCost');
  const consumption = rows.reduce((a, r) => a + r.out * r.avg, 0);
  const waste = rows.reduce((a, r) => a + r.waste * r.avg, 0);
  const adj = rows.reduce((a, r) => a + r.adjust * r.avg, 0);
  const closeVal = rows.reduce((a, r) => a + Math.max(r.close, 0) * r.avg, 0);
  $('#view-root').innerHTML = `
    <div class="topline"><h1>التقرير الشهري</h1>
      <div style="display:flex;gap:8px"><input class="in" type="month" id="rp-m" value="${S.rep.month}" style="width:170px"><button class="btn sm" id="rp-csv">${ico('download')}تصدير</button></div></div>
    <div class="kpis">
      <div class="kpi"><div class="l">المشتريات</div><div class="v">${M(purchases)}</div></div>
      <div class="kpi"><div class="l">كلفة المصروف</div><div class="v">${M(consumption)}</div></div>
      <div class="kpi bad"><div class="l">خسائر التالف</div><div class="v">${M(waste)}</div></div>
      <div class="kpi ${adj < 0 ? 'bad' : ''}"><div class="l">فروقات الجرد</div><div class="v">${M(adj)}</div></div>
      <div class="kpi"><div class="l">قيمة المخزون آخر الشهر</div><div class="v">${M(closeVal)}</div></div>
    </div>
    <div class="card"><div class="tbl-wrap">${rows.length ? `<table>
      <tr><th>المادة</th><th class="num">أول المدة</th><th class="num">الوارد</th><th class="num">المصروف</th><th class="num">التالف</th><th class="num">المرتجع</th><th class="num">تسوية الجرد</th><th class="num">آخر المدة</th><th class="num">متوسط الكلفة</th><th class="num">كلفة المصروف</th></tr>
      ${rows.map(r => `<tr><td><b>${esc(r.it.name)}</b>${sub(esc(r.it.baseUnit + ' — ' + grpOf(r.it)))}</td><td class="num">${N(r.open)}</td><td class="num">${N(r.in)}</td><td class="num">${N(r.out)}</td><td class="num">${N(r.waste)}</td><td class="num">${N(r.return)}</td><td class="num ${r.adjust < 0 ? 'neg' : ''}">${N(r.adjust)}</td><td class="num"><b>${N(r.close)}</b></td><td class="num">${M(r.avg)}</td><td class="num">${M(r.out * r.avg)}</td></tr>`).join('')}
    </table>` : `<div class="empty">ما اكو حركات بهذا الشهر</div>`}</div>
    <p class="hint">النقل بين الأماكن ما يأثر على التقرير لأن المادة باقية بالمخزن. متوسط الكلفة = كل كلفة المشتريات ÷ كل الكميات الواردة.</p></div>`;
  $('#rp-m').onchange = e => { S.rep.month = e.target.value || today().slice(0, 7); vReports(); };
  $('#rp-csv').onclick = () => exportSheet({ file: `تقرير_المخزن_${S.rep.month}.xlsx`, title: `${CONFIG.title} — التقرير الشهري`, sub: `شهر ${S.rep.month}   |   المشتريات: ${money(purchases)}   |   كلفة المصروف: ${money(consumption)}   |   التالف: ${money(waste)}   |   فروقات الجرد: ${money(adj)}`,
    headers: ['المادة', 'الوحدة', 'أول المدة', 'الوارد', 'المصروف', 'التالف', 'المرتجع', 'تسوية الجرد', 'آخر المدة', 'متوسط الكلفة', 'كلفة المصروف', 'كلفة التالف', 'قيمة آخر المدة'],
    rows: rows.map(r => [r.it.name, r.it.baseUnit, r3(r.open), r3(r.in), r3(r.out), r3(r.waste), r3(r.return), r3(r.adjust), r3(r.close), Math.round(r.avg), Math.round(r.out * r.avg), Math.round(r.waste * r.avg), Math.round(Math.max(r.close, 0) * r.avg)]),
    qty: [2, 3, 4, 5, 6, 7, 8], money: [9, 10, 11, 12], totals: { label: 'المجموع', cols: [10, 11, 12] } });
}

/* ═════════════ Purchases: suppliers, invoices, payments ═════════════ */
const PAY_MODES = { paid: 'مدفوعة بالكامل', credit: 'آجل', partial: 'دفع جزئي' };
const PAY_METHODS = { cash: 'كاش', transfer: 'تحويل' };
const liveInv = () => S.invoices.filter(x => !x.deleted);
const livePay = () => S.payments.filter(x => !x.deleted);
const supById = id => S.suppliers.find(s => s.id === id);
const supName = x => supById(x.supplierId)?.name || x.supplierName || '—';
const activeSups = () => S.suppliers.filter(s => s.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
// تاريخ (YYYY-MM-DD) → ts: اليوم = الوقت الحالي، غير يوم = الظهر
const dateTs = d => d === today() ? Date.now() : new Date(d + 'T12:00:00').getTime();
// المتبقي بذمتي للمورد = (إجمالي الفواتير − المدفوع منها) − التسديدات
function supDue(id, upTo = Infinity) {
  let due = 0;
  for (const v of liveInv()) if (v.supplierId === id && v.ts <= upTo) due += (+v.total || 0) - (+v.paid || 0);
  for (const p of livePay()) if (p.supplierId === id && p.ts <= upTo) due -= +p.amount || 0;
  return due;
}

/* ── invoice form state & math ── */
const newLine = () => ({ itemId: '', unit: '', qty: '', price: '', q: '' });
function newInv() {
  const locs = activeLocs();
  return { supplierId: '', ref: '', date: today(), locId: locs.length === 1 ? locs[0].id : (S.inv?.locId || ''), note: '', lines: [newLine()], transport: '', loading: '', discount: '', payMode: 'credit', paid: '', imgs: [] };
}
function invCalc(inv) {
  const lines = inv.lines.map(l => {
    const it = itemById(l.itemId), qty = +l.qty || 0, price = +l.price || 0;
    const factor = it && l.unit && l.unit === it.bigUnit ? packOf(it) : 1;
    return { ...l, it, qty, price, factor, baseQty: r3(qty * factor), total: qty * price };
  });
  const subtotal = lines.reduce((a, l) => a + l.total, 0);
  const transport = +inv.transport || 0, loading = +inv.loading || 0, discount = +inv.discount || 0;
  const net = transport + loading - discount; // يتوزع على الأسطر بنسبة قيمة كل سطر
  lines.forEach(l => { l.share = subtotal > 0 ? net * l.total / subtotal : 0; l.cost = l.total + l.share; });
  const total = subtotal + transport + loading - discount;
  const paid = inv.payMode === 'paid' ? total : inv.payMode === 'credit' ? 0 : Math.min(+inv.paid || 0, total);
  return { lines, subtotal, transport, loading, discount, total, paid, due: total - paid };
}
const invSnap = v => ({ supplierId: v.supplierId, supplierName: v.supplierName, ref: v.ref || '', date: v.date, locId: v.locId, note: v.note || '', transport: v.transport || 0, loading: v.loading || 0, discount: v.discount || 0, subtotal: v.subtotal, total: v.total, payMode: v.payMode, paid: v.paid,
  lines: (v.lines || []).map(l => ({ moveId: l.moveId, itemId: l.itemId, itemName: l.itemName, unit: l.unit, qty: l.qty, price: l.price, total: l.total })) });
function invDiff(a, b) {
  const out = [], f = (label, x, y) => { if (String(x ?? '') !== String(y ?? '')) out.push(`${label}: ${x || '—'} ← ${y || '—'}`); };
  f('المورد', a.supplierName, b.supplierName); f('رقم الوصل', a.ref, b.ref); f('التاريخ', a.date, b.date); f('المخزن', locName(a.locId), locName(b.locId)); f('ملاحظة', a.note, b.note);
  f('النقل', money(a.transport), money(b.transport)); f('التحميل', money(a.loading), money(b.loading)); f('الخصم', money(a.discount), money(b.discount));
  f('الدفع', PAY_MODES[a.payMode], PAY_MODES[b.payMode]); f('المدفوع', money(a.paid), money(b.paid)); f('الإجمالي', money(a.total), money(b.total));
  const key = l => l.moveId || l.itemId;
  const am = new Map(a.lines.map(l => [key(l), l])), bm = new Map(b.lines.map(l => [key(l), l]));
  for (const [k, l] of am) {
    const n = bm.get(k);
    if (!n) out.push(`شال سطر: ${l.itemName} ${fmt(l.qty)} ${l.unit}`);
    else if (n.itemId !== l.itemId || n.unit !== l.unit || +n.qty !== +l.qty || +n.price !== +l.price) out.push(`${l.itemName}: ${fmt(l.qty)} ${l.unit} × ${money(l.price)} ← ${n.itemName}: ${fmt(n.qty)} ${n.unit} × ${money(n.price)}`);
  }
  for (const [k, l] of bm) if (!am.has(k)) out.push(`ضاف سطر: ${l.itemName} ${fmt(l.qty)} ${l.unit} × ${money(l.price)}`);
  return out;
}

/* ── screen ── */
function vPurch() {
  const P = S.pur;
  if (P.sup) return vSupplier();
  if (P.tab === 'new' && !S.inv) S.inv = newInv();
  const editing = P.tab === 'new' && S.inv?.id;
  $('#view-root').innerHTML = `
    <div class="topline"><h1>المشتريات</h1>${modeTag()}</div>
    <div class="tabs">
      <button data-pt="new" class="${P.tab === 'new' ? 'on' : ''}">${ico(editing ? 'edit' : 'plus')}${editing ? 'تعديل فاتورة' : 'فاتورة جديدة'}</button>
      <button data-pt="list" class="${P.tab === 'list' ? 'on' : ''}">${ico('log')}الفواتير</button>
      <button data-pt="sups" class="${P.tab === 'sups' ? 'on' : ''}">${ico('user')}الموردين</button>
    </div>
    <div id="pur"></div>`;
  document.querySelectorAll('[data-pt]').forEach(b => b.onclick = async () => {
    if (P.tab === 'new' && S.inv?.id && b.dataset.pt !== 'new' && !(await confirmBox('تترك تعديل الفاتورة بدون حفظ؟', 'نعم'))) return;
    if (P.tab === 'new' && S.inv?.id && b.dataset.pt !== 'new') S.inv = null;
    P.tab = b.dataset.pt; vPurch();
  });
  ({ new: vInvForm, list: vInvList, sups: () => vSuppliers($('#pur')) })[P.tab]();
}

function vInvForm() {
  const inv = S.inv, sups = activeSups(), locs = activeLocs();
  const old = inv.id ? S.invoices.find(x => x.id === inv.id) : null;
  if (old && old.supplierId && !sups.some(s => s.id === old.supplierId) && supById(old.supplierId)) sups.push(supById(old.supplierId));
  const lineRow = (l, i) => {
    const it = itemById(l.itemId);
    return `<div class="iline" data-row="${i}">
      <div class="field il-item"><label>المادة <span class="req">*</span></label>
        ${it ? `<div class="sel-item"><span>${esc(it.name)}</span><button class="link" data-clr="${i}">تغيير</button></div>`
             : `<div class="picker"><input class="in" data-pick="${i}" placeholder="اكتب اسم المادة…" autocomplete="off" value="${esc(l.q)}"><div class="list" hidden></div></div>`}
      </div>
      <div class="field"><label>الوحدة</label><select class="in" data-k="unit" data-i="${i}" ${it ? '' : 'disabled'}>${unitsOf(it).map(u => `<option ${l.unit === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></div>
      <div class="field"><label>الكمية <span class="req">*</span></label><input class="in" data-k="qty" data-i="${i}" type="number" inputmode="decimal" min="0" step="any" value="${esc(l.qty)}" placeholder="0"></div>
      <div class="field"><label>سعر الوحدة <span class="req">*</span></label><input class="in" data-k="price" data-i="${i}" type="number" inputmode="decimal" min="0" step="any" value="${esc(l.price)}" placeholder="0"></div>
      <div class="field il-tot"><label>الإجمالي</label><div class="il-sum" data-tot="${i}"></div></div>
      <button class="il-del" data-del="${i}" aria-label="حذف السطر" ${inv.lines.length < 2 ? 'disabled' : ''}>${ico('trash')}</button>
    </div>`;
  };
  $('#pur').innerHTML = `
    <div class="card">
      ${inv.id ? `<p class="hint" style="margin-top:0">تعديل فاتورة ${esc(supName(old || inv))} ${old?.ref ? '— وصل ' + esc(old.ref) : ''}. التعديل ينسجل بسجل التعديلات وحركات الوارد تتحدّث وياه.</p>` : ''}
      <h2>${ico('purchases')} رأس الفاتورة</h2>
      <div class="row">
        <div class="field"><label>المورد <span class="req">*</span></label>
          ${sups.length ? `<select class="in" id="iv-sup"><option value="">— اختر —</option>${sups.map(s => `<option value="${s.id}" ${inv.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : `<div class="hint bad" style="margin-top:0">ما اكو موردين بعد.</div>`}
          <button class="link" id="iv-newsup">${ico('plus')}مورد جديد</button>
        </div>
        <div class="field"><label>رقم الوصل</label><input class="in" id="iv-ref" value="${esc(inv.ref)}"></div>
      </div>
      <div class="row">
        <div class="field"><label>التاريخ <span class="req">*</span></label><input class="in" id="iv-date" type="date" max="${today()}" value="${esc(inv.date)}"></div>
        <div class="field"><label>المخزن <span class="req">*</span></label><select class="in" id="iv-loc"><option value="">— اختر —</option>${locs.map(l => `<option value="${l.id}" ${inv.locId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>ملاحظة</label><input class="in" id="iv-note" value="${esc(inv.note)}"></div>
    </div>
    <div class="card">
      <h2>${ico('stock')} المواد</h2>
      <div id="iv-lines">${inv.lines.map(lineRow).join('')}</div>
      <button class="btn ghost" id="iv-add">${ico('plus')}سطر جديد</button>
    </div>
    <div class="card">
      <div class="card-head"><h2>${ico('camera')} صور الفاتورة</h2>${pickButtons('iv')}</div>
      ${old && +old.imageCount > 0 ? `<p class="hint" style="margin-top:0">بالفاتورة ${old.imageCount} صورة محفوظة (تنعرض من «عرض» الفاتورة). الصور اللي تضيفها هنا تنضاف وياها.</p>` : ''}
      <div id="iv-imgs">${thumbsHtml((inv.imgs || []).map(x => ({ ...x, pending: true })), { removable: true })}</div>
    </div>
    <div class="two">
      <div class="card">
        <h2>${ico('wallet')} مبالغ إضافية وخصم</h2>
        <div class="row3">
          <div class="field"><label>نقل</label><input class="in" id="iv-transport" type="number" inputmode="decimal" min="0" step="any" value="${esc(inv.transport)}" placeholder="0"></div>
          <div class="field"><label>تحميل</label><input class="in" id="iv-loading" type="number" inputmode="decimal" min="0" step="any" value="${esc(inv.loading)}" placeholder="0"></div>
          <div class="field"><label>خصم</label><input class="in" id="iv-discount" type="number" inputmode="decimal" min="0" step="any" value="${esc(inv.discount)}" placeholder="0"></div>
        </div>
        <p class="hint" style="margin-top:0">النقل والتحميل والخصم يتوزعن على كلفة المواد بنسبة قيمة كل سطر.</p>
        <h2 style="margin-top:8px">${ico('check')} طريقة الدفع</h2>
        <div class="seg paymode">${Object.entries(PAY_MODES).map(([k, t]) => `<button data-pm="${k}" class="${inv.payMode === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        ${inv.payMode === 'partial' ? `<div class="field"><label>المبلغ المدفوع <span class="req">*</span></label><input class="in" id="iv-paid" type="number" inputmode="decimal" min="0" step="any" value="${esc(inv.paid)}"></div>` : ''}
      </div>
      <div class="card totbox" id="iv-totals"></div>
    </div>
    <button class="btn big t-in" id="iv-save">${ico('save')}${inv.id ? 'حفظ تعديل الفاتورة' : 'حفظ الفاتورة'}</button>
    ${inv.id ? `<button class="btn ghost" id="iv-cancel" style="width:100%;margin-top:10px">إلغاء التعديل</button>` : ''}`;

  const bindH = (id, k) => { const el = $(id); if (el) el.oninput = el.onchange = () => { inv[k] = el.value; invRefresh(); }; };
  bindH('#iv-sup', 'supplierId'); bindH('#iv-ref', 'ref'); bindH('#iv-date', 'date'); bindH('#iv-loc', 'locId'); bindH('#iv-note', 'note');
  bindH('#iv-transport', 'transport'); bindH('#iv-loading', 'loading'); bindH('#iv-discount', 'discount'); bindH('#iv-paid', 'paid');
  document.querySelectorAll('#iv-lines [data-k]').forEach(el => el.oninput = el.onchange = () => { inv.lines[+el.dataset.i][el.dataset.k] = el.value; invRefresh(); });
  document.querySelectorAll('[data-pm]').forEach(b => b.onclick = () => { inv.payMode = b.dataset.pm; vInvForm(); });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { inv.lines.splice(+b.dataset.del, 1); vInvForm(); });
  document.querySelectorAll('[data-clr]').forEach(b => b.onclick = () => { const l = inv.lines[+b.dataset.clr]; l.itemId = ''; l.unit = ''; l.q = ''; vInvForm(); document.querySelector(`[data-pick="${b.dataset.clr}"]`)?.focus(); });
  document.querySelectorAll('[data-pick]').forEach(setupLinePicker);
  $('#iv-add').onclick = () => { inv.lines.push(newLine()); vInvForm(); document.querySelector(`[data-pick="${inv.lines.length - 1}"]`)?.focus(); };
  $('#iv-newsup').onclick = () => supplierForm(null, id => { inv.supplierId = id; vInvForm(); });
  $('#iv-save').onclick = saveInvoice;
  bindPick($('#pur'), 'iv', imgs => { inv.imgs = [...(inv.imgs || []), ...imgs]; drawFormImgs(); });
  drawFormImgs();
  if ($('#iv-cancel')) $('#iv-cancel').onclick = () => { S.inv = null; S.pur.tab = 'list'; vPurch(); };
  invRefresh();
}
function drawFormImgs() {
  const box = $('#iv-imgs'), imgs = S.inv?.imgs || []; if (!box) return;
  box.innerHTML = thumbsHtml(imgs.map(x => ({ ...x, pending: true })), { removable: true });
  box.querySelectorAll('[data-thumb]').forEach(b => b.onclick = () => imageViewer(imgs.map(x => x.data), +b.dataset.thumb, 'صور الفاتورة'));
  box.querySelectorAll('[data-thumb-del]').forEach(b => b.onclick = () => { S.inv.imgs.splice(+b.dataset.thumbDel, 1); drawFormImgs(); });
}
function setupLinePicker(q) {
  const i = +q.dataset.pick, list = q.nextElementSibling, l = S.inv.lines[i];
  let hl = 0, res = [];
  const tot = totalsByItem(balances());
  const draw = () => {
    const s = q.value.trim(); l.q = q.value;
    res = activeItems().filter(x => !s || x.name.includes(s)).slice(0, 30);
    if (!res.length) { list.innerHTML = `<div class="opt muted">ما اكو مادة بهذا الاسم${isAdmin() ? ' — أضفها من الإدارة' : ''}</div>`; list.hidden = false; return; }
    hl = Math.min(hl, res.length - 1);
    list.innerHTML = res.map((x, n) => `<div class="opt ${n === hl ? 'hl' : ''}" data-id="${x.id}"><span>${esc(x.name)}</span><small>${fmt(tot.get(x.id) || 0)} ${esc(x.baseUnit)}</small></div>`).join('');
    list.hidden = false;
    list.querySelectorAll('[data-id]').forEach(o => o.onmousedown = e => { e.preventDefault(); choose(o.dataset.id); });
  };
  const choose = id => {
    const it = itemById(id); l.itemId = id; l.unit = it.bigUnit && packOf(it) > 1 ? it.bigUnit : it.baseUnit; l.q = '';
    if (!l.price) { const last = lastBuy(id, l.unit); if (last) l.price = String(last); }
    vInvForm(); document.querySelector(`[data-i="${i}"][data-k="qty"]`)?.focus();
  };
  q.oninput = () => { hl = 0; draw(); };
  q.onfocus = draw;
  q.onblur = () => setTimeout(() => list.hidden = true, 150);
  q.onkeydown = e => {
    if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, res.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && res[hl]) { choose(res[hl].id); e.preventDefault(); }
  };
}
// آخر سعر شراء للمادة بنفس الوحدة (اقتراح فقط)
function lastBuy(itemId, unit) {
  for (let k = S.moves.length - 1; k >= 0; k--) { const m = S.moves[k]; if (m.itemId === itemId && m.type === 'in' && m.unit === unit) return m.invPrice ?? m.price; }
  return 0;
}
function invRefresh() {
  if (S.view !== 'purchases' || S.pur.tab !== 'new' || !S.inv) return;
  const c = invCalc(S.inv);
  c.lines.forEach((l, i) => {
    const el = document.querySelector(`[data-tot="${i}"]`);
    if (el) el.innerHTML = l.total ? `${M(l.total)}${l.factor > 1 && l.qty ? sub(`= ${N(l.baseQty)} ${esc(l.it.baseUnit)}`) : ''}` : '<span class="muted">—</span>';
  });
  const box = $('#iv-totals'); if (!box) return;
  box.innerHTML = `<h2>${ico('reports')} الإجمالي</h2>
    <div class="tl-row"><span>مجموع المواد</span><b>${M(c.subtotal)}</b></div>
    ${c.transport ? `<div class="tl-row"><span>نقل</span><b>+ ${M(c.transport)}</b></div>` : ''}
    ${c.loading ? `<div class="tl-row"><span>تحميل</span><b>+ ${M(c.loading)}</b></div>` : ''}
    ${c.discount ? `<div class="tl-row"><span>خصم</span><b>− ${M(c.discount)}</b></div>` : ''}
    <div class="tl-row grand"><span>الإجمالي النهائي</span><b>${M(c.total)} <small>د.ع</small></b></div>
    <div class="tl-row"><span>المدفوع</span><b>${M(c.paid)}</b></div>
    <div class="tl-row ${c.due > 0.5 ? 'due' : ''}"><span>المتبقي بذمتي</span><b>${M(c.due)}</b></div>`;
}
async function saveInvoice() {
  const inv = S.inv, c = invCalc(inv), sup = supById(inv.supplierId);
  if (!sup) return toast('اختر المورد', true);
  if (!inv.date) return toast('اختر التاريخ', true);
  if (inv.date > today()) return toast('التاريخ ما يصير بالمستقبل', true);
  if (!inv.locId) return toast('اختر المخزن', true);
  const lines = c.lines.filter(l => l.itemId || l.qty || l.price);
  if (!lines.length) return toast('أضف مادة وحدة على الأقل', true);
  for (const [n, l] of lines.entries()) {
    if (!l.it) return toast(`السطر ${n + 1}: اختر المادة`, true);
    if (!(l.qty > 0)) return toast(`السطر ${n + 1}: اكتب الكمية`, true);
    if (!(l.price > 0)) return toast(`السطر ${n + 1}: اكتب السعر`, true);
  }
  if ([c.transport, c.loading, c.discount].some(v => v < 0)) return toast('المبالغ الإضافية والخصم ما تكون سالبة', true);
  if (c.total <= 0) return toast('الخصم أكبر من قيمة الفاتورة', true);
  if (inv.payMode === 'partial' && !(+inv.paid > 0 && +inv.paid < c.total)) return toast('المبلغ المدفوع لازم يكون أكثر من صفر وأقل من الإجمالي', true);
  const old = inv.id ? S.invoices.find(x => x.id === inv.id) : null;
  let why = '';
  if (old) {
    why = await askWhy('سبب تعديل الفاتورة', 'مثلاً: السعر انكتب غلط');
    if (!why) return;
  }
  const ts = old && old.date === inv.date ? old.ts : dateTs(inv.date);
  const now = Date.now(), invId = old ? old.id : B.newId(), ops = [];
  const recLines = lines.map(l => {
    const moveId = l.moveId || B.newId();
    return { moveId, itemId: l.it.id, itemName: l.it.name, unit: l.unit || l.it.baseUnit, qty: r3(l.qty), factor: l.factor, baseQty: l.baseQty, baseUnit: l.it.baseUnit, price: l.price, total: Math.round(l.total), share: Math.round(l.share), cost: Math.round(l.cost) };
  });
  const head = { ts, date: inv.date, supplierId: sup.id, supplierName: sup.name, ref: inv.ref.trim(), locId: inv.locId, note: inv.note.trim(),
    lines: recLines, subtotal: Math.round(c.subtotal), transport: c.transport, loading: c.loading, discount: c.discount, total: Math.round(c.total), payMode: inv.payMode, paid: Math.round(c.paid) };
  const newImgs = inv.imgs || [];
  if (newImgs.length || old?.imageCount) head.imageCount = (old?.imageCount || 0) + newImgs.length;
  const moveDoc = l => ({ ts, type: 'in', itemId: l.itemId, itemName: l.itemName, unit: l.unit, qty: l.qty, factor: l.factor, baseQty: l.baseQty, baseUnit: l.baseUnit,
    price: l.qty ? Math.round(l.cost / l.qty * 100) / 100 : 0, cost: l.cost, fromLoc: '', toLoc: inv.locId, reason: '', ref: head.ref, note: '',
    invoiceId: invId, supplierId: sup.id, supplierName: sup.name, invPrice: l.price, extra: l.share });
  if (!old) {
    ops.push({ type: 'set', col: 'invoices', id: invId, data: { ...head, moveIds: recLines.map(l => l.moveId), staffId: S.user.id, staffName: S.user.name } });
    recLines.forEach(l => ops.push({ type: 'set', col: 'moves', id: l.moveId, data: { ...moveDoc(l), staffId: S.user.id, staffName: S.user.name } }));
  } else {
    const before = invSnap(old), after = invSnap({ ...old, ...head }), summary = invDiff(before, after);
    if (newImgs.length) summary.push(`ضاف ${newImgs.length} صورة`);
    if (!summary.length) return toast('ما غيّرت شي', true);
    const aid = B.newId(), edit = { lastAuditId: aid, editedBy: S.user.name, editedAt: now };
    ops.push({ type: 'set', col: 'audit', id: aid, data: { ts: now, action: 'edit', kind: 'invoice', invoiceId: old.id, supplierName: sup.name, ref: head.ref, moveTs: old.ts, moveStaff: old.staffName, by: S.user.name, byId: S.user.id, why, summary, before, after } });
    ops.push({ type: 'update', col: 'invoices', id: old.id, data: { ...head, moveIds: recLines.map(l => l.moveId), ...edit, editCount: (old.editCount || 0) + 1 } });
    const keep = new Set(recLines.map(l => l.moveId));
    for (const id of old.moveIds || []) if (!keep.has(id)) ops.push({ type: 'update', col: 'moves', id, data: { deleted: true, deletedBy: S.user.name, deletedAt: now, lastAuditId: aid } });
    for (const l of recLines) {
      const prev = S.allMoves.find(m => m.id === l.moveId);
      if (prev) ops.push({ type: 'update', col: 'moves', id: l.moveId, data: { ...moveDoc(l), ...edit, editCount: (prev.editCount || 0) + 1 } });
      else ops.push({ type: 'set', col: 'moves', id: l.moveId, data: { ...moveDoc(l), staffId: S.user.id, staffName: S.user.name } });
    }
  }
  $('#iv-save').disabled = true;
  try { await B.batch(ops); }
  catch (e) { $('#iv-save').disabled = false; return toast('ما انحفظت: ' + e.message, true); }
  // الصور بطلبات منفصلة (8 بكل طلب) حتى ما يكبر طلب الفاتورة (حد Firestore 10MB)
  if (newImgs.length) {
    toast(`جاري حفظ ${newImgs.length} صورة…`);
    try { await addInvoiceImages({ id: invId, supplierId: sup.id }, newImgs); imgCache.delete(invId); }
    catch (e) { toast('الفاتورة انحفظت بس الصور ما انحفظت: ' + e.message + ' — ضيفها من «عرض» الفاتورة', true); S.inv = null; S.pur.tab = 'list'; return vPurch(); }
  }
  toast(old ? '✔ انعدلت الفاتورة وانسجل التعديل' : `✔ انحفظت الفاتورة: ${recLines.length} مادة — ${money(head.total)} د.ع`);
  const keepLoc = inv.locId;
  S.inv = old ? null : { ...newInv(), locId: keepLoc };
  if (old) S.pur.tab = 'list';
  vPurch();
}
function askWhy(title, ph) {
  return new Promise(res => {
    modal(`<h2>${title}</h2><div class="field"><label>السبب <span class="req">*</span></label><input class="in" id="w-why" placeholder="${ph}"></div>
      <div class="foot"><button class="btn" id="w-ok">${ico('save')}متابعة</button><button class="btn ghost" id="w-no">إلغاء</button></div>`, (m, close) => {
      const ok = () => { const v = m.querySelector('#w-why').value.trim(); if (!v) return toast('اكتب السبب', true); close(); res(v); };
      m.querySelector('#w-ok').onclick = ok; m.querySelector('#w-why').onkeydown = e => { if (e.key === 'Enter') ok(); };
      m.querySelector('#w-no').onclick = () => { close(); res(''); };
      m.querySelector('#w-why').focus();
    });
  });
}

/* ── invoices list ── */
function vInvList() {
  const P = S.pur;
  const list = liveInv().filter(v => v.ts >= dayStartTs(P.from) && v.ts <= dayEndTs(P.to) && (!P.supF || v.supplierId === P.supF)).sort((a, b) => b.ts - a.ts);
  const sum = k => list.reduce((a, v) => a + (+v[k] || 0), 0);
  const st = v => v.paid >= v.total ? ['مدفوعة', 'b-ok'] : v.paid > 0 ? ['جزئي', 'b-warn'] : ['آجل', 'b-bad'];
  $('#pur').innerHTML = `
    <div class="card">
      <div class="filters">
        <label class="small">من<br><input class="in" type="date" id="pf-from" value="${P.from}"></label>
        <label class="small">إلى<br><input class="in" type="date" id="pf-to" value="${P.to}"></label>
        <label class="small">المورد<br><select class="in" id="pf-sup"><option value="">الكل</option>${S.suppliers.map(s => `<option value="${s.id}" ${P.supF === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      </div>
      ${list.length ? `<div class="sumbar"><span><span class="muted small">الفواتير</span><b>${list.length}</b></span><span><span class="muted small">الإجمالي</span><b>${M(sum('total'))} د.ع</b></span><span><span class="muted small">المدفوع</span><b>${M(sum('paid'))} د.ع</b></span><span><span class="muted small">المتبقي منها</span><b>${M(sum('total') - sum('paid'))} د.ع</b></span></div>` : ''}
      <div class="tbl-wrap">${list.length ? `<table>
        <tr><th>التاريخ</th><th>المورد / الوصل</th><th>المخزن</th><th class="num">المواد</th><th class="num">الإجمالي</th><th class="num">المدفوع</th><th class="num">المتبقي</th><th>الحالة</th><th></th></tr>
        ${list.map(v => { const s = st(v); return `<tr>${dtCell(v.ts)}<td><b>${esc(supName(v))}</b>${sub(v.ref ? 'وصل ' + esc(v.ref) : '')}${v.editCount ? ' <span class="badge b-warn">معدّلة</span>' : ''}</td><td class="small">${esc(locName(v.locId))}</td><td class="num">${(v.lines || []).length}${imgBadge(v)}</td><td class="num"><b>${M(v.total)}</b></td><td class="num">${M(v.paid)}</td><td class="num ${v.total - v.paid > 0.5 ? 'neg' : ''}">${M(v.total - v.paid)}</td><td><span class="badge ${s[1]}">${s[0]}</span></td>
          <td style="white-space:nowrap"><button class="link" data-view="${v.id}">${ico('log')}عرض</button>${canEdit() ? `<button class="link" data-ied="${v.id}">${ico('edit')}تعديل</button><button class="link bad" data-idel="${v.id}">${ico('trash')}حذف</button>` : ''}</td></tr>`; }).join('')}
      </table>` : `<div class="empty">ما اكو فواتير بهذي الفترة</div>`}</div>
    </div>`;
  const on = (id, k) => $(id).onchange = e => { P[k] = e.target.value; vInvList(); };
  on('#pf-from', 'from'); on('#pf-to', 'to'); on('#pf-sup', 'supF');
  bindInvActions();
}
function bindInvActions() {
  bindImgLinks();
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewInvoice(S.invoices.find(x => x.id === b.dataset.view)));
  document.querySelectorAll('[data-ied]').forEach(b => b.onclick = () => editInvoice(S.invoices.find(x => x.id === b.dataset.ied)));
  document.querySelectorAll('[data-idel]').forEach(b => b.onclick = () => deleteInvoice(S.invoices.find(x => x.id === b.dataset.idel)));
}
function viewInvoice(v) {
  if (!v) return;
  modal(`<h2>${ico('purchases')} فاتورة ${esc(supName(v))}</h2>
    <p class="small muted" style="margin-top:-6px">${v.ref ? 'وصل ' + esc(v.ref) + ' — ' : ''}${esc(v.date)} — ${esc(locName(v.locId))} — سجّلها ${esc(v.staffName)}${v.note ? '<br>' + esc(v.note) : ''}</p>
    <div class="tbl-wrap"><table><tr><th>المادة</th><th class="num">الكمية</th><th class="num">السعر</th><th class="num">الإجمالي</th></tr>
      ${(v.lines || []).map(l => `<tr><td><b>${esc(l.itemName)}</b>${l.share ? sub(`كلفة بعد التوزيع: ${money(l.cost)}`) : ''}</td><td class="num">${N(l.qty)} ${esc(l.unit)}</td><td class="num">${M(l.price)}</td><td class="num">${M(l.total)}</td></tr>`).join('')}
    </table></div>
    <div class="totbox" style="margin-top:12px">
      <div class="tl-row"><span>مجموع المواد</span><b>${M(v.subtotal)}</b></div>
      ${v.transport ? `<div class="tl-row"><span>نقل</span><b>+ ${M(v.transport)}</b></div>` : ''}${v.loading ? `<div class="tl-row"><span>تحميل</span><b>+ ${M(v.loading)}</b></div>` : ''}${v.discount ? `<div class="tl-row"><span>خصم</span><b>− ${M(v.discount)}</b></div>` : ''}
      <div class="tl-row grand"><span>الإجمالي</span><b>${M(v.total)} <small>د.ع</small></b></div>
      <div class="tl-row"><span>${PAY_MODES[v.payMode] || ''} — المدفوع</span><b>${M(v.paid)}</b></div>
      <div class="tl-row ${v.total - v.paid > 0.5 ? 'due' : ''}"><span>المتبقي</span><b>${M(v.total - v.paid)}</b></div>
    </div>
    <div class="vw-imgs">
      <div class="card-head"><h2>${ico('camera')} صور الفاتورة</h2>${v.deleted ? '' : pickButtons('vw')}</div>
      <div id="vw-imgs">${thumbsHtml([], { loading: true })}</div>
    </div>
    <div class="foot"><button class="btn ghost" id="vw-c">إغلاق</button></div>`, (m, close) => {
      m.querySelector('#vw-c').onclick = close;
      const draw = async (fresh = false) => {
        const box = m.querySelector('#vw-imgs'); if (!box) return;
        let list;
        try { list = await invoiceImages(v.id, fresh); } catch (e) { box.innerHTML = `<div class="hint bad">تعذّر تحميل الصور: ${esc(e.message)}</div>`; return; }
        if (!box.isConnected) return;
        const canDel = canEdit() && !v.deleted;
        box.innerHTML = thumbsHtml(list, { removable: canDel });
        box.querySelectorAll('[data-thumb]').forEach(b => b.onclick = () => imageViewer(list.map(x => x.data), +b.dataset.thumb, `فاتورة ${supName(v)}`));
        box.querySelectorAll('[data-thumb-del]').forEach(b => b.onclick = async () => {
          const im = list[+b.dataset.thumbDel];
          const why = await askWhy('سبب حذف الصورة', 'مثلاً: صورة غلط أو مكررة');
          if (!why) return viewInvoice(S.invoices.find(x => x.id === v.id) || v);
          try { await deleteInvoiceImage(v, im, why); } catch (e) { return toast('ما انحذفت: ' + e.message, true); }
          toast('انحذفت الصورة وانسجلت بالمحذوفات'); viewInvoice(S.invoices.find(x => x.id === v.id) || v);
        });
      };
      if (!v.deleted) bindPick(m, 'vw', async imgs => {
        try { await appendImages(v, imgs); } catch (e) { return toast('ما انحفظت الصور: ' + e.message, true); }
        toast(`✔ انضافت ${imgs.length} صورة`); draw(true);
      });
      draw();
    });
}
function editInvoice(v) {
  if (!v || !canEdit()) return;
  S.inv = { id: v.id, supplierId: v.supplierId, ref: v.ref || '', date: v.date, locId: v.locId, note: v.note || '',
    lines: (v.lines || []).map(l => ({ moveId: l.moveId, itemId: l.itemId, unit: l.unit, qty: String(l.qty), price: String(l.price), q: '' })),
    transport: v.transport ? String(v.transport) : '', loading: v.loading ? String(v.loading) : '', discount: v.discount ? String(v.discount) : '', payMode: v.payMode || 'credit', paid: v.payMode === 'partial' ? String(v.paid) : '', imgs: [] };
  go('purchases', { tab: 'new' });
}
function deleteInvoice(v) {
  if (!v || !canEdit()) return;
  modal(`<h2>حذف فاتورة</h2>
    <p><b>${esc(supName(v))}</b>${v.ref ? ' — وصل ' + esc(v.ref) : ''} — ${M(v.total)} د.ع<br><span class="small muted">${esc(v.date)} — ${(v.lines || []).length} مادة — سجّلها ${esc(v.staffName)}</span></p>
    <p class="small">الفاتورة وكل حركات الوارد مالتها تنشال من الأرصدة وكشف الحساب، وتروح لخانة «المحذوفات» باسمك.</p>
    <div class="field"><label>سبب الحذف <span class="req">*</span></label><input class="in" id="d-why" placeholder="مثلاً: انسجلت مرتين"></div>
    <div class="foot"><button class="btn danger" id="d-s">${ico('trash')}حذف</button><button class="btn ghost" id="d-c">إلغاء</button></div>`,
    (md, close) => {
      md.querySelector('#d-c').onclick = close;
      md.querySelector('#d-s').onclick = async () => {
        const why = md.querySelector('#d-why').value.trim();
        if (!why) return toast('اكتب سبب الحذف', true);
        const aid = B.newId(), now = Date.now(), del = { deleted: true, deletedBy: S.user.name, deletedAt: now, lastAuditId: aid };
        const ops = [{ type: 'set', col: 'audit', id: aid, data: { ts: now, action: 'delete', kind: 'invoice', invoiceId: v.id, supplierName: supName(v), ref: v.ref || '', moveTs: v.ts, moveStaff: v.staffName, by: S.user.name, byId: S.user.id, why, before: invSnap(v) } },
          { type: 'update', col: 'invoices', id: v.id, data: del }];
        for (const id of v.moveIds || []) if (S.allMoves.some(m => m.id === id && !m.deleted)) ops.push({ type: 'update', col: 'moves', id, data: del });
        try { await B.batch(ops); } catch (e) { return toast('ما انحذفت: ' + e.message, true); }
        close(); toast('انحذفت الفاتورة وانسجلت بالمحذوفات');
      };
    });
}

/* ── suppliers ── */
function vSuppliers(box) {
  const list = S.suppliers.slice().sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name, 'ar'));
  const dues = new Map(list.map(s => [s.id, supDue(s.id)]));
  const total = [...dues.values()].filter(v => v > 0.5).reduce((a, v) => a + v, 0);
  box.innerHTML = `
    <div class="card">
      <div class="sumbar"><span><span class="muted small">الموردين</span><b>${list.filter(s => s.active !== false).length}</b></span><span><span class="muted small">عليهم ديون</span><b>${[...dues.values()].filter(v => v > 0.5).length}</b></span><span><span class="muted small">مجموع الديون بذمتي</span><b>${M(total)} د.ع</b></span></div>
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px"><button class="btn sm" id="sp-new">${ico('plus')}مورد جديد</button></div>
      ${list.length ? `<div class="tbl-wrap"><table><tr><th>المورد</th><th>ملاحظات</th><th class="num">المتبقي بذمتي</th><th></th></tr>
        ${list.map(s => { const d = dues.get(s.id); return `<tr style="${s.active === false ? 'opacity:.55' : ''}"><td><b>${esc(s.name)}</b>${s.active === false ? ' <span class="badge b-muted">موقوف</span>' : ''}${sub(s.phone ? `<a href="tel:${esc(s.phone)}" dir="ltr">${esc(s.phone)}</a>` : '')}</td>
          <td class="small muted">${esc(s.note || '')}</td><td class="num ${d > 0.5 ? 'neg' : ''}"><b>${M(d)}</b></td>
          <td style="white-space:nowrap"><button class="link" data-st="${s.id}">${ico('wallet')}كشف حساب</button>${canEdit() ? `<button class="link" data-sed="${s.id}">${ico('edit')}تعديل</button>` : ''}</td></tr>`; }).join('')}
      </table></div>` : `<div class="empty">ما اكو موردين. أضف أول مورد.</div>`}
    </div>`;
  box.querySelector('#sp-new').onclick = () => supplierForm();
  box.querySelectorAll('[data-st]').forEach(b => b.onclick = () => go('purchases', { sup: b.dataset.st }));
  box.querySelectorAll('[data-sed]').forEach(b => b.onclick = () => supplierForm(supById(b.dataset.sed)));
}
function supplierForm(s, after) {
  if (s && !canEdit()) return;
  modal(`<h2>${s ? 'تعديل مورد' : 'مورد جديد'}</h2>
    <div class="field"><label>الاسم <span class="req">*</span></label><input class="in" id="sp-n" value="${esc(s?.name)}"></div>
    <div class="field"><label>الهاتف</label><input class="in" id="sp-p" dir="ltr" inputmode="tel" value="${esc(s?.phone)}"></div>
    <div class="field"><label>ملاحظات</label><input class="in" id="sp-o" value="${esc(s?.note)}"></div>
    <div class="foot"><button class="btn" id="sp-s">${ico('save')}حفظ</button><button class="btn ghost" id="sp-c">إلغاء</button>
    ${s ? `<button class="btn ghost" id="sp-x" style="margin-right:auto">${s.active === false ? 'إعادة تفعيل' : 'إيقاف'}</button>` : ''}</div>`,
    (m, close) => {
      m.querySelector('#sp-c').onclick = close;
      m.querySelector('#sp-s').onclick = async () => {
        const name = normTxt(m.querySelector('#sp-n').value), phone = normTxt(m.querySelector('#sp-p').value), note = normTxt(m.querySelector('#sp-o').value);
        if (!name) return toast('اكتب اسم المورد', true);
        if (S.suppliers.some(x => normKey(x.name) === normKey(name) && x.id !== s?.id)) return toast('اكو مورد بنفس الاسم', true);
        let id = s?.id;
        if (s) await B.update('suppliers', s.id, { name, phone, note });
        else id = await B.add('suppliers', { name, phone, note, active: true, created: Date.now() });
        close(); toast('✔ انحفظ المورد'); after && after(id);
      };
      const x = m.querySelector('#sp-x');
      if (x) x.onclick = async () => { await B.update('suppliers', s.id, { active: s.active === false }); close(); toast('✔ تم'); };
    });
}

/* ── supplier statement (كشف حساب) ── */
function supLedger(id) {
  const rows = [];
  for (const v of liveInv()) if (v.supplierId === id) {
    rows.push({ ts: v.ts, kind: 'inv', ref: v.ref || '', text: `فاتورة مشتريات — ${(v.lines || []).length} مادة`, debit: +v.total || 0, credit: 0, inv: v });
    if (+v.paid > 0) rows.push({ ts: v.ts, kind: 'paidnow', ref: v.ref || '', text: 'مدفوع عند الاستلام', debit: 0, credit: +v.paid, inv: v });
  }
  for (const p of livePay()) if (p.supplierId === id) rows.push({ ts: p.ts, kind: 'pay', ref: '', text: `تسديد ${PAY_METHODS[p.method] || ''}${p.note ? ' — ' + p.note : ''}`, debit: 0, credit: +p.amount || 0, pay: p });
  rows.sort((a, b) => a.ts - b.ts || (a.kind === 'paidnow') - (b.kind === 'paidnow'));
  let bal = 0; rows.forEach(r => { bal += r.debit - r.credit; r.bal = bal; });
  return rows;
}
function supItems(id, t0, t1) {
  const m = new Map();
  for (const v of liveInv()) if (v.supplierId === id && v.ts >= t0 && v.ts <= t1) for (const l of v.lines || []) {
    const it = itemById(l.itemId), x = m.get(l.itemId) || { name: it?.name || l.itemName, unit: it?.baseUnit || l.baseUnit, qty: 0, amount: 0, last: 0, lastUnit: '', lastTs: 0 };
    x.qty += +l.baseQty || 0; x.amount += +l.total || 0;
    if (v.ts >= x.lastTs) { x.lastTs = v.ts; x.last = l.price; x.lastUnit = l.unit; }
    m.set(l.itemId, x);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}
function vSupplier() {
  const P = S.pur, s = supById(P.sup);
  if (!s) { P.sup = ''; return vPurch(); }
  const t0 = dayStartTs(P.from), t1 = dayEndTs(P.to);
  const all = supLedger(s.id), before = all.filter(r => r.ts < t0), rows = all.filter(r => r.ts >= t0 && r.ts <= t1);
  const open = before.length ? before[before.length - 1].bal : 0, due = supDue(s.id);
  const items = supItems(s.id, t0, t1);
  const sumD = rows.reduce((a, r) => a + r.debit, 0), sumC = rows.reduce((a, r) => a + r.credit, 0);
  $('#view-root').innerHTML = `
    <div class="topline"><h1>${esc(s.name)}</h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" id="sv-back">${ico('back')}رجوع</button><button class="btn sm t-in" id="sv-pay">${ico('wallet')}تسديد</button></div></div>
    <div class="overview">
      <div class="valcard"><div class="vc-top"><span>المتبقي بذمتي</span><img src="logo.png" alt=""></div><div class="vc-num">${M(due)}<small>د.ع</small></div>
        <div class="vc-foot"><span>${s.phone ? `<a href="tel:${esc(s.phone)}" dir="ltr" style="color:inherit">${esc(s.phone)}</a>` : 'بدون هاتف'}</span>${s.note ? `<span>${esc(s.note)}</span>` : ''}</div></div>
      <div class="kpis">
        <div class="kpi k-blue"><span class="ki">${ico('purchases')}</span><div><div class="l">فواتير الفترة</div><div class="v">${M(sumD)}</div></div></div>
        <div class="kpi k-green"><span class="ki">${ico('wallet')}</span><div><div class="l">المدفوع بالفترة</div><div class="v">${M(sumC)}</div></div></div>
        <div class="kpi k-amber"><span class="ki">${ico('clock')}</span><div><div class="l">رصيد قبل الفترة</div><div class="v">${M(open)}</div></div></div>
      </div>
    </div>
    <div class="card">
      <div class="filters" style="justify-content:space-between">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
          <label class="small">من<br><input class="in" type="date" id="sv-from" value="${P.from}"></label>
          <label class="small">إلى<br><input class="in" type="date" id="sv-to" value="${P.to}"></label>
        </div>
        <button class="btn sm" id="sv-csv">${ico('download')}تصدير الكشف</button>
      </div>
      <h2>${ico('wallet')} كشف الحساب</h2>
      <div class="tbl-wrap"><table>
        <tr><th>التاريخ</th><th>البيان</th><th class="num">فواتير (علي)</th><th class="num">تسديدات (دفعت)</th><th class="num">الرصيد</th><th></th></tr>
        <tr class="grp"><td colspan="4"><b>رصيد سابق</b> <span class="small muted">— قبل ${P.from}</span></td><td class="num"><b>${M(open)}</b></td><td></td></tr>
        ${rows.map(r => `<tr>${dtCell(r.ts)}<td><b class="${r.kind === 'inv' ? 't-in' : r.kind === 'pay' ? 't-transfer' : ''}">${esc(r.text)}</b>${sub(r.ref ? 'وصل ' + esc(r.ref) : r.pay ? 'سجّلها ' + esc(r.pay.staffName) : '')}${(r.inv || r.pay)?.editCount && r.kind !== 'paidnow' ? ' <span class="badge b-warn">معدّلة</span>' : ''}</td>
          <td class="num">${r.debit ? M(r.debit) : ''}</td><td class="num">${r.credit ? M(r.credit) : ''}</td><td class="num"><b>${M(r.bal)}</b></td>
          <td style="white-space:nowrap">${r.kind === 'inv' ? `${imgBadge(r.inv)}<button class="link" data-view="${r.inv.id}">${ico('log')}عرض</button>${canEdit() ? `<button class="link" data-ied="${r.inv.id}">${ico('edit')}</button><button class="link bad" data-idel="${r.inv.id}">${ico('trash')}</button>` : ''}`
            : r.kind === 'pay' && canEdit() ? `<button class="link" data-ped="${r.pay.id}">${ico('edit')}تعديل</button><button class="link bad" data-pdel="${r.pay.id}">${ico('trash')}حذف</button>` : ''}</td></tr>`).join('')}
        ${rows.length ? '' : `<tr><td colspan="6" class="empty">ما اكو حركات بهذي الفترة</td></tr>`}
      </table></div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px"><h2 style="margin:0">${ico('stock')} المواد المشتراة بالفترة</h2>${items.length ? `<button class="btn ghost sm" id="sv-icsv">${ico('download')}تصدير المواد</button>` : ''}</div>
      ${items.length ? `<div class="tbl-wrap"><table><tr><th>المادة</th><th class="num">الكمية</th><th class="num">المبلغ</th><th class="num">آخر سعر</th></tr>
        ${items.map(x => `<tr><td><b>${esc(x.name)}</b></td><td class="num">${N(x.qty)} ${esc(x.unit)}</td><td class="num">${M(x.amount)}</td><td class="num">${M(x.last)}${sub('لكل ' + esc(x.lastUnit))}</td></tr>`).join('')}
      </table></div>` : `<div class="empty">ما اكو مشتريات بهذي الفترة</div>`}
    </div>`;
  $('#sv-back').onclick = () => go('purchases', { tab: 'sups' });
  $('#sv-pay').onclick = () => paymentForm(s);
  $('#sv-from').onchange = e => { P.from = e.target.value; vSupplier(); };
  $('#sv-to').onchange = e => { P.to = e.target.value; vSupplier(); };
  bindInvActions();
  document.querySelectorAll('[data-ped]').forEach(b => b.onclick = () => paymentForm(s, S.payments.find(x => x.id === b.dataset.ped)));
  document.querySelectorAll('[data-pdel]').forEach(b => b.onclick = () => deletePayment(S.payments.find(x => x.id === b.dataset.pdel)));
  $('#sv-csv').onclick = () => exportSheet({ file: `كشف_حساب_${s.name}_${P.from}_${P.to}.xlsx`, title: `${CONFIG.title} — كشف حساب ${s.name}`,
    sub: `من ${P.from} إلى ${P.to}   |   رصيد سابق: ${money(open)}   |   المتبقي بذمتي الآن: ${money(due)} د.ع`,
    headers: ['التاريخ', 'البيان', 'رقم الوصل', 'فواتير (علي)', 'تسديدات (دفعت)', 'الرصيد'],
    rows: [['', 'رصيد سابق', '', '', '', Math.round(open)], ...rows.map(r => [dt(r.ts), r.text, r.ref, r.debit ? Math.round(r.debit) : '', r.credit ? Math.round(r.credit) : '', Math.round(r.bal)])],
    money: [3, 4, 5], totals: { label: 'المجموع', cols: [3, 4] } });
  if ($('#sv-icsv')) $('#sv-icsv').onclick = () => exportSheet({ file: `مشتريات_${s.name}_${P.from}_${P.to}.xlsx`, title: `${CONFIG.title} — المواد المشتراة من ${s.name}`, sub: `من ${P.from} إلى ${P.to}`,
    headers: ['المادة', 'الكمية', 'الوحدة', 'المبلغ (د.ع)', 'آخر سعر', 'لكل'],
    rows: items.map(x => [x.name, r3(x.qty), x.unit, Math.round(x.amount), x.last, x.lastUnit]), qty: [1], money: [3, 4], totals: { label: 'المجموع', cols: [3] } });
}
function paymentForm(s, p) {
  if (p && !canEdit()) return;
  const due = supDue(s.id);
  modal(`<h2>${ico('wallet')} ${p ? 'تعديل تسديد' : 'تسديد'} — ${esc(s.name)}</h2>
    <p class="small muted" style="margin-top:-6px">المتبقي بذمتك حالياً: <b>${money(due)} د.ع</b>. التسديد ينحسب على حساب المورد كله.</p>
    <div class="row">
      <div class="field"><label>المبلغ <span class="req">*</span></label><input class="in" id="py-a" type="number" inputmode="decimal" min="0" step="any" value="${esc(p?.amount ?? '')}"></div>
      <div class="field"><label>التاريخ <span class="req">*</span></label><input class="in" id="py-d" type="date" max="${today()}" value="${esc(p?.date || today())}"></div>
    </div>
    <div class="field"><label>طريقة الدفع</label><div class="seg paymode">${Object.entries(PAY_METHODS).map(([k, t]) => `<button data-pmt="${k}" class="${(p?.method || 'cash') === k ? 'on' : ''}">${t}</button>`).join('')}</div></div>
    <div class="field"><label>ملاحظة</label><input class="in" id="py-n" value="${esc(p?.note)}"></div>
    ${p ? `<div class="field"><label>سبب التعديل <span class="req">*</span></label><input class="in" id="py-why" placeholder="مثلاً: المبلغ انكتب غلط"></div>` : ''}
    <div class="foot"><button class="btn" id="py-s">${ico('save')}${p ? 'حفظ التعديل' : 'تسجيل التسديد'}</button><button class="btn ghost" id="py-c">إلغاء</button></div>`,
    (m, close) => {
      let method = p?.method || 'cash';
      m.querySelectorAll('[data-pmt]').forEach(b => b.onclick = () => { method = b.dataset.pmt; m.querySelectorAll('[data-pmt]').forEach(x => x.classList.toggle('on', x === b)); });
      m.querySelector('#py-c').onclick = close;
      m.querySelector('#py-s').onclick = async () => {
        const amount = Math.round(+m.querySelector('#py-a').value || 0), date = m.querySelector('#py-d').value, note = normTxt(m.querySelector('#py-n').value);
        if (!(amount > 0)) return toast('اكتب المبلغ', true);
        if (!date || date > today()) return toast('اختر تاريخ صحيح', true);
        const doc = { ts: p && p.date === date ? p.ts : dateTs(date), date, supplierId: s.id, supplierName: s.name, amount, method, note };
        try {
          if (!p) await B.add('payments', { ...doc, staffId: S.user.id, staffName: S.user.name });
          else {
            const why = m.querySelector('#py-why').value.trim(); if (!why) return toast('اكتب سبب التعديل', true);
            const snap = x => ({ amount: x.amount, date: x.date, method: x.method, note: x.note || '' });
            const before = snap(p), after = snap(doc);
            const summary = [['المبلغ', money(before.amount), money(after.amount)], ['التاريخ', before.date, after.date], ['الطريقة', PAY_METHODS[before.method], PAY_METHODS[after.method]], ['ملاحظة', before.note, after.note]].filter(x => String(x[1]) !== String(x[2])).map(x => `${x[0]}: ${x[1] || '—'} ← ${x[2] || '—'}`);
            if (!summary.length) return toast('ما غيّرت شي', true);
            const aid = B.newId(), now = Date.now();
            await B.batch([{ type: 'set', col: 'audit', id: aid, data: { ts: now, action: 'edit', kind: 'payment', paymentId: p.id, supplierName: s.name, moveTs: p.ts, moveStaff: p.staffName, by: S.user.name, byId: S.user.id, why, summary, before, after } },
              { type: 'update', col: 'payments', id: p.id, data: { ...doc, lastAuditId: aid, editCount: (p.editCount || 0) + 1, editedBy: S.user.name, editedAt: now } }]);
          }
        } catch (e) { return toast('ما انحفظ: ' + e.message, true); }
        close(); toast(p ? '✔ انعدل التسديد وانسجل التعديل' : `✔ انسجل تسديد ${money(amount)} د.ع`);
      };
    });
}
function deletePayment(p) {
  if (!p || !canEdit()) return;
  modal(`<h2>حذف تسديد</h2>
    <p><b>${esc(supName(p))}</b> — ${M(p.amount)} د.ع ${PAY_METHODS[p.method] || ''}<br><span class="small muted">${esc(p.date)} — سجّلها ${esc(p.staffName)}</span></p>
    <div class="field"><label>سبب الحذف <span class="req">*</span></label><input class="in" id="d-why" placeholder="مثلاً: انسجل مرتين"></div>
    <div class="foot"><button class="btn danger" id="d-s">${ico('trash')}حذف</button><button class="btn ghost" id="d-c">إلغاء</button></div>`,
    (md, close) => {
      md.querySelector('#d-c').onclick = close;
      md.querySelector('#d-s').onclick = async () => {
        const why = md.querySelector('#d-why').value.trim();
        if (!why) return toast('اكتب سبب الحذف', true);
        const aid = B.newId(), now = Date.now();
        try {
          await B.batch([{ type: 'set', col: 'audit', id: aid, data: { ts: now, action: 'delete', kind: 'payment', paymentId: p.id, supplierName: supName(p), moveTs: p.ts, moveStaff: p.staffName, by: S.user.name, byId: S.user.id, why, before: { amount: p.amount, date: p.date, method: p.method, note: p.note || '' } } },
            { type: 'update', col: 'payments', id: p.id, data: { deleted: true, deletedBy: S.user.name, deletedAt: now, lastAuditId: aid } }]);
        } catch (e) { return toast('ما انحذف: ' + e.message, true); }
        close(); toast('انحذف التسديد وانسجل بالمحذوفات');
      };
    });
}

/* ═════════════ Invoice images (صور الفواتير) ═════════════
   نفس أسلوب fryday-store: الصورة تنضغط بالمتصفح لحوالي 250KB (JPEG) وتنحفظ كوثيقة منفصلة
   بمجموعة invoiceImages (مو داخل الفاتورة)، بدون Firebase Storage. الفاتورة بيها عداد imageCount بس.
   الصور ما تنحمّل ويا البيانات؛ تنجاب لما تنفتح الفاتورة (B.images). الحذف = deleted ويا audit. */
const IMG_TARGET = 250 * 1024, IMG_MAX_SIDE = 1800, IMG_BATCH = 8;
const imgBytes = d => Math.round((d.length - d.indexOf(',') - 1) * 3 / 4);
async function loadImg(file) {
  if ('createImageBitmap' in window) {
    try { const b = await createImageBitmap(file, { imageOrientation: 'from-image' }); return { w: b.width, h: b.height, draw: (c, w, h) => c.drawImage(b, 0, 0, w, h) }; }
    catch { /* نجرب الطريقة الثانية */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('ملف الصورة غير صالح')); i.src = url; });
    return { w: img.naturalWidth, h: img.naturalHeight, draw: (c, w, h) => c.drawImage(img, 0, 0, w, h) };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
// ضغط لحوالي 250KB: بحث ثنائي على جودة JPEG، وإذا ما كفى نصغّر الأبعاد
async function compressImage(file, target = IMG_TARGET) {
  const src = await loadImg(file);
  let scale = Math.min(1, IMG_MAX_SIDE / Math.max(src.w, src.h));
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  for (let round = 0; round < 6; round++) {
    const w = Math.max(1, Math.round(src.w * scale)), h = Math.max(1, Math.round(src.h * scale));
    canvas.width = w; canvas.height = h;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); src.draw(ctx, w, h);
    let lo = 0.35, hi = 0.92, best = '';
    for (let i = 0; i < 7; i++) { const q = (lo + hi) / 2, d = canvas.toDataURL('image/jpeg', q); if (imgBytes(d) <= target) { best = d; lo = q; } else hi = q; }
    if (best) return { data: best, w, h, bytes: imgBytes(best) };
    scale *= 0.75;
  }
  const d = canvas.toDataURL('image/jpeg', 0.35);
  return { data: d, w: canvas.width, h: canvas.height, bytes: imgBytes(d) };
}
// أزرار الكاميرا والمعرض: ترجع الصور مضغوطة
function pickButtons(id) {
  return `<div class="pick-btns">
    <input type="file" accept="image/*" capture="environment" hidden data-pick-cam="${id}">
    <input type="file" accept="image/*" multiple hidden data-pick-gal="${id}">
    <button class="btn ghost sm" data-pick-btn="cam" data-for="${id}">${ico('camera')}الكاميرا</button>
    <button class="btn ghost sm" data-pick-btn="gal" data-for="${id}">${ico('image')}المعرض</button>
  </div>`;
}
function bindPick(scope, id, onAdd) {
  const cam = scope.querySelector(`[data-pick-cam="${id}"]`), gal = scope.querySelector(`[data-pick-gal="${id}"]`);
  const btns = scope.querySelectorAll(`[data-for="${id}"]`);
  btns.forEach(b => b.onclick = () => (b.dataset.pickBtn === 'cam' ? cam : gal).click());
  const handle = async input => {
    const files = [...(input.files || [])].filter(f => f.type.startsWith('image/')); input.value = '';
    if (!files.length) return;
    btns.forEach(b => b.disabled = true);
    const galBtn = [...btns].find(b => b.dataset.pickBtn === 'gal'), label = galBtn.innerHTML;
    galBtn.innerHTML = `${ico('clock')}جاري الضغط…`;
    const out = [];
    for (const f of files) { try { out.push(await compressImage(f)); } catch (e) { toast('تعذّر قراءة صورة: ' + e.message, true); } }
    btns.forEach(b => b.disabled = false); galBtn.innerHTML = label;
    if (out.length) onAdd(out);
  };
  cam.onchange = () => handle(cam); gal.onchange = () => handle(gal);
}
// مصغّرات: images = [{data, bytes, pending?}]
function thumbsHtml(images, { removable = false, loading = false } = {}) {
  if (loading) return `<div class="thumbs-empty">${ico('clock')} جاري تحميل الصور…</div>`;
  if (!images.length) return `<div class="thumbs-empty">ما اكو صور. صوّر الوصل بالكاميرا أو اختاره من المعرض.</div>`;
  return `<div class="thumbs">${images.map((im, i) => `<div class="thumb">
    <button type="button" class="thumb-open" data-thumb="${i}" aria-label="فتح الصورة ${i + 1}"><img src="${im.data}" alt="" loading="lazy"></button>
    <span class="thumb-kb">${Math.round(im.bytes / 1024)}KB${im.pending ? ' · جديدة' : ''}</span>
    ${removable ? `<button type="button" class="thumb-del" data-thumb-del="${i}" aria-label="شيل الصورة">${ico('trash')}</button>` : ''}
  </div>`).join('')}</div>`;
}
const imgCache = new Map(); // invoiceId → صور محمّلة
async function invoiceImages(id, fresh = false) {
  if (!fresh && imgCache.has(id)) return imgCache.get(id);
  const list = await B.images(id); imgCache.set(id, list); return list;
}
async function addInvoiceImages(v, images) {
  const now = Date.now();
  for (let i = 0; i < images.length; i += IMG_BATCH)
    await B.batch(images.slice(i, i + IMG_BATCH).map(im => ({ type: 'set', col: 'invoiceImages', id: B.newId(), data: { ts: now, invoiceId: v.id, supplierId: v.supplierId, ...im, staffId: S.user.id, staffName: S.user.name } })));
}
// إضافة صور لفاتورة محفوظة: إضافة بس (مو تعديل)، فتنسمح للكل؛ والعداد يتحدّث لحاله (القواعد تسمح بتغيير imageCount فقط)
async function appendImages(v, images) {
  await addInvoiceImages(v, images);
  const cur = S.invoices.find(x => x.id === v.id) || v;
  await B.update('invoices', v.id, { imageCount: (cur.imageCount || 0) + images.length });
  imgCache.delete(v.id);
}
async function deleteInvoiceImage(v, img, why) {
  const aid = B.newId(), now = Date.now(), cur = S.invoices.find(x => x.id === v.id) || v;
  await B.batch([
    { type: 'set', col: 'audit', id: aid, data: { ts: now, action: 'delete', kind: 'image', invoiceId: v.id, imageId: img.id, supplierName: supName(v), ref: v.ref || '', moveTs: img.ts, moveStaff: img.staffName, by: S.user.name, byId: S.user.id, why, before: { bytes: img.bytes, w: img.w, h: img.h } } },
    { type: 'update', col: 'invoiceImages', id: img.id, data: { deleted: true, deletedBy: S.user.name, deletedAt: now, lastAuditId: aid } },
    { type: 'update', col: 'invoices', id: v.id, data: { imageCount: Math.max(0, (cur.imageCount || 1) - 1), lastAuditId: aid } }
  ]);
  imgCache.delete(v.id);
}
// فتح صور فاتورة بالعارض مباشرة (من قائمة الفواتير وكشف الحساب)
async function openInvoiceImages(v) {
  if (!v) return;
  let list;
  try { list = await invoiceImages(v.id); } catch (e) { return toast('تعذّر تحميل الصور: ' + e.message, true); }
  if (!list.length) return toast('ما اكو صور محفوظة لهذي الفاتورة', true);
  imageViewer(list.map(x => x.data), 0, `فاتورة ${supName(v)}${v.ref ? ' — وصل ' + v.ref : ''}`);
}
const imgBadge = v => +v.imageCount > 0 ? `<button class="link img-link" data-imgs="${v.id}" aria-label="صور الفاتورة">${ico('image')}${v.imageCount}</button>` : '';
function bindImgLinks(scope = document) { scope.querySelectorAll('[data-imgs]').forEach(b => b.onclick = () => openInvoiceImages(S.invoices.find(x => x.id === b.dataset.imgs))); }

/* ── عارض بالتكبير: أصابع، عجلة الماوس، أزرار، ونقرتين ── */
function imageViewer(srcs, index = 0, title = 'صورة الفاتورة') {
  let i = index, z = { s: 1, x: 0, y: 0 }, start = null;
  const pts = new Map();
  const el = document.createElement('div');
  el.className = 'viewer'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="vw-bar">
      <button class="vw-btn" data-vw="close" aria-label="إغلاق">${ico('x')}</button>
      <span class="vw-title"></span>
      <button class="vw-btn" data-vw="out" aria-label="تصغير">${ico('minus')}</button>
      <span class="vw-zoom">100%</span>
      <button class="vw-btn" data-vw="in" aria-label="تكبير">${ico('plus')}</button>
      <button class="vw-btn" data-vw="reset" aria-label="إرجاع">${ico('reset')}</button>
    </div>
    <div class="vw-stage"><img alt="" draggable="false"></div>
    ${srcs.length > 1 ? `<div class="vw-strip">${srcs.map((s, n) => `<button class="vw-th" data-vw-i="${n}" aria-label="صورة ${n + 1}"><img src="${s}" alt=""></button>`).join('')}</div>` : ''}`;
  document.body.appendChild(el);
  const img = el.querySelector('.vw-stage img'), stage = el.querySelector('.vw-stage');
  const apply = (anim = true) => {
    img.style.transition = anim ? 'transform .15s' : 'none';
    img.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
    el.querySelector('.vw-zoom').textContent = Math.round(z.s * 100) + '%';
  };
  const show = n => {
    i = n; z = { s: 1, x: 0, y: 0 }; img.src = srcs[i];
    el.querySelector('.vw-title').textContent = `${title} — ${i + 1} / ${srcs.length}`;
    el.querySelectorAll('.vw-th').forEach((b, k) => b.classList.toggle('on', k === i));
    apply(false);
  };
  const zoom = f => { const s = Math.min(6, Math.max(1, z.s * f)); z = s === 1 ? { s, x: 0, y: 0 } : { ...z, s }; apply(); };
  const close = () => { el.remove(); document.removeEventListener('keydown', key); };
  const key = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft' && i < srcs.length - 1) show(i + 1); if (e.key === 'ArrowRight' && i > 0) show(i - 1); };
  document.addEventListener('keydown', key);
  el.querySelector('[data-vw="close"]').onclick = close;
  el.querySelector('[data-vw="in"]').onclick = () => zoom(1.5);
  el.querySelector('[data-vw="out"]').onclick = () => zoom(1 / 1.5);
  el.querySelector('[data-vw="reset"]').onclick = () => { z = { s: 1, x: 0, y: 0 }; apply(); };
  el.querySelectorAll('[data-vw-i]').forEach(b => b.onclick = () => show(+b.dataset.vwI));
  stage.onwheel = e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); };
  stage.ondblclick = () => { z = z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }; apply(); };
  stage.onpointerdown = e => {
    stage.setPointerCapture?.(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()];
    start = { d: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0, s: z.s, x: z.x, y: z.y, px: e.clientX, py: e.clientY };
  };
  stage.onpointermove = e => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()];
    if (p.length > 1 && start.d) z = { ...z, s: Math.min(6, Math.max(1, start.s * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) / start.d)) };
    else if (z.s > 1) z = { ...z, x: start.x + e.clientX - start.px, y: start.y + e.clientY - start.py };
    else return;
    apply(false);
  };
  stage.onpointerup = stage.onpointercancel = e => { pts.delete(e.pointerId); start = null; if (z.s <= 1.02) { z = { s: 1, x: 0, y: 0 }; apply(); } };
  show(i);
  el.querySelector('[data-vw="close"]').focus();
}

/* ═════════════ Item card (بطاقة المادة) ═════════════ */
function vItemCard() {
  const it = itemById(S.itemCard);
  if (!it) { S.itemCard = null; return vStock(); }
  const locs = S.locations, bal = balances(), avg = avgCosts().get(it.id) || 0;
  const per = locs.map(l => [l, bal.get(it.id + '|' + l.id) || 0]).filter(([l, v]) => Math.abs(v) > 0.0005 || (l.active !== false && S.moves.some(m => m.itemId === it.id && (m.toLoc === l.id || m.fromLoc === l.id))));
  const total = per.reduce((a, [, v]) => a + v, 0);
  let run = 0;
  const rows = S.moves.filter(m => m.itemId === it.id).map(m => {
    const eff = moveEffects(m), inQ = eff.filter(e => e[1] > 0).reduce((a, e) => a + e[1], 0), outQ = -eff.filter(e => e[1] < 0).reduce((a, e) => a + e[1], 0);
    run += inQ - outQ; return { m, inQ, outQ, bal: run };
  });
  const buys = S.moves.filter(m => m.itemId === it.id && (m.type === 'in' || m.type === 'opening')).slice(-8).reverse();
  const st = status(it, total);
  $('#view-root').innerHTML = `
    <div class="topline"><h1>${esc(it.name)} <span class="badge ${st[1]}" style="vertical-align:middle">${st[0]}</span></h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" id="ic-back">${ico('back')}رجوع</button><button class="btn sm" id="ic-csv">${ico('download')}تصدير</button></div></div>
    <p class="small muted" style="margin-top:-12px">${esc(grpOf(it))} — الوحدة الأساسية: ${esc(it.baseUnit)}${it.bigUnit ? ` — ${esc(it.bigUnit)} = ${fmt(packOf(it))} ${esc(it.baseUnit)}` : ''}${+it.minQty ? ` — حد الأمان: ${fmt(it.minQty)}` : ''}</p>
    <div class="kpis">
      <div class="kpi k-blue"><span class="ki">${ico('stock')}</span><div><div class="l">الرصيد الكلي</div><div class="v">${N(total)} <small class="small">${esc(it.baseUnit)}</small></div>${sub(detailed(it, total))}</div></div>
      <div class="kpi k-green"><span class="ki">${ico('wallet')}</span><div><div class="l">متوسط الكلفة / ${esc(it.baseUnit)}</div><div class="v">${M(avg)}</div>${sub(`القيمة: ${M(Math.max(total, 0) * avg)} د.ع`)}</div></div>
      <div class="kpi k-amber"><span class="ki">${ico('purchases')}</span><div><div class="l">آخر سعر شراء</div><div class="v">${buys[0] ? M(buys[0].invPrice ?? buys[0].price) : '—'}</div>${sub(buys[0] ? `لكل ${esc(buys[0].unit)} — ${esc(buys[0].supplierName || (buys[0].type === 'opening' ? 'رصيد افتتاحي' : 'وارد'))}` : '')}</div></div>
    </div>
    <div class="card"><h2>${ico('pin')} الرصيد بكل مخزن</h2>
      ${per.length ? `<div class="locs">${per.map(([l, v]) => `<div class="loc"><span class="ki">${ico('pin')}</span><span><b>${esc(l.name)}</b><span class="${v < -0.0005 ? 't-waste' : ''}">${N(v)} ${esc(it.baseUnit)}${detailed(it, v) ? ' — ' + detailed(it, v) : ''}</span></span></div>`).join('')}</div>` : '<div class="empty">ما اكو رصيد</div>'}
    </div>
    <div class="card"><h2>${ico('purchases')} آخر أسعار الشراء</h2>
      ${buys.length ? `<div class="tbl-wrap"><table><tr><th>التاريخ</th><th>المورد / الوصل</th><th class="num">الكمية</th><th class="num">سعر الوحدة</th><th class="num">الكلفة بعد التوزيع</th></tr>
        ${buys.map(m => `<tr>${dtCell(m.ts)}<td><b>${esc(m.supplierName || (m.type === 'opening' ? 'رصيد افتتاحي' : 'وارد بدون فاتورة'))}</b>${sub(m.ref ? 'وصل ' + esc(m.ref) : '')}</td><td class="num">${N(m.qty)} ${esc(m.unit)}</td><td class="num">${M(m.invPrice ?? m.price)}</td><td class="num">${M(m.cost)}</td></tr>`).join('')}
      </table></div>` : '<div class="empty">ما اكو مشتريات</div>'}
    </div>
    <div class="card"><h2>${ico('log')} الحركات والرصيد بعد كل حركة</h2>
      ${rows.length ? `<div class="tbl-wrap"><table><tr><th>الوقت</th><th>النوع</th><th>المكان</th><th class="num">داخل</th><th class="num">طالع</th><th class="num">الرصيد بعدها</th></tr>
        ${rows.slice().reverse().map(r => `<tr>${dtCell(r.m.ts)}<td class="t-${r.m.type}"><b class="tl">${ico(TYPES[r.m.type]?.ic)}${TYPES[r.m.type]?.label || r.m.type}</b>${sub(esc([r.m.supplierName, r.m.reason, r.m.staffName].filter(Boolean).join(' — ')))}</td>
          <td class="small">${esc(moveText(r.m))}</td><td class="num">${r.inQ ? N(r.inQ) : ''}</td><td class="num">${r.outQ ? N(r.outQ) : ''}</td><td class="num ${r.bal < -0.0005 ? 'neg' : ''}"><b>${N(r.bal)}</b></td></tr>`).join('')}
      </table></div>` : '<div class="empty">ما اكو حركات</div>'}
    </div>`;
  $('#ic-back').onclick = () => { S.itemCard = null; vStock(); window.scrollTo(0, 0); };
  $('#ic-csv').onclick = () => exportSheet({ file: `بطاقة_مادة_${it.name}_${today()}.xlsx`, title: `${CONFIG.title} — بطاقة مادة: ${it.name}`,
    sub: `الرصيد الكلي: ${fmt(total)} ${it.baseUnit}   |   ${per.map(([l, v]) => `${l.name}: ${fmt(v)}`).join('   |   ')}   |   متوسط الكلفة: ${money(avg)}   |   بتاريخ: ${dt(Date.now())}`,
    headers: ['التاريخ', 'النوع', 'المكان', 'داخل', 'طالع', 'الرصيد بعدها', 'الوحدة', 'المورد / السبب', 'الموظف', 'الكلفة'],
    rows: rows.map(r => [dt(r.m.ts), TYPES[r.m.type]?.label || r.m.type, moveText(r.m), r.inQ ? r3(r.inQ) : '', r.outQ ? r3(r.outQ) : '', r3(r.bal), it.baseUnit, [r.m.supplierName, r.m.reason, r.m.ref].filter(Boolean).join(' — '), r.m.staffName, r.m.cost || '']),
    qty: [3, 4, 5], money: [9] });
}

/* ═════════════ Admin ═════════════ */
function vAdmin() {
  const tab = S.adminTab;
  $('#view-root').innerHTML = `
    <div class="topline"><h1>الإدارة</h1>${modeTag()}</div>
    <div class="tabs">
      <button data-tab="items" class="${tab === 'items' ? 'on' : ''}">المواد</button>
      <button data-tab="locations" class="${tab === 'locations' ? 'on' : ''}">أماكن الخزن</button>
      <button data-tab="staff" class="${tab === 'staff' ? 'on' : ''}">الموظفين</button>
      <button data-tab="suppliers" class="${tab === 'suppliers' ? 'on' : ''}">الموردين</button>
      <button data-tab="storage" class="${tab === 'storage' ? 'on' : ''}">${storageEstimate().pct >= STORAGE_WARN ? '⚠ ' : ''}التخزين</button>
      <button data-tab="system" class="${tab === 'system' ? 'on' : ''}">النظام</button>
    </div>
    <div class="card" id="adm"></div>`;
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.adminTab = b.dataset.tab; vAdmin(); });
  ({ items: admItems, locations: admLocs, staff: admStaff, suppliers: () => vSuppliers($('#adm')), storage: admStorage, system: admSystem })[tab]();
}
const used = (field, id) => S.moves.some(m => m[field] === id);
function admItems() {
  const list = S.items.slice().sort((a, b) => (a.active === false) - (b.active === false) || (a.group || 'ي').localeCompare(b.group || 'ي', 'ar') || a.name.localeCompare(b.name, 'ar'));
  $('#adm').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span class="muted small">${list.length} مادة</span><button class="btn sm" id="ad-new">${ico('plus')}مادة جديدة</button></div>
    ${list.length ? `<div class="tbl-wrap"><table><tr><th>المادة / المجموعة</th><th>الوحدة الأساسية</th><th>الوحدة الكبيرة</th><th class="num">التعبئة</th><th class="num">حد الأمان</th><th></th></tr>
    ${list.map(i => `<tr style="${i.active === false ? 'opacity:.5' : ''}"><td><b>${esc(i.name)}</b>${i.active === false ? ' <span class="badge b-muted">موقوفة</span>' : ''}${sub(esc(i.group || 'بدون مجموعة'))}</td><td>${esc(i.baseUnit)}</td><td>${esc(i.bigUnit || '—')}</td><td class="num">${i.bigUnit ? N(i.pack) : '—'}</td><td class="num">${+i.minQty ? N(i.minQty) : '—'}</td><td><button class="link" data-ed="${i.id}">تعديل</button></td></tr>`).join('')}
    </table></div>` : `<div class="empty">ما اكو مواد. ابدي بإضافة أول مادة.</div>`}`;
  $('#ad-new').onclick = () => itemForm();
  document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => itemForm(itemById(b.dataset.ed)));
}
function itemForm(it) {
  const u = `<datalist id="units">${UNITS.map(x => `<option value="${x}">`).join('')}</datalist>`;
  const hasMoves = it && used('itemId', it.id);
  modal(`<h2>${it ? 'تعديل مادة' : 'مادة جديدة'}</h2>${u}
    <datalist id="groups">${allGroups().filter(g => g !== NOGRP).map(g => `<option value="${esc(g)}">`).join('')}</datalist>
    <div class="row">
      <div class="field"><label>اسم المادة <span class="req">*</span></label><input class="in" id="i-n" value="${esc(it?.name)}"></div>
      <div class="field"><label>المجموعة</label><input class="in" id="i-grp" list="groups" value="${esc(it?.group)}" placeholder="منظفات، سفري، ألبان…"></div>
    </div>
    <div class="row">
      <div class="field"><label>الوحدة الأساسية <span class="req">*</span></label><input class="in" id="i-b" list="units" value="${esc(it?.baseUnit)}" placeholder="قطعة، كغم…"><div class="hint">اللي تصرف وتجرد بيها</div></div>
      <div class="field"><label>حد الأمان (بالأساسية)</label><input class="in" id="i-m" type="number" min="0" step="any" value="${esc(it?.minQty ?? '')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>الوحدة الكبيرة (اختياري)</label><input class="in" id="i-g" list="units" value="${esc(it?.bigUnit)}" placeholder="كرتون، صندوق…"></div>
      <div class="field"><label>التعبئة</label><input class="in" id="i-p" type="number" min="0" step="any" value="${esc(it?.pack ?? '')}" placeholder="كم أساسية بالكبيرة"></div>
    </div>
    ${hasMoves ? '<p class="hint bad">انتبه: تغيير الوحدة أو التعبئة ما يغيّر الحركات المسجلة سابقاً.</p>' : ''}
    <div class="foot"><button class="btn" id="i-s">${ico('save')}حفظ</button><button class="btn ghost" id="i-c">إلغاء</button>
    ${it ? `<button class="btn ghost" id="i-x" style="margin-right:auto">${it.active === false ? 'إعادة تفعيل' : hasMoves ? 'إيقاف' : 'حذف'}</button>` : ''}</div>`,
    (m, close) => {
      m.querySelector('#i-c').onclick = close;
      m.querySelector('#i-s').onclick = async () => {
        const name = m.querySelector('#i-n').value.trim(), baseUnit = m.querySelector('#i-b').value.trim();
        const bigUnit = m.querySelector('#i-g').value.trim(), pack = +m.querySelector('#i-p').value || 0, minQty = +m.querySelector('#i-m').value || 0;
        if (!name || !baseUnit) return toast('الاسم والوحدة الأساسية مطلوبة', true);
        if (S.items.some(x => x.name === name && x.id !== it?.id)) return toast('اكو مادة بنفس الاسم', true);
        if (bigUnit && !(pack > 1)) return toast('اكتب التعبئة (أكبر من 1) للوحدة الكبيرة', true);
        if (bigUnit && bigUnit === baseUnit) return toast('الوحدة الكبيرة لازم تختلف عن الأساسية', true);
        const doc = { name, group: normTxt(m.querySelector('#i-grp').value), baseUnit, bigUnit, pack: bigUnit ? pack : 0, minQty };
        if (it) await B.update('items', it.id, doc);
        else await B.add('items', { ...doc, active: true, created: Date.now() });
        close(); toast('✔ انحفظت المادة');
      };
      const x = m.querySelector('#i-x');
      if (x) x.onclick = async () => {
        if (it.active === false) await B.update('items', it.id, { active: true });
        else if (hasMoves) await B.update('items', it.id, { active: false });
        else { if (!(await confirmBox(`حذف ${esc(it.name)} نهائياً؟`, 'حذف', true))) return; await B.remove('items', it.id); }
        close(); toast('✔ تم');
      };
    });
}
function admLocs() {
  const list = S.locations.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $('#adm').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span class="muted small">مثلاً: المخزن الرئيسي، البراد، الفريزر، رف المطبخ</span><button class="btn sm" id="ad-new">${ico('plus')}مكان جديد</button></div>
    ${list.length ? `<div class="tbl-wrap"><table><tr><th>المكان</th><th class="num">الترتيب</th><th></th></tr>
    ${list.map(l => `<tr style="${l.active === false ? 'opacity:.5' : ''}"><td><b>${esc(l.name)}</b>${l.active === false ? ' <span class="badge b-muted">موقوف</span>' : ''}</td><td class="num">${l.order ?? 0}</td><td><button class="link" data-ed="${l.id}">تعديل</button></td></tr>`).join('')}
    </table></div>` : `<div class="empty">ما اكو أماكن. أضف أول مكان خزن.</div>`}`;
  $('#ad-new').onclick = () => locForm();
  document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => locForm(locById(b.dataset.ed)));
}
function locForm(l) {
  const hasMoves = l && (used('fromLoc', l.id) || used('toLoc', l.id));
  modal(`<h2>${l ? 'تعديل مكان' : 'مكان خزن جديد'}</h2>
    <div class="field"><label>اسم المكان <span class="req">*</span></label><input class="in" id="l-n" value="${esc(l?.name)}"></div>
    <div class="field"><label>الترتيب بالقوائم</label><input class="in" id="l-o" type="number" value="${esc(l?.order ?? S.locations.length + 1)}"></div>
    <div class="foot"><button class="btn" id="l-s">${ico('save')}حفظ</button><button class="btn ghost" id="l-c">إلغاء</button>
    ${l ? `<button class="btn ghost" id="l-x" style="margin-right:auto">${l.active === false ? 'إعادة تفعيل' : hasMoves ? 'إيقاف' : 'حذف'}</button>` : ''}</div>`,
    (m, close) => {
      m.querySelector('#l-c').onclick = close;
      m.querySelector('#l-s').onclick = async () => {
        const name = m.querySelector('#l-n').value.trim(), order = +m.querySelector('#l-o').value || 0;
        if (!name) return toast('اكتب اسم المكان', true);
        if (S.locations.some(x => x.name === name && x.id !== l?.id)) return toast('اكو مكان بنفس الاسم', true);
        if (l) await B.update('locations', l.id, { name, order }); else await B.add('locations', { name, order, active: true });
        close(); toast('✔ انحفظ المكان');
      };
      const x = m.querySelector('#l-x');
      if (x) x.onclick = async () => {
        if (l.active === false) await B.update('locations', l.id, { active: true });
        else if (hasMoves) {
          const bal = balances(); const left = [...bal].filter(([k, v]) => k.endsWith('|' + l.id) && Math.abs(v) > 0.0005).length;
          if (left && !(await confirmBox(`بهذا المكان ${left} مادة بيها رصيد. انقلها أولاً. توقفه رغم ذلك؟`, 'إيقاف', true))) return;
          await B.update('locations', l.id, { active: false });
        } else { if (!(await confirmBox(`حذف ${esc(l.name)}؟`, 'حذف', true))) return; await B.remove('locations', l.id); }
        close(); toast('✔ تم');
      };
    });
}
function admStaff() {
  const list = S.staff.slice().sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  $('#adm').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span class="muted small">الموظف يشوف كل شي (الكلف، الجرد، التقارير، التعديلات) عدا شاشة الإدارة. التعديل والحذف للمدير وللموظف اللي عنده صلاحية «يعدّل ويحذف».</span><button class="btn sm" id="ad-new">${ico('plus')}موظف</button></div>
    <div class="tbl-wrap"><table><tr><th>الاسم</th><th>الصلاحية</th><th class="num">حركاته</th><th></th></tr>
    ${list.map(s => `<tr style="${s.active === false ? 'opacity:.5' : ''}"><td><b>${esc(s.name)}</b>${s.active === false ? ' <span class="badge b-muted">موقوف</span>' : ''}</td><td>${s.role === 'admin' ? '<span class="badge b-ok">مدير</span>' : 'موظف'}${s.role !== 'admin' && s.canEdit ? ' <span class="badge b-warn">يعدّل ويحذف</span>' : ''}</td><td class="num">${S.moves.filter(m => m.staffId === s.id).length}</td><td><button class="link" data-ed="${s.id}">تعديل</button></td></tr>`).join('')}
    </table></div>`;
  $('#ad-new').onclick = () => staffForm();
  document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => staffForm(S.staff.find(s => s.id === b.dataset.ed)));
}
function staffForm(s) {
  const admins = S.staff.filter(x => x.role === 'admin' && x.active !== false);
  modal(`<h2>${s ? 'تعديل موظف' : 'موظف جديد'}</h2>
    <div class="field"><label>الاسم <span class="req">*</span></label><input class="in" id="s-n" value="${esc(s?.name)}"></div>
    <div class="row">
      <div class="field"><label>${s ? 'رمز جديد (اتركه فارغ إذا ما تغيّره)' : 'الرمز السري'} ${s ? '' : '<span class="req">*</span>'}</label><input class="in pin" id="s-p" inputmode="numeric" maxlength="6" type="password"></div>
      <div class="field"><label>الصلاحية</label><select class="in" id="s-r"><option value="staff">موظف</option><option value="admin" ${s?.role === 'admin' ? 'selected' : ''}>مدير</option></select></div>
    </div>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="s-e" ${s?.canEdit ? 'checked' : ''}> يسمح له بتعديل وحذف الحركات <span class="small muted">(المدير مسموح دائماً)</span></label>
    <div class="foot"><button class="btn" id="s-s">${ico('save')}حفظ</button><button class="btn ghost" id="s-c">إلغاء</button>
    ${s && s.id !== S.user.id ? `<button class="btn ghost" id="s-x" style="margin-right:auto">${s.active === false ? 'إعادة تفعيل' : 'إيقاف'}</button>` : ''}</div>`,
    (m, close) => {
      m.querySelector('#s-c').onclick = close;
      m.querySelector('#s-s').onclick = async () => {
        const name = m.querySelector('#s-n').value.trim(), pin = m.querySelector('#s-p').value.trim(), role = m.querySelector('#s-r').value;
        if (!name) return toast('اكتب الاسم', true);
        if (S.staff.some(x => x.name === name && x.id !== s?.id)) return toast('اكو موظف بنفس الاسم', true);
        if ((!s || pin) && !/^\d{4,6}$/.test(pin)) return toast('الرمز من 4 إلى 6 أرقام', true);
        if (s && s.role === 'admin' && role !== 'admin' && admins.length <= 1) return toast('لازم يبقى مدير واحد على الأقل', true);
        if (s && s.name !== name && !pin) return toast('عند تغيير الاسم اكتب رمز جديد', true);
        const doc = { name, role, canEdit: m.querySelector('#s-e').checked };
        if (pin) doc.pinHash = await hashPin(name, pin);
        if (s) await B.update('staff', s.id, doc); else await B.add('staff', { ...doc, active: true, created: Date.now() });
        close(); toast('✔ انحفظ');
      };
      const x = m.querySelector('#s-x');
      if (x) x.onclick = async () => {
        if (s.active !== false && s.role === 'admin' && admins.length <= 1) return toast('لازم يبقى مدير واحد على الأقل', true);
        await B.update('staff', s.id, { active: s.active === false });
        close(); toast('✔ تم');
      };
    });
}

/* ═════════════ Formatted Excel export ═════════════ */
async function exportSheet(o) {
  let X;
  try { X = await loadXLSX(); } catch { return csvDownload(o.file.replace(/\.xlsx$/, '.csv'), [o.headers, ...o.rows.filter(Array.isArray)]); }
  const nC = o.headers.length, enc = X.utils.encode_cell;
  const line = { style: 'thin', color: { rgb: 'C9D6E3' } }, border = { top: line, bottom: line, left: line, right: line };
  const font = (x = {}) => ({ name: 'Arial', sz: 11, ...x });
  const aoa = [[o.title], [o.sub || ''], [], o.headers];
  const kinds = ['title', 'sub', 'blank', 'head'];
  for (const r of o.rows) {
    if (Array.isArray(r)) { aoa.push(r.map(v => v ?? '')); kinds.push('row'); }
    else { aoa.push([`📁 ${r.group}`, ...Array(nC - 1).fill('')]); kinds.push('group'); }
  }
  const first = 4, last = aoa.length - 1;
  if (o.totals) { const t = Array(nC).fill(''); t[0] = o.totals.label; aoa.push(t); kinds.push('total'); }
  const ws = X.utils.aoa_to_sheet(aoa);
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: nC - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: nC - 1 } }];
  kinds.forEach((k, r) => { if (k === 'group') merges.push({ s: { r, c: 0 }, e: { r, c: nC - 1 } }); });
  ws['!merges'] = merges;
  const qty = new Set(o.qty || []), mon = new Set(o.money || []);
  kinds.forEach((k, r) => {
    for (let c = 0; c < nC; c++) {
      const a = enc({ r, c });
      if (!ws[a]) ws[a] = { t: 's', v: '' };
      const cell = ws[a];
      const al = { vertical: 'center', horizontal: (qty.has(c) || mon.has(c)) ? 'center' : 'right', readingOrder: 2, wrapText: k === 'sub' };
      if (k === 'title') cell.s = { font: font({ sz: 16, bold: true, color: { rgb: '0B3D6E' } }), alignment: { horizontal: 'right', readingOrder: 2 } };
      else if (k === 'sub') cell.s = { font: font({ sz: 10, color: { rgb: '5B6B7A' } }), alignment: { horizontal: 'right', readingOrder: 2 } };
      else if (k === 'head') cell.s = { font: font({ bold: true, color: { rgb: 'FFFFFF' } }), fill: { fgColor: { rgb: '0B3D6E' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true, readingOrder: 2 }, border };
      else if (k === 'group') cell.s = { font: font({ bold: true, color: { rgb: '0B3D6E' } }), fill: { fgColor: { rgb: 'E7F1FB' } }, alignment: { horizontal: 'right', readingOrder: 2 }, border };
      else if (k === 'row') {
        cell.s = { font: font(), alignment: al, border, ...(r % 2 ? {} : { fill: { fgColor: { rgb: 'F7FAFD' } } }) };
        if (cell.t === 'n') cell.z = mon.has(c) ? '#,##0' : '#,##0.###';
      } else if (k === 'total') {
        if (o.totals.cols.includes(c)) { const col = X.utils.encode_col(c); ws[a] = { t: 'n', f: `SUM(${col}${first + 1}:${col}${last + 1})`, z: '#,##0' }; }
        ws[a].s = { font: font({ bold: true, color: { rgb: '0B3D6E' } }), fill: { fgColor: { rgb: 'FFF2B3' } }, alignment: { ...al, horizontal: o.totals.cols.includes(c) ? 'center' : 'right' }, border: { ...border, top: { style: 'medium', color: { rgb: 'F5D312' } } } };
      }
    }
  });
  ws['!cols'] = o.headers.map((h, c) => {
    let w = String(h).length;
    aoa.slice(4).forEach((row, i) => { if (kinds[i + 4] === 'row') w = Math.max(w, String(row[c] ?? '').length); });
    return { wch: Math.min(Math.max(w + 3, 9), 40) };
  });
  ws['!rows'] = [{ hpt: 26 }, { hpt: 18 }, { hpt: 6 }, { hpt: 30 }];
  const wb = X.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  X.utils.book_append_sheet(wb, ws, 'البيانات');
  X.writeFile(wb, o.file);
}

/* ═════════════ Import from Excel ═════════════ */
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'xlsx.full.min.js'; sc.onload = () => res(window.XLSX); sc.onerror = () => rej(new Error('تعذّر تحميل قارئ الإكسل')); document.head.appendChild(sc); });
}
const normTxt = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const normKey = v => normTxt(v).replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
const toNum = v => { if (v === '' || v == null) return null; const n = +String(v).replace(/[,\s]/g, '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)); return isFinite(n) ? n : NaN; };
const IMP_COLS = { loc: ['المخزن', 'مكان الخزن', 'المكان'], name: ['اسم المادة', 'المادة'], group: ['المجموعة', 'المجموعه', 'التصنيف'], base: ['الوحدة الأساسية', 'الوحدة الاساسية', 'الوحدة'], big: ['الوحدة الكبيرة'], pack: ['التعبئة'], qty: ['الرصيد'], price: ['سعر الوحدة الأساسية', 'سعر الوحدة الاساسية', 'السعر', 'سعر القطعة'], min: ['حد الأمان', 'حد الامان'] };
async function importExcel(file) {
  let XLSX;
  try { XLSX = await loadXLSX(); } catch (e) { return toast(e.message, true); }
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sh = wb.Sheets[wb.SheetNames.find(n => normTxt(n) === 'المواد') || wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '', raw: true });
  // find header row
  let hr = -1, map = {};
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const row = grid[r].map(normKey), m = {};
    for (const [k, names] of Object.entries(IMP_COLS)) { const i = row.findIndex(c => names.some(n => c.startsWith(normKey(n)))); if (i >= 0) m[k] = i; }
    if (m.name != null && m.base != null) { hr = r; map = m; break; }
  }
  if (hr < 0) return toast('ما لكيت عمود «اسم المادة» و«الوحدة الأساسية» بالملف', true);
  const errs = [], rows = [];
  const itemsByKey = new Map(S.items.map(i => [normKey(i.name), i]));
  const locsByKey = new Map(S.locations.map(l => [normKey(l.name), l]));
  const newItems = new Map(), newLocs = new Map();
  for (let r = hr + 1; r < grid.length; r++) {
    const g = k => map[k] == null ? '' : grid[r][map[k]];
    const name = normTxt(g('name')); if (!name) continue;
    const line = r + 1, grp = normTxt(g('group')), loc = normTxt(g('loc')), base = normTxt(g('base')), big = normTxt(g('big'));
    const pack = toNum(g('pack')), qty = toNum(g('qty')) ?? 0, price = toNum(g('price')) ?? 0, min = toNum(g('min')) ?? 0;
    if (!base) { errs.push(`سطر ${line}: «${name}» بدون وحدة أساسية`); continue; }
    if (big && !(pack > 1)) { errs.push(`سطر ${line}: «${name}» بيه وحدة كبيرة بدون تعبئة صحيحة`); continue; }
    if ([pack, qty, price, min].some(Number.isNaN) || qty < 0 || price < 0) { errs.push(`سطر ${line}: «${name}» بيه رقم غير صحيح`); continue; }
    if (qty > 0 && !loc) { errs.push(`سطر ${line}: «${name}» بيه رصيد بدون مخزن`); continue; }
    if (qty > 0 && !(price > 0)) { errs.push(`سطر ${line}: «${name}» بيه رصيد بدون سعر`); continue; }
    const ik = normKey(name), ex = itemsByKey.get(ik) || newItems.get(ik);
    if (ex && (ex.baseUnit !== base)) { errs.push(`سطر ${line}: «${name}» مكتوبة بوحدة «${base}» وبمكان ثاني «${ex.baseUnit}»`); continue; }
    if (!ex) newItems.set(ik, { id: B.newId(), name, group: grp, baseUnit: base, bigUnit: big, pack: big ? pack : 0, minQty: min, active: true, created: Date.now() });
    if (loc && !locsByKey.get(normKey(loc)) && !newLocs.get(normKey(loc))) newLocs.set(normKey(loc), { id: B.newId(), name: loc, order: S.locations.length + newLocs.size + 1, active: true });
    if (qty > 0) rows.push({ ik, lk: normKey(loc), qty, price, line });
  }
  const dupBal = new Map(); rows.forEach(x => { const k = x.ik + '|' + x.lk; dupBal.set(k, (dupBal.get(k) || 0) + 1); });
  const dups = [...dupBal].filter(([, n]) => n > 1).length;
  const totalVal = rows.reduce((a, x) => a + x.qty * x.price, 0);
  const already = rows.filter(x => { const it = itemsByKey.get(x.ik), lc = locsByKey.get(x.lk); return it && lc && S.moves.some(m => m.type === 'opening' && m.itemId === it.id && m.toLoc === lc.id); }).length;
  modal(`<h2>مراجعة الاستيراد</h2>
    <p class="small muted" style="margin-top:-6px">${esc(file.name)}</p>
    <div class="kpis" style="grid-template-columns:repeat(2,1fr)">
      <div class="kpi"><div class="l">مخازن جديدة</div><div class="v">${newLocs.size}</div></div>
      <div class="kpi"><div class="l">مواد جديدة</div><div class="v">${newItems.size}</div></div>
      <div class="kpi"><div class="l">أرصدة افتتاحية</div><div class="v">${rows.length}</div></div>
      <div class="kpi"><div class="l">قيمتها (د.ع)</div><div class="v">${M(totalVal)}</div></div>
    </div>
    ${newLocs.size ? `<p class="small"><b>المخازن الجديدة:</b> ${[...newLocs.values()].map(l => esc(l.name)).join('، ')}</p>` : ''}
    ${already ? `<p class="hint bad">⚠ ${already} رصيد من هذا الملف مسجّل سابقاً كرصيد افتتاحي بنفس المخزن. إذا تستورد، راح يتكرر وينضاعف. الغالب انت مستورد هذا الملف قبل.</p>` : ''}
    ${dups ? `<p class="hint bad">${dups} مادة مكررة بنفس المخزن، راح تنجمع أرصدتها.</p>` : ''}
    ${errs.length ? `<div class="card" style="background:var(--bad-soft);box-shadow:none"><b>${errs.length} سطر فيه مشكلة وراح يتجاوزه:</b><div class="small" style="max-height:160px;overflow:auto;margin-top:6px">${errs.map(esc).join('<br>')}</div></div>` : '<p class="hint ok">✔ ما اكو أخطاء بالملف</p>'}
    <div class="foot"><button class="btn" id="im-go" ${!newItems.size && !rows.length && !newLocs.size ? 'disabled' : ''}>استيراد</button><button class="btn ghost" id="im-c">إلغاء</button></div>`,
    (md, close) => {
      md.querySelector('#im-c').onclick = close;
      md.querySelector('#im-go').onclick = async () => {
        md.querySelector('#im-go').disabled = true; md.querySelector('#im-go').textContent = 'جاري الاستيراد…';
        const ts = Date.now(), ops = [];
        for (const l of newLocs.values()) { const { id, ...d } = l; ops.push({ type: 'set', col: 'locations', id, data: d }); }
        for (const it of newItems.values()) { const { id, ...d } = it; ops.push({ type: 'set', col: 'items', id, data: d }); }
        for (const x of rows) {
          const it = itemsByKey.get(x.ik) || newItems.get(x.ik), lc = locsByKey.get(x.lk) || newLocs.get(x.lk);
          ops.push({ type: 'set', col: 'moves', id: B.newId(), data: { ts, type: 'opening', itemId: it.id, itemName: it.name, unit: it.baseUnit, qty: r3(x.qty), factor: 1, baseQty: r3(x.qty), baseUnit: it.baseUnit,
            price: x.price, cost: Math.round(x.qty * x.price), fromLoc: '', toLoc: lc.id, reason: '', ref: '', note: 'استيراد من إكسل', staffId: S.user.id, staffName: S.user.name } });
        }
        try { await B.batch(ops); }
        catch (e) { md.querySelector('#im-go').disabled = false; md.querySelector('#im-go').textContent = 'استيراد'; return toast('فشل الاستيراد: ' + e.message, true); }
        close(); toast(`✔ انضاف ${newItems.size} مادة و${rows.length} رصيد`);
      };
    });
}

/* ═════════════ Storage estimate (التخزين) ═════════════
   تقدير لحجم البيانات بـ Firestore مقابل حد الخطة (المجانية Spark = 1GB). الصور هي الأغلب:
   كل صورة ~250KB وتنخزن نص base64 فتصير ~340KB. الصور المحذوفة تبقى بالقاعدة فتنحسب.
   بعد الترقية لخطة Blaze: ضيف storageLimitGB بـ config.js (مثلاً 5) حتى يتغير الحد. */
const STORAGE_LIMIT_GB = CONFIG.storageLimitGB || 1;
const STORAGE_WARN = 80, IMG_STORED = 340 * 1024;
function storageEstimate() {
  const imgs = S.invoices.reduce((a, v) => a + (+v.imageCount || 0), 0) + S.audit.filter(x => x.kind === 'image' && x.action === 'delete').length;
  const json = new Blob([JSON.stringify([S.items, S.locations, S.staff, S.allMoves, S.stocktakes, S.audit, S.suppliers, S.invoices, S.payments])]).size;
  const other = json * 2; // البيانات + فهارس Firestore (تقريباً)
  const imgBytes = imgs * IMG_STORED, used = imgBytes + other, limit = STORAGE_LIMIT_GB * 1024 ** 3;
  return { imgs, imgBytes, other, used, limit, pct: used / limit * 100 };
}
const mb = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0) + ' MB';
// تحذير بالرئيسية للمدير بس، من يوصل 80%
function storageAlert() {
  if (!isAdmin()) return '';
  const e = storageEstimate();
  if (e.pct < STORAGE_WARN) return '';
  return `<div class="store-alert">${ico('alert')}<div><b>الخزن قرب يمتلي: ${Math.round(e.pct)}% من ${STORAGE_LIMIT_GB}GB</b><span>إذا امتلى، Firebase يوقف تسجيل كل شي. رقّي لخطة Blaze — التفاصيل بالإدارة ← التخزين.</span></div></div>`;
}
function admStorage() {
  const e = storageEstimate(), pct = Math.min(100, e.pct), lvl = e.pct >= STORAGE_WARN ? 'bad' : e.pct >= 60 ? 'warn' : 'ok';
  const left = Math.max(0, Math.floor((e.limit - e.used) / IMG_STORED));
  $('#adm').innerHTML = `
    <h2>${ico('stock')} التخزين بـ Firebase</h2>
    <div class="store-meter ${lvl}">
      <div class="sm-top"><b>${Math.round(e.pct)}%</b><span>${mb(e.used)} من ${STORAGE_LIMIT_GB} GB</span></div>
      <div class="sm-bar"><i style="width:${pct.toFixed(1)}%"></i><em style="inset-inline-start:${STORAGE_WARN}%"></em></div>
      <div class="sm-legend"><span>0</span><span class="w" style="inset-inline-start:${STORAGE_WARN}%">تحذير ${STORAGE_WARN}%</span><span>${STORAGE_LIMIT_GB} GB</span></div>
    </div>
    ${lvl === 'bad' ? `<div class="store-alert">${ico('alert')}<div><b>وصلت ${Math.round(e.pct)}% — وكت الترقية</b><span>إذا امتلى الخزن، Firebase يوقف كل الكتابة (حتى الصرف والجرد) لحد ما ترقّي.</span></div></div>`
      : lvl === 'warn' ? `<p class="hint" style="color:var(--warn);font-weight:700">قربت من التحذير. خطط للترقية خلال الأشهر الجاية.</p>` : ''}
    <div class="kpis" style="margin-top:16px">
      <div class="kpi k-blue"><span class="ki">${ico('image')}</span><div><div class="l">صور الفواتير</div><div class="v">${e.imgs}</div>${sub(mb(e.imgBytes) + ' تقريباً')}</div></div>
      <div class="kpi k-green"><span class="ki">${ico('log')}</span><div><div class="l">باقي البيانات</div><div class="v">${mb(e.other)}</div>${sub('المواد، الحركات، الفواتير، السجل')}</div></div>
      <div class="kpi k-amber"><span class="ki">${ico('camera')}</span><div><div class="l">يتحمل بعد</div><div class="v">~${left.toLocaleString('en-US')}</div>${sub('صورة تقريباً')}</div></div>
    </div>
    <p class="small muted">هذا <b>تقدير</b> محسوب من عدد الصور وحجم البيانات. الرقم الدقيق: Firebase Console ← Firestore Database ← تبويب Usage. الصور المحذوفة تبقى بالقاعدة (حتى يبقى السجل كامل) فتنحسب.</p>
    <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
    <h2>${ico('wallet')} لما توصل التحذير</h2>
    <ol class="small store-steps">
      <li>Firebase Console ← مشروع stock-dc518 ← Upgrade ← خطة <b>Blaze</b> (تربط بطاقة، والدفع شهري حسب الاستخدام).</li>
      <li>الـ 1GB الأول يبقى مجاني؛ الزيادة تقريباً 0.18–0.21$ لكل GB بالشهر.</li>
      <li>حط <b>Budget alert</b> (مثلاً 2$ بالشهر) حتى يوصلك إيميل إذا الكلفة زادت.</li>
      <li>گلّي حتى أرفع الحد هنا (storageLimitGB) وينطفي التحذير.</li>
    </ol>`;
}
function admSystem() {
  const last = localStorage.getItem('inv_last_backup');
  $('#adm').innerHTML = `
    <h2>استيراد من إكسل</h2>
    <p class="small muted">ترفع ملف إكسل بيه المواد وأرصدتها (حسب القالب)، والنظام يضيف المخازن والمواد والأرصدة الافتتاحية مرة وحدة. المواد الموجودة مسبقاً بنفس الاسم ما تتكرر.</p>
    <input type="file" id="imp-f" accept=".xlsx,.xls,.csv" hidden>
    <button class="btn" id="imp">${ico('upload')}اختيار ملف الإكسل</button>
    <hr style="border:0;border-top:1px solid var(--line);margin:22px 0">
    <h2>النسخة الاحتياطية</h2>
    <p class="small muted">ينزّل ملف بيه كل البيانات (المواد، الأماكن، الموظفين، كل الحركات، الجرودات، الموردين والفواتير والتسديدات وصور الفواتير). احتفظ بيه بمكان آمن. يُنصح كل أسبوع أو كل شهر.</p>
    <p class="small">آخر نسخة من هذا الجهاز: <b>${last ? dt(+last) : 'ما اكو'}</b></p>
    <button class="btn" id="bk">${ico('download')}تنزيل نسخة احتياطية</button>
    <hr style="border:0;border-top:1px solid var(--line);margin:22px 0">
    <h2>هذا الجهاز</h2>
    <p class="small muted">إلغاء التفعيل يخلي هذا الجهاز يحتاج كلمة سر المطعم مرة ثانية. استخدمه إذا الجهاز راح يطلع من المطعم أو ضاع.</p>
    ${B.mode === 'firebase' ? '<button class="btn danger" id="dv-out">إلغاء تفعيل هذا الجهاز</button>' : '<span class="mode">وضع تجربة</span>'}`;
  $('#imp').onclick = () => $('#imp-f').click();
  $('#imp-f').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importExcel(f); };
  $('#bk').onclick = async () => {
    const bk = $('#bk'); bk.disabled = true;
    let invoiceImages = [];
    try { if (S.invoices.some(v => +v.imageCount > 0)) { toast('جاري تحميل صور الفواتير للنسخة…'); invoiceImages = await B.allImages(); } }
    catch (e) { bk.disabled = false; return toast('تعذّر تحميل الصور: ' + e.message, true); }
    bk.disabled = false;
    const data = { exportedAt: new Date().toISOString(), title: CONFIG.title, items: S.items, locations: S.locations, staff: S.staff.map(({ pinHash, ...x }) => x), moves: S.allMoves, stocktakes: S.stocktakes, audit: S.audit, suppliers: S.suppliers, invoices: S.invoices, payments: S.payments, invoiceImages };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = `نسخة_احتياطية_${today()}.json`; a.click();
    localStorage.setItem('inv_last_backup', Date.now()); setTimeout(admSystem, 300);
  };
  if ($('#dv-out')) $('#dv-out').onclick = async () => {
    if (!(await confirmBox('إلغاء تفعيل هذا الجهاز؟ راح يحتاج كلمة سر المطعم حتى يشتغل مرة ثانية.', 'إلغاء التفعيل', true))) return;
    localStorage.removeItem('inv_session'); await B.signOut(); location.reload();
  };
}

boot();
