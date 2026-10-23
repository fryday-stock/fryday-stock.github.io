import { CONFIG } from './config.js';

/* ═════════════ Data layer: Firebase (online) or Local (demo) ═════════════ */
const COLS = ['items', 'locations', 'staff', 'moves', 'stocktakes'];

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
    watch(c, cb) { (subs[c] = subs[c] || []).push(cb); cb(read(c)); },
    async add(c, obj) { const id = uid(); write(c, [...read(c), { ...obj, id }]); return id; },
    async addMany(c, objs) { write(c, [...read(c), ...objs.map(o => ({ ...o, id: uid() }))]); },
    async update(c, id, patch) { write(c, read(c).map(x => x.id === id ? { ...x, ...patch } : x)); },
    async remove(c, id) { write(c, read(c).filter(x => x.id !== id)); }
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
  await au.signInAnonymously(au.getAuth(app));
  return {
    mode: 'firebase',
    watch(c, cb) { fs.onSnapshot(fs.collection(db, c), s => cb(s.docs.map(d => ({ ...d.data(), id: d.id })))); },
    async add(c, obj) { return (await fs.addDoc(fs.collection(db, c), obj)).id; },
    async addMany(c, objs) {
      for (let i = 0; i < objs.length; i += 400) {
        const b = fs.writeBatch(db);
        objs.slice(i, i + 400).forEach(o => b.set(fs.doc(fs.collection(db, c)), o));
        await b.commit();
      }
    },
    async update(c, id, patch) { await fs.updateDoc(fs.doc(db, c, id), patch); },
    async remove(c, id) { await fs.deleteDoc(fs.doc(db, c, id)); }
  };
}

/* ═════════════ Constants ═════════════ */
const TYPES = {
  in:       { label: 'وارد',          ic: '📥', sign: 'to' },
  out:      { label: 'صرف / سحب',     ic: '📤', sign: 'from' },
  transfer: { label: 'نقل',           ic: '🔁', sign: 'both' },
  waste:    { label: 'تالف',          ic: '🗑️', sign: 'from' },
  return:   { label: 'مرتجع للمورد',  ic: '↩️', sign: 'from' },
  opening:  { label: 'رصيد افتتاحي',  ic: '🏁', sign: 'to' },
  adjust:   { label: 'تسوية جرد',     ic: '⚖️', sign: 'adj' }
};
const OUT_REASONS = ['صرف للمطبخ', 'صرف للصالة / البار', 'ضيافة', 'استخدام شخصي (موظفين)', 'أخرى'];
const WASTE_REASONS = ['منتهي الصلاحية', 'تلف / خراب', 'سقوط / كسر', 'خطأ تحضير', 'أخرى'];
const UNITS = ['كغم', 'غم', 'لتر', 'مل', 'قطعة', 'حبة', 'بطل', 'علبة', 'كرتون', 'صندوق', 'كيس', 'شدة', 'ربطة', 'دبة', 'قنينة', 'طبق', 'درزن', 'باكيت', 'رول'];

/* ═════════════ State ═════════════ */
const S = {
  items: [], locations: [], staff: [], moves: [], stocktakes: [],
  loaded: new Set(),
  user: null,
  view: 'home',
  stockLoc: 'all', stockQ: '',
  log: { from: monthStart(), to: today(), type: '', staff: '', q: '' },
  rep: { month: today().slice(0, 7) },
  adminTab: 'items',
  st: { loc: '', counts: {} },
  mv: null
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
const activeItems = () => S.items.filter(i => i.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
const activeLocs = () => S.locations.filter(l => l.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ar'));
const packOf = it => (it?.bigUnit && +it.pack > 0) ? +it.pack : 1;
const unitsOf = it => it ? [it.baseUnit, ...(it.bigUnit && +it.pack > 0 ? [it.bigUnit] : [])] : [];

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
  const saved = localStorage.getItem('inv_session');
  COLS.forEach(c => B.watch(c, rows => {
    S[c] = rows; S.loaded.add(c);
    if (c === 'moves') S.moves.sort((a, b) => a.ts - b.ts);
    if (c === 'staff' && saved && !S.user) { const u = rows.find(s => s.id === saved && s.active !== false); if (u) S.user = u; }
    if (c === 'staff' && S.user) { const u = rows.find(s => s.id === S.user.id); if (!u || u.active === false) { S.user = null; localStorage.removeItem('inv_session'); } else S.user = u; }
    if (S.loaded.size === COLS.length) onData();
  }));
}
function onData() {
  // Avoid wiping forms the user is filling
  if (S.user && (S.view === 'move' || S.view === 'stocktake') && $('#view-root')) { refreshLive(); return; }
  render();
}

/* ═════════════ Render root ═════════════ */
const NAV = [
  ['home', '🏠', 'الرئيسية'],
  ['move', '➕', 'حركة جديدة'],
  ['stock', '📦', 'الأرصدة'],
  ['log', '🧾', 'السجل'],
  ['stocktake', '⚖️', 'الجرد', true],
  ['reports', '📊', 'التقارير', true],
  ['admin', '⚙️', 'الإدارة', true]
];
function render() {
  if (!S.staff.length) return renderSetup();
  if (!S.user) return renderLogin();
  const nav = NAV.filter(n => !n[3] || isAdmin());
  if (!nav.find(n => n[0] === S.view)) S.view = 'home';
  $('#app').innerHTML = `
  <div class="mobile-head"><span>${esc(CONFIG.title)}</span><span>${esc(S.user.name)} <button id="lo2">خروج</button></span></div>
  <div class="shell">
    <aside class="side">
      <div class="brand">${esc(CONFIG.title)}<small>نظام المخزن</small></div>
      ${nav.map(n => `<button class="nav ${S.view === n[0] ? 'on' : ''}" data-go="${n[0]}"><span class="ic">${n[1]}</span>${n[2]}</button>`).join('')}
      <div class="me">👤 ${esc(S.user.name)} <span class="small">(${S.user.role === 'admin' ? 'مدير' : 'موظف'})</span><br><button class="btn ghost sm" id="lo">تسجيل خروج</button></div>
    </aside>
    <main class="main" id="view-root"></main>
  </div>
  <nav class="bottom">${nav.map(n => `<button class="${S.view === n[0] ? 'on' : ''}" data-go="${n[0]}"><span class="ic">${n[1]}</span>${n[2]}</button>`).join('')}</nav>`;
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  const lo = () => { S.user = null; localStorage.removeItem('inv_session'); render(); };
  $('#lo').onclick = lo; $('#lo2').onclick = lo;
  const views = { home: vHome, move: vMove, stock: vStock, log: vLog, stocktake: vStocktake, reports: vReports, admin: vAdmin };
  views[S.view]();
  window.scrollTo(0, 0);
}
function go(v, opts = {}) {
  S.view = v;
  if (v === 'move') S.mv = newMove(opts.type || 'out');
  if (v === 'stock' && opts.loc) S.stockLoc = opts.loc;
  render();
}
const modeTag = () => B.mode === 'local' ? `<span class="mode">وضع تجربة — البيانات على هذا الجهاز فقط</span>` : '';

/* ═════════════ Setup & Login ═════════════ */
function renderSetup() {
  $('#app').innerHTML = `<div class="login"><div class="box">
    <h1>${esc(CONFIG.title)}</h1><p class="sub">أول تشغيل: أنشئ حساب المدير</p>
    <div class="field"><label>اسم المدير</label><input class="in" id="su-n" placeholder="مثلاً: أحمد"></div>
    <div class="field"><label>رمز سري (4 أرقام)</label><input class="in pin" id="su-p" inputmode="numeric" maxlength="6" type="password"></div>
    <button class="btn big" id="su-go">إنشاء والدخول</button>
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
    <h1>${esc(CONFIG.title)}</h1><p class="sub">اختر اسمك واكتب رمزك</p>
    <div class="staff-grid">${staff.map(s => `<button data-id="${s.id}">${esc(s.name)}</button>`).join('')}</div>
    <div class="field"><input class="in pin" id="lg-p" inputmode="numeric" maxlength="6" type="password" placeholder="••••"></div>
    <button class="btn big" id="lg-go">دخول</button>
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
    <div class="actions">
      ${['in', 'out', 'transfer', 'waste', 'return'].map(t => `<button class="act ${t}" data-t="${t}"><span class="ic">${TYPES[t].ic}</span>${TYPES[t].label}</button>`).join('')}
    </div>
    <div class="kpis">
      <div class="kpi"><div class="l">عدد المواد</div><div class="v">${items.length}</div></div>
      ${isAdmin() ? `<div class="kpi"><div class="l">قيمة المخزون (د.ع)</div><div class="v">${M(value)}</div></div>` : ''}
      <div class="kpi ${low.length ? 'warn' : ''}"><div class="l">مواد تحتاج طلب</div><div class="v">${low.length}</div></div>
      <div class="kpi"><div class="l">حركات اليوم</div><div class="v">${todayMoves.length}</div></div>
    </div>
    <div class="two">
      <div class="card"><h2>أماكن الخزن</h2>
        ${locs.length ? `<div class="locs">${locs.map(l => `<button class="loc" data-loc="${l.id}"><b>${esc(l.name)}</b><span>${locCount(l.id)} مادة متوفرة</span></button>`).join('')}</div>`
        : `<div class="empty">ما اكو أماكن خزن بعد. ${isAdmin() ? 'أضفها من الإدارة.' : ''}</div>`}
      </div>
      <div class="card"><h2>تحتاج طلب</h2>
        ${low.length ? `<div class="tbl-wrap"><table><tr><th>المادة</th><th class="num">الرصيد</th><th>الحالة</th></tr>
          ${low.slice(0, 15).map(it => { const q = tot.get(it.id) || 0, st = status(it, q); return `<tr><td>${esc(it.name)}</td><td class="num">${N(q)} ${esc(it.baseUnit)}</td><td><span class="badge ${st[1]}">${st[0]}</span></td></tr>`; }).join('')}
        </table></div>` : `<div class="empty">كل المواد كافية ✔</div>`}
      </div>
    </div>
    <div class="card"><h2>آخر الحركات</h2>${movesTable(S.moves.slice(-8).reverse(), false)}</div>`;
  document.querySelectorAll('.act').forEach(b => b.onclick = () => go('move', { type: b.dataset.t }));
  document.querySelectorAll('[data-loc]').forEach(b => b.onclick = () => go('stock', { loc: b.dataset.loc }));
}

/* ═════════════ Movement form ═════════════ */
function newMove(type) {
  const prev = S.mv || {};
  return { type, itemId: '', unit: '', qty: '', price: '', fromLoc: prev.fromLoc || '', toLoc: prev.toLoc || '', reason: '', note: '', ref: '', q: '' };
}
function vMove() {
  const mv = S.mv || (S.mv = newMove('out'));
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
      <div class="seg">${types.map(t => `<button data-type="${t}" class="${mv.type === t ? 'on' : ''}">${TYPES[t].ic} ${TYPES[t].label}</button>`).join('')}</div>
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
      <button class="btn big" id="mv-save">تأكيد ${TYPES[mv.type].label}</button>
    </div>`;

  document.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { S.mv.type = b.dataset.type; S.mv.reason = ''; vMove(); });
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
function vStock() {
  const bal = balances(), tot = totalsByItem(bal), avg = avgCosts();
  const locs = activeLocs();
  if (S.stockLoc !== 'all' && !locById(S.stockLoc)) S.stockLoc = 'all';
  const L = S.stockLoc;
  const q = S.stockQ.trim();
  let rows = activeItems().map(it => ({ it, qty: L === 'all' ? (tot.get(it.id) || 0) : (bal.get(it.id + '|' + L) || 0) }));
  if (L !== 'all') rows = rows.filter(r => Math.abs(r.qty) > 0.0005 || S.moves.some(m => m.itemId === r.it.id && (m.fromLoc === L || m.toLoc === L)));
  if (q) rows = rows.filter(r => r.it.name.includes(q));
  const per = it => locs.map(l => [l, bal.get(it.id + '|' + l.id) || 0]).filter(x => Math.abs(x[1]) > 0.0005);
  $('#view-root').innerHTML = `
    <div class="topline"><h1>الأرصدة</h1>
      <div style="display:flex;gap:8px"><input class="in" id="sk-q" placeholder="بحث…" value="${esc(S.stockQ)}" style="width:180px">
      <button class="btn ghost sm" id="sk-csv">تصدير</button></div></div>
    <div class="chips"><button data-l="all" class="${L === 'all' ? 'on' : ''}">كل الأماكن</button>${locs.map(l => `<button data-l="${l.id}" class="${L === l.id ? 'on' : ''}">${esc(l.name)}</button>`).join('')}</div>
    <div class="card"><div class="tbl-wrap">${rows.length ? `<table>
      <tr><th>المادة</th><th class="num">الرصيد</th><th>مفصّل</th>${L === 'all' ? '<th>التوزيع على الأماكن</th><th class="num">حد الأمان</th>' : ''}${isAdmin() ? '<th class="num">القيمة (د.ع)</th>' : ''}<th>الحالة</th></tr>
      ${rows.map(({ it, qty }) => { const st = L === 'all' ? status(it, qty) : (qty < -0.0005 ? ['رصيد سالب', 'b-bad'] : Math.abs(qty) < 0.0005 ? ['فارغ', 'b-muted'] : ['متوفر', 'b-ok']);
        return `<tr><td><b>${esc(it.name)}</b></td><td class="num ${qty < -0.0005 ? 'neg' : ''}">${N(qty)} ${esc(it.baseUnit)}</td><td class="small">${detailed(it, qty)}</td>
        ${L === 'all' ? `<td class="small muted">${per(it).map(([l, v]) => `${esc(l.name)}: ${N(v)}`).join(' · ')}</td><td class="num">${+it.minQty ? N(it.minQty) : '—'}</td>` : ''}
        ${isAdmin() ? `<td class="num">${M(Math.max(qty, 0) * (avg.get(it.id) || 0))}</td>` : ''}
        <td><span class="badge ${st[1]}">${st[0]}</span></td></tr>`; }).join('')}
    </table>` : `<div class="empty">ما اكو مواد ${q ? 'بهذا البحث' : L !== 'all' ? 'بهذا المكان' : 'بعد'}</div>`}</div></div>`;
  document.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { S.stockLoc = b.dataset.l; vStock(); });
  $('#sk-q').oninput = e => { S.stockQ = e.target.value; const p = e.target.selectionStart; vStock(); const n = $('#sk-q'); n.focus(); n.setSelectionRange(p, p); };
  $('#sk-csv').onclick = () => csvDownload(`أرصدة_${L === 'all' ? 'الكل' : locName(L)}_${today()}.csv`,
    [['المادة', 'الرصيد', 'الوحدة', 'مفصّل', 'متوسط الكلفة', 'القيمة'], ...rows.map(({ it, qty }) => [it.name, r3(qty), it.baseUnit, detailed(it, qty, true), Math.round(avg.get(it.id) || 0), Math.round(Math.max(qty, 0) * (avg.get(it.id) || 0))])]);
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
    <tr><th>الوقت</th><th>النوع</th><th>المادة</th><th class="num">الكمية</th><th>المكان</th><th>السبب / ملاحظة</th><th>الموظف</th>${isAdmin() ? '<th class="num">الكلفة</th>' : ''}${withDelete ? '<th></th>' : ''}</tr>
    ${list.map(m => `<tr>
      <td class="small">${dt(m.ts)}</td>
      <td class="t-${m.type}"><b>${TYPES[m.type]?.ic || ''} ${TYPES[m.type]?.label || m.type}</b></td>
      <td>${esc(m.itemName)}</td>
      <td class="num">${N(m.qty, m.type === 'adjust')} ${esc(m.unit)}${m.factor > 1 ? `<div class="small muted">${N(m.baseQty)} ${esc(m.baseUnit)}</div>` : ''}</td>
      <td class="small">${esc(moveText(m))}</td>
      <td class="small">${esc([m.reason, m.ref, m.note].filter(Boolean).join(' — '))}</td>
      <td class="small">${esc(m.staffName)}</td>
      ${isAdmin() ? `<td class="num">${m.cost ? money(m.cost) : ''}</td>` : ''}
      ${withDelete ? `<td><button class="link bad" data-del="${m.id}">حذف</button></td>` : ''}
    </tr>`).join('')}
  </table></div>`;
}
function vLog() {
  const f = S.log;
  const list = S.moves.filter(m => m.ts >= dayStartTs(f.from) && m.ts <= dayEndTs(f.to)
    && (!f.type || m.type === f.type) && (!f.staff || m.staffId === f.staff) && (!f.q || (m.itemName || '').includes(f.q))).reverse();
  $('#view-root').innerHTML = `
    <div class="topline"><h1>سجل الحركات</h1><button class="btn ghost sm" id="lg-csv">تصدير</button></div>
    <div class="card">
      <div class="filters">
        <label class="small">من<br><input class="in" type="date" id="f-from" value="${f.from}"></label>
        <label class="small">إلى<br><input class="in" type="date" id="f-to" value="${f.to}"></label>
        <label class="small">النوع<br><select class="in" id="f-type"><option value="">الكل</option>${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
        <label class="small">الموظف<br><select class="in" id="f-staff"><option value="">الكل</option>${S.staff.map(s => `<option value="${s.id}" ${f.staff === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="small">المادة<br><input class="in" id="f-q" value="${esc(f.q)}" placeholder="بحث"></label>
      </div>
      <div class="small muted" style="margin-bottom:8px">${list.length} حركة</div>
      ${movesTable(list.slice(0, 500), isAdmin())}
      ${list.length > 500 ? '<div class="hint">يظهر أول 500 حركة — ضيّق التاريخ أو صدّر الملف.</div>' : ''}
    </div>`;
  const on = (id, k) => $(id).onchange = e => { S.log[k] = e.target.value; vLog(); };
  on('#f-from', 'from'); on('#f-to', 'to'); on('#f-type', 'type'); on('#f-staff', 'staff'); on('#f-q', 'q');
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const m = S.moves.find(x => x.id === b.dataset.del);
    if (await confirmBox(`حذف حركة ${TYPES[m.type].label} — ${esc(m.itemName)} ${fmt(m.qty)} ${esc(m.unit)}؟ الأرصدة راح تتعدل.`, 'حذف', true)) { await B.remove('moves', m.id); toast('انحذفت الحركة'); }
  });
  $('#lg-csv').onclick = () => csvDownload(`سجل_الحركات_${f.from}_${f.to}.csv`,
    [['التاريخ', 'النوع', 'المادة', 'الكمية', 'الوحدة', 'الكمية بالأساسية', 'الوحدة الأساسية', 'من', 'إلى', 'سعر الوحدة', 'الكلفة', 'السبب', 'الوصل', 'ملاحظة', 'الموظف'],
      ...list.map(m => [dt(m.ts), TYPES[m.type]?.label, m.itemName, m.qty, m.unit, m.baseQty, m.baseUnit, m.fromLoc ? locName(m.fromLoc) : '', m.toLoc ? locName(m.toLoc) : '', m.price || '', m.cost || '', m.reason, m.ref, m.note, m.staffName])]);
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
          <td><b>${esc(it.name)}</b></td>
          <td class="num">${N(bal.get(it.id + '|' + L) || 0)} ${esc(it.baseUnit)}</td>
          <td>${packOf(it) > 1 ? `<input class="in" style="width:90px" type="number" inputmode="decimal" min="0" step="any" data-big="${it.id}" value="${esc(c.big ?? '')}"> <span class="small muted">${esc(it.bigUnit)} (${fmt(packOf(it))})</span>` : '<span class="muted">—</span>'}</td>
          <td><input class="in" style="width:90px" type="number" inputmode="decimal" min="0" step="any" data-small="${it.id}" value="${esc(c.small ?? '')}"> <span class="small muted">${esc(it.baseUnit)}</span></td>
          <td class="num" data-cnt="${it.id}"></td><td class="num" data-var="${it.id}"></td><td class="num" data-val="${it.id}"></td></tr>`; }).join('')}
      </table></div>
      <div style="display:flex;gap:12px;align-items:center;margin-top:14px;flex-wrap:wrap">
        <button class="btn" id="st-save">حفظ الجرد وتسوية الأرصدة</button>
        <span id="st-sum" class="small"></span>
      </div>` : `<div class="empty">ما اكو مواد بهذا المكان بعد.</div>`}
    </div>` : `<div class="card empty">أضف أماكن الخزن أولاً من الإدارة.</div>`}
    <div class="card"><h2>جرودات سابقة</h2>
      ${past.length ? `<div class="tbl-wrap"><table><tr><th>التاريخ</th><th>المكان</th><th class="num">مواد مجرودة</th><th class="num">مواد بيها فرق</th><th class="num">قيمة العجز</th><th class="num">قيمة الزيادة</th><th>بواسطة</th></tr>
        ${past.map(s => `<tr><td class="small">${dt(s.ts)}</td><td>${esc(locName(s.locId))}</td><td class="num">${s.counted}</td><td class="num">${s.diffs}</td><td class="num neg">${M(s.shortValue)}</td><td class="num">${M(s.overValue)}</td><td class="small">${esc(s.staffName)}</td></tr>`).join('')}
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
      <div style="display:flex;gap:8px"><input class="in" type="month" id="rp-m" value="${S.rep.month}" style="width:170px"><button class="btn ghost sm" id="rp-csv">تصدير</button></div></div>
    <div class="kpis">
      <div class="kpi"><div class="l">المشتريات</div><div class="v">${M(purchases)}</div></div>
      <div class="kpi"><div class="l">كلفة المصروف</div><div class="v">${M(consumption)}</div></div>
      <div class="kpi bad"><div class="l">خسائر التالف</div><div class="v">${M(waste)}</div></div>
      <div class="kpi ${adj < 0 ? 'bad' : ''}"><div class="l">فروقات الجرد</div><div class="v">${M(adj)}</div></div>
      <div class="kpi"><div class="l">قيمة المخزون آخر الشهر</div><div class="v">${M(closeVal)}</div></div>
    </div>
    <div class="card"><div class="tbl-wrap">${rows.length ? `<table>
      <tr><th>المادة</th><th>الوحدة</th><th class="num">أول المدة</th><th class="num">الوارد</th><th class="num">المصروف</th><th class="num">التالف</th><th class="num">المرتجع</th><th class="num">تسوية الجرد</th><th class="num">آخر المدة</th><th class="num">متوسط الكلفة</th><th class="num">كلفة المصروف</th></tr>
      ${rows.map(r => `<tr><td><b>${esc(r.it.name)}</b></td><td class="small">${esc(r.it.baseUnit)}</td><td class="num">${N(r.open)}</td><td class="num">${N(r.in)}</td><td class="num">${N(r.out)}</td><td class="num">${N(r.waste)}</td><td class="num">${N(r.return)}</td><td class="num ${r.adjust < 0 ? 'neg' : ''}">${N(r.adjust)}</td><td class="num"><b>${N(r.close)}</b></td><td class="num">${M(r.avg)}</td><td class="num">${M(r.out * r.avg)}</td></tr>`).join('')}
    </table>` : `<div class="empty">ما اكو حركات بهذا الشهر</div>`}</div>
    <p class="hint">النقل بين الأماكن ما يأثر على التقرير لأن المادة باقية بالمخزن. متوسط الكلفة = كل كلفة المشتريات ÷ كل الكميات الواردة.</p></div>`;
  $('#rp-m').onchange = e => { S.rep.month = e.target.value || today().slice(0, 7); vReports(); };
  $('#rp-csv').onclick = () => csvDownload(`تقرير_${S.rep.month}.csv`,
    [['المادة', 'الوحدة', 'أول المدة', 'الوارد', 'المصروف', 'التالف', 'المرتجع', 'تسوية الجرد', 'آخر المدة', 'متوسط الكلفة', 'كلفة المصروف', 'كلفة التالف'],
      ...rows.map(r => [r.it.name, r.it.baseUnit, r3(r.open), r3(r.in), r3(r.out), r3(r.waste), r3(r.return), r3(r.adjust), r3(r.close), Math.round(r.avg), Math.round(r.out * r.avg), Math.round(r.waste * r.avg)])]);
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
    </div>
    <div class="card" id="adm"></div>`;
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.adminTab = b.dataset.tab; vAdmin(); });
  ({ items: admItems, locations: admLocs, staff: admStaff })[tab]();
}
const used = (field, id) => S.moves.some(m => m[field] === id);
function admItems() {
  const list = S.items.slice().sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name, 'ar'));
  $('#adm').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span class="muted small">${list.length} مادة</span><button class="btn sm" id="ad-new">+ مادة جديدة</button></div>
    ${list.length ? `<div class="tbl-wrap"><table><tr><th>المادة</th><th>الوحدة الأساسية</th><th>الوحدة الكبيرة</th><th class="num">التعبئة</th><th class="num">حد الأمان</th><th></th></tr>
    ${list.map(i => `<tr style="${i.active === false ? 'opacity:.5' : ''}"><td><b>${esc(i.name)}</b>${i.active === false ? ' <span class="badge b-muted">موقوفة</span>' : ''}</td><td>${esc(i.baseUnit)}</td><td>${esc(i.bigUnit || '—')}</td><td class="num">${i.bigUnit ? N(i.pack) : '—'}</td><td class="num">${+i.minQty ? N(i.minQty) : '—'}</td><td><button class="link" data-ed="${i.id}">تعديل</button></td></tr>`).join('')}
    </table></div>` : `<div class="empty">ما اكو مواد. ابدي بإضافة أول مادة.</div>`}`;
  $('#ad-new').onclick = () => itemForm();
  document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => itemForm(itemById(b.dataset.ed)));
}
function itemForm(it) {
  const u = `<datalist id="units">${UNITS.map(x => `<option value="${x}">`).join('')}</datalist>`;
  const hasMoves = it && used('itemId', it.id);
  modal(`<h2>${it ? 'تعديل مادة' : 'مادة جديدة'}</h2>${u}
    <div class="field"><label>اسم المادة <span class="req">*</span></label><input class="in" id="i-n" value="${esc(it?.name)}"></div>
    <div class="row">
      <div class="field"><label>الوحدة الأساسية <span class="req">*</span></label><input class="in" id="i-b" list="units" value="${esc(it?.baseUnit)}" placeholder="قطعة، كغم…"><div class="hint">اللي تصرف وتجرد بيها</div></div>
      <div class="field"><label>حد الأمان (بالأساسية)</label><input class="in" id="i-m" type="number" min="0" step="any" value="${esc(it?.minQty ?? '')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>الوحدة الكبيرة (اختياري)</label><input class="in" id="i-g" list="units" value="${esc(it?.bigUnit)}" placeholder="كرتون، صندوق…"></div>
      <div class="field"><label>التعبئة</label><input class="in" id="i-p" type="number" min="0" step="any" value="${esc(it?.pack ?? '')}" placeholder="كم أساسية بالكبيرة"></div>
    </div>
    ${hasMoves ? '<p class="hint bad">انتبه: تغيير الوحدة أو التعبئة ما يغيّر الحركات المسجلة سابقاً.</p>' : ''}
    <div class="foot"><button class="btn" id="i-s">حفظ</button><button class="btn ghost" id="i-c">إلغاء</button>
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
        const doc = { name, baseUnit, bigUnit, pack: bigUnit ? pack : 0, minQty };
        if (it) { await B.update('items', it.id, doc); if (it.name !== name) for (const mv of S.moves.filter(x => x.itemId === it.id)) await B.update('moves', mv.id, { itemName: name }); }
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
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span class="muted small">مثلاً: المخزن الرئيسي، البراد، الفريزر، رف المطبخ</span><button class="btn sm" id="ad-new">+ مكان جديد</button></div>
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
    <div class="foot"><button class="btn" id="l-s">حفظ</button><button class="btn ghost" id="l-c">إلغاء</button>
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
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span class="muted small">الموظف يسجل حركات ويشوف الأرصدة. المدير يقدر يجرد ويشوف التقارير والكلف ويحذف حركات.</span><button class="btn sm" id="ad-new">+ موظف</button></div>
    <div class="tbl-wrap"><table><tr><th>الاسم</th><th>الصلاحية</th><th class="num">حركاته</th><th></th></tr>
    ${list.map(s => `<tr style="${s.active === false ? 'opacity:.5' : ''}"><td><b>${esc(s.name)}</b>${s.active === false ? ' <span class="badge b-muted">موقوف</span>' : ''}</td><td>${s.role === 'admin' ? '<span class="badge b-ok">مدير</span>' : 'موظف'}</td><td class="num">${S.moves.filter(m => m.staffId === s.id).length}</td><td><button class="link" data-ed="${s.id}">تعديل</button></td></tr>`).join('')}
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
    <div class="foot"><button class="btn" id="s-s">حفظ</button><button class="btn ghost" id="s-c">إلغاء</button>
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
        const doc = { name, role };
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

boot();
