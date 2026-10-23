import { CONFIG } from './config.js';

/* ═════════════ Data layer: Firebase (online) or Local (demo) ═════════════ */
const COLS = ['items', 'locations', 'staff', 'moves', 'stocktakes', 'audit'];

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
  items: [], locations: [], staff: [], moves: [], allMoves: [], stocktakes: [], audit: [],
  aud: { tab: 'edit', from: monthStart(), to: today() },
  loaded: new Set(),
  user: null,
  view: 'home',
  stockLoc: 'all', stockQ: '', stockGroup: '',
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
const canEdit = () => isAdmin() || S.user?.canEdit === true;
const mName = m => itemById(m.itemId)?.name || m.itemName || '';
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
  if (!B.authed()) return renderDevice();
  startData();
}
function renderDevice(err) {
  $('#app').innerHTML = `<div class="login"><div class="box">
    <img class="logo-big" src="logo.png" alt="">
    <h1>${esc(CONFIG.title)}</h1><p class="sub">هذا الجهاز غير مفعّل. يفعّله المدير مرة وحدة بكلمة سر المطعم.</p>
    <div class="field"><label>إيميل المطعم</label><input class="in" id="dv-e" dir="ltr" value="${esc(CONFIG.deviceEmail || '')}"></div>
    <div class="field"><label>كلمة سر المطعم</label><input class="in" id="dv-p" type="password" dir="ltr"></div>
    <button class="btn big" id="dv-go">تفعيل الجهاز</button>
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
  COLS.forEach(c => B.watch(c, rows => {
    if (c === 'moves') { rows.sort((a, b) => a.ts - b.ts); S.allMoves = rows; rows = rows.filter(m => !m.deleted); }
    S[c] = rows; S.loaded.add(c);
    if (c === 'staff' && saved && !S.user) { const u = rows.find(s => s.id === saved && s.active !== false); if (u) S.user = u; }
    if (c === 'staff' && S.user) { const u = rows.find(s => s.id === S.user.id); if (!u || u.active === false) { S.user = null; localStorage.removeItem('inv_session'); } else S.user = u; }
    if (S.loaded.size === COLS.length) onData();
  }, onErr));
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
  ['audit', '🕵️', 'التعديلات والحذف', true],
  ['admin', '⚙️', 'الإدارة', true]
];
function render() {
  if (!S.staff.length) return renderSetup();
  if (!S.user) return renderLogin();
  const nav = NAV.filter(n => !n[3] || isAdmin());
  if (!nav.find(n => n[0] === S.view)) S.view = 'home';
  $('#app').innerHTML = `
  <div class="mobile-head"><span><img class="mlogo" src="logo.png" alt="">${esc(CONFIG.title)}</span><span>${esc(S.user.name)} <button id="lo2">خروج</button></span></div>
  <div class="shell">
    <aside class="side">
      <div class="brand"><img class="logo" src="logo.png" alt=""><div>${esc(CONFIG.title)}<small>نظام المخزن</small></div></div>
      ${nav.map(n => `<button class="nav ${S.view === n[0] ? 'on' : ''}" data-go="${n[0]}"><span class="ic">${n[1]}</span>${n[2]}</button>`).join('')}
      <div class="me">👤 ${esc(S.user.name)} <span class="small">(${S.user.role === 'admin' ? 'مدير' : 'موظف'})</span><br><button class="btn ghost sm" id="lo">تسجيل خروج</button></div>
    </aside>
    <main class="main" id="view-root"></main>
  </div>
  <nav class="bottom">${nav.map(n => `<button class="${S.view === n[0] ? 'on' : ''}" data-go="${n[0]}"><span class="ic">${n[1]}</span>${n[2]}</button>`).join('')}</nav>`;
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  const lo = () => { S.user = null; localStorage.removeItem('inv_session'); render(); };
  $('#lo').onclick = lo; $('#lo2').onclick = lo;
  const views = { home: vHome, move: vMove, stock: vStock, log: vLog, stocktake: vStocktake, reports: vReports, audit: vAudit, admin: vAdmin };
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
    <img class="logo-big" src="logo.png" alt="">
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
    <img class="logo-big" src="logo.png" alt="">
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
const NOGRP = 'بدون مجموعة';
const grpOf = it => normTxt(it.group) || NOGRP;
const allGroups = () => [...new Set(activeItems().map(grpOf))].sort((a, b) => a === NOGRP ? 1 : b === NOGRP ? -1 : a.localeCompare(b, 'ar'));
function vStock() {
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
  const cols = 4 + (L === 'all' ? 2 : 0) + (isAdmin() ? 1 : 0);
  let body = '', lastG = null;
  for (const r of rows) {
    if (r.g !== lastG) {
      lastG = r.g; const gr = rows.filter(x => x.g === r.g);
      body += `<tr class="grp"><td colspan="${cols}"><b>📁 ${esc(r.g)}</b> <span class="small muted">— ${gr.length} مادة${isAdmin() ? ` — القيمة ${M(gr.reduce((a, x) => a + x.val, 0))} د.ع` : ''}</span></td></tr>`;
    }
    const { it, qty } = r;
    const st = L === 'all' ? status(it, qty) : (qty < -0.0005 ? ['رصيد سالب', 'b-bad'] : Math.abs(qty) < 0.0005 ? ['فارغ', 'b-muted'] : ['متوفر', 'b-ok']);
    body += `<tr><td><b>${esc(it.name)}</b></td><td class="num ${qty < -0.0005 ? 'neg' : ''}">${N(qty)} ${esc(it.baseUnit)}</td><td class="small">${detailed(it, qty)}</td>
      ${L === 'all' ? `<td class="small muted">${per(it).map(([l, v]) => `${esc(l.name)}: ${N(v)}`).join(' · ')}</td><td class="num">${+it.minQty ? N(it.minQty) : '—'}</td>` : ''}
      ${isAdmin() ? `<td class="num">${M(r.val)}</td>` : ''}
      <td><span class="badge ${st[1]}">${st[0]}</span></td></tr>`;
  }
  $('#view-root').innerHTML = `
    <div class="topline"><h1>الأرصدة</h1><button class="btn ghost sm" id="sk-csv">تصدير</button></div>
    <div class="filters">
      <input class="in" id="sk-q" placeholder="🔍 بحث باسم المادة أو المجموعة…" value="${esc(S.stockQ)}" style="flex:1;min-width:220px">
      <select class="in" id="sk-g"><option value="">كل المجموعات</option>${groups.map(g => `<option ${G === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
    </div>
    <div class="chips"><button data-l="all" class="${L === 'all' ? 'on' : ''}">كل الأماكن</button>${locs.map(l => `<button data-l="${l.id}" class="${L === l.id ? 'on' : ''}">${esc(l.name)}</button>`).join('')}</div>
    ${rows.length ? `<div class="sumbar">
      <span><span class="muted small">النتائج</span><b>${rows.length} مادة</b></span>
      <span><span class="muted small">الكمية</span><b>${[...byUnit].map(([u, v]) => `${N(v)} ${esc(u)}`).join(' · ')}</b></span>
      ${isAdmin() ? `<span><span class="muted small">القيمة</span><b>${M(totVal)} د.ع</b></span>` : ''}
    </div>` : ''}
    <div class="card"><div class="tbl-wrap">${rows.length ? `<table>
      <tr><th>المادة</th><th class="num">الرصيد</th><th>مفصّل</th>${L === 'all' ? '<th>التوزيع على الأماكن</th><th class="num">حد الأمان</th>' : ''}${isAdmin() ? '<th class="num">القيمة (د.ع)</th>' : ''}<th>الحالة</th></tr>
      ${body}
    </table>` : `<div class="empty">ما اكو مواد ${q ? 'بهذا البحث' : G ? 'بهذي المجموعة' : L !== 'all' ? 'بهذا المكان' : 'بعد'}</div>`}</div></div>`;
  document.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { S.stockLoc = b.dataset.l; vStock(); });
  $('#sk-g').onchange = e => { S.stockGroup = e.target.value; vStock(); };
  $('#sk-q').oninput = e => { S.stockQ = e.target.value; const p = e.target.selectionStart; vStock(); const n = $('#sk-q'); n.focus(); n.setSelectionRange(p, p); };
  $('#sk-csv').onclick = () => {
    const adm = isAdmin(), out = []; let lg = null;
    for (const r of rows) {
      if (r.g !== lg) { lg = r.g; out.push({ group: r.g }); }
      const row = [r.it.name, r3(r.qty), r.it.baseUnit, detailed(r.it, r.qty, true)];
      if (adm) row.push(Math.round(avg.get(r.it.id) || 0), Math.round(r.val));
      out.push(row);
    }
    exportSheet({ file: `أرصدة_${L === 'all' ? 'كل_المخازن' : locName(L)}_${today()}.xlsx`, title: `${CONFIG.title} — الأرصدة`,
      sub: [`المخزن: ${L === 'all' ? 'كل المخازن' : locName(L)}`, G ? `المجموعة: ${G}` : '', S.stockQ.trim() ? `البحث: ${S.stockQ.trim()}` : '', `بتاريخ: ${dt(Date.now())}`].filter(Boolean).join('   |   '),
      headers: ['المادة', 'الرصيد', 'الوحدة', 'مفصّل', ...(adm ? ['متوسط الكلفة (د.ع)', 'القيمة (د.ع)'] : [])],
      rows: out, qty: [1], money: adm ? [4, 5] : [], totals: adm ? { label: 'المجموع', cols: [5] } : null });
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
    <tr><th>الوقت</th><th>النوع</th><th>المادة</th><th class="num">الكمية</th><th>المكان</th><th>السبب / ملاحظة</th><th>الموظف</th>${isAdmin() ? '<th class="num">الكلفة</th>' : ''}${withDelete ? '<th></th>' : ''}</tr>
    ${list.map(m => `<tr ${m.deleted ? 'style="opacity:.55;text-decoration:line-through"' : ''}>
      <td class="small">${dt(m.ts)}</td>
      <td class="t-${m.type}"><b>${TYPES[m.type]?.ic || ''} ${TYPES[m.type]?.label || m.type}</b></td>
      <td>${esc(mName(m))}${m.editCount ? ' <span class="badge b-warn" title="انعدلت">معدّلة</span>' : ''}</td>
      <td class="num">${N(m.qty, m.type === 'adjust')} ${esc(m.unit)}${m.factor > 1 ? `<div class="small muted">${N(m.baseQty)} ${esc(m.baseUnit)}</div>` : ''}</td>
      <td class="small">${esc(moveText(m))}</td>
      <td class="small">${esc([m.reason, m.ref, m.note].filter(Boolean).join(' — '))}</td>
      <td class="small">${esc(m.staffName)}</td>
      ${isAdmin() ? `<td class="num">${m.cost ? money(m.cost) : ''}</td>` : ''}
      ${withDelete ? `<td style="white-space:nowrap">${m.type !== 'adjust' ? `<button class="link" data-edit="${m.id}">تعديل</button>` : ''}${m.type !== 'adjust' || isAdmin() ? ` <button class="link bad" data-del="${m.id}">حذف</button>` : ''}</td>` : ''}
    </tr>`).join('')}
  </table></div>`;
}
function vLog() {
  const f = S.log;
  const list = S.moves.filter(m => m.ts >= dayStartTs(f.from) && m.ts <= dayEndTs(f.to)
    && (!f.type || m.type === f.type) && (!f.staff || m.staffId === f.staff) && (!f.q || mName(m).includes(f.q))).reverse();
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
      ${movesTable(list.slice(0, 500), canEdit())}
      ${list.length > 500 ? '<div class="hint">يظهر أول 500 حركة — ضيّق التاريخ أو صدّر الملف.</div>' : ''}
    </div>`;
  const on = (id, k) => $(id).onchange = e => { S.log[k] = e.target.value; vLog(); };
  on('#f-from', 'from'); on('#f-to', 'to'); on('#f-type', 'type'); on('#f-staff', 'staff'); on('#f-q', 'q');
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editMove(S.moves.find(x => x.id === b.dataset.edit)));
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteMove(S.moves.find(x => x.id === b.dataset.del)));
  $('#lg-csv').onclick = () => {
    const adm = isAdmin();
    exportSheet({ file: `سجل_الحركات_${f.from}_${f.to}.xlsx`, title: `${CONFIG.title} — سجل الحركات`, sub: `من ${f.from} إلى ${f.to}   |   ${list.length} حركة`,
      headers: ['التاريخ', 'النوع', 'المادة', 'الكمية', 'الوحدة', 'بالوحدة الأساسية', 'الوحدة الأساسية', 'من', 'إلى', ...(adm ? ['سعر الوحدة', 'الكلفة'] : []), 'السبب', 'الوصل', 'ملاحظة', 'الموظف'],
      rows: list.map(m => [dt(m.ts), TYPES[m.type]?.label, mName(m), m.qty, m.unit, m.baseQty, m.baseUnit, m.fromLoc ? locName(m.fromLoc) : '', m.toLoc ? locName(m.toLoc) : '', ...(adm ? [m.price || '', m.cost || ''] : []), m.reason, m.ref, m.note, m.staffName]),
      qty: [3, 5], money: adm ? [9, 10] : [], totals: adm ? { label: 'المجموع', cols: [10] } : null });
  };
}

/* ═════════════ Edit / delete with audit trail ═════════════ */
const AUD_FIELDS = { unit: 'الوحدة', qty: 'الكمية', price: 'السعر', fromLoc: 'من مكان', toLoc: 'إلى مكان', reason: 'السبب', note: 'ملاحظة', ref: 'الوصل' };
const audVal = (k, v) => (k === 'fromLoc' || k === 'toLoc') ? (v ? locName(v) : '—') : (k === 'qty' || k === 'price') ? fmt(v) : (v || '—');
const moveSnap = m => ({ unit: m.unit, qty: m.qty, factor: m.factor, baseQty: m.baseQty, price: m.price || 0, cost: m.cost || 0, fromLoc: m.fromLoc || '', toLoc: m.toLoc || '', reason: m.reason || '', note: m.note || '', ref: m.ref || '' });
function editMove(m) {
  if (!m || !canEdit()) return;
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
    <div class="foot"><button class="btn" id="e-s">حفظ التعديل</button><button class="btn ghost" id="e-c">إلغاء</button></div>`,
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
      ${edits.map(x => `<tr><td class="small">${dt(x.ts)}</td><td><b>${esc(x.by)}</b></td>
        <td class="t-${x.moveType}"><b>${TYPES[x.moveType]?.label || ''}</b> — ${esc(x.itemName)}</td>
        <td class="small">${(x.changed || []).map(k => `${AUD_FIELDS[k]}: <span style="text-decoration:line-through;color:var(--bad)">${esc(audVal(k, x.before?.[k]))}</span> ← <b>${esc(audVal(k, x.after?.[k]))}</b>`).join('<br>')}</td>
        <td class="small">${esc(x.why)}</td><td class="small">${esc(x.moveStaff)}<br><span class="muted">${dt(x.moveTs)}</span></td></tr>`).join('')}
    </table>` : '<div class="empty">ما اكو تعديلات بهذي الفترة</div>')
    : (dels.length ? `<table>
      <tr><th>وقت الحذف</th><th>منو حذف</th><th>الحركة المحذوفة</th><th class="num">الكمية</th><th>المكان</th><th>السبب</th><th>سجّلها أصلاً</th></tr>
      ${dels.map(x => `<tr><td class="small">${dt(x.ts)}</td><td><b>${esc(x.by)}</b></td>
        <td class="t-${x.moveType}"><b>${TYPES[x.moveType]?.label || ''}</b> — ${esc(x.itemName)}</td>
        <td class="num">${N(x.before?.qty)} ${esc(x.before?.unit)}</td><td class="small">${esc(where(x.moveType, x.before || {}))}</td>
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
  $('#rp-csv').onclick = () => exportSheet({ file: `تقرير_المخزن_${S.rep.month}.xlsx`, title: `${CONFIG.title} — التقرير الشهري`, sub: `شهر ${S.rep.month}   |   المشتريات: ${money(purchases)}   |   كلفة المصروف: ${money(consumption)}   |   التالف: ${money(waste)}   |   فروقات الجرد: ${money(adj)}`,
    headers: ['المادة', 'الوحدة', 'أول المدة', 'الوارد', 'المصروف', 'التالف', 'المرتجع', 'تسوية الجرد', 'آخر المدة', 'متوسط الكلفة', 'كلفة المصروف', 'كلفة التالف', 'قيمة آخر المدة'],
    rows: rows.map(r => [r.it.name, r.it.baseUnit, r3(r.open), r3(r.in), r3(r.out), r3(r.waste), r3(r.return), r3(r.adjust), r3(r.close), Math.round(r.avg), Math.round(r.out * r.avg), Math.round(r.waste * r.avg), Math.round(Math.max(r.close, 0) * r.avg)]),
    qty: [2, 3, 4, 5, 6, 7, 8], money: [9, 10, 11, 12], totals: { label: 'المجموع', cols: [10, 11, 12] } });
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
      <button data-tab="system" class="${tab === 'system' ? 'on' : ''}">النظام</button>
    </div>
    <div class="card" id="adm"></div>`;
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.adminTab = b.dataset.tab; vAdmin(); });
  ({ items: admItems, locations: admLocs, staff: admStaff, system: admSystem })[tab]();
}
const used = (field, id) => S.moves.some(m => m[field] === id);
function admItems() {
  const list = S.items.slice().sort((a, b) => (a.active === false) - (b.active === false) || (a.group || 'ي').localeCompare(b.group || 'ي', 'ar') || a.name.localeCompare(b.name, 'ar'));
  $('#adm').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span class="muted small">${list.length} مادة</span><button class="btn sm" id="ad-new">+ مادة جديدة</button></div>
    ${list.length ? `<div class="tbl-wrap"><table><tr><th>المادة</th><th>المجموعة</th><th>الوحدة الأساسية</th><th>الوحدة الكبيرة</th><th class="num">التعبئة</th><th class="num">حد الأمان</th><th></th></tr>
    ${list.map(i => `<tr style="${i.active === false ? 'opacity:.5' : ''}"><td><b>${esc(i.name)}</b>${i.active === false ? ' <span class="badge b-muted">موقوفة</span>' : ''}</td><td class="small">${esc(i.group || '—')}</td><td>${esc(i.baseUnit)}</td><td>${esc(i.bigUnit || '—')}</td><td class="num">${i.bigUnit ? N(i.pack) : '—'}</td><td class="num">${+i.minQty ? N(i.minQty) : '—'}</td><td><button class="link" data-ed="${i.id}">تعديل</button></td></tr>`).join('')}
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

function admSystem() {
  const last = localStorage.getItem('inv_last_backup');
  $('#adm').innerHTML = `
    <h2>استيراد من إكسل</h2>
    <p class="small muted">ترفع ملف إكسل بيه المواد وأرصدتها (حسب القالب)، والنظام يضيف المخازن والمواد والأرصدة الافتتاحية مرة وحدة. المواد الموجودة مسبقاً بنفس الاسم ما تتكرر.</p>
    <input type="file" id="imp-f" accept=".xlsx,.xls,.csv" hidden>
    <button class="btn" id="imp">اختيار ملف الإكسل</button>
    <hr style="border:0;border-top:1px solid var(--line);margin:22px 0">
    <h2>النسخة الاحتياطية</h2>
    <p class="small muted">ينزّل ملف بيه كل البيانات (المواد، الأماكن، الموظفين، كل الحركات، الجرودات). احتفظ بيه بمكان آمن. يُنصح كل أسبوع أو كل شهر.</p>
    <p class="small">آخر نسخة من هذا الجهاز: <b>${last ? dt(+last) : 'ما اكو'}</b></p>
    <button class="btn" id="bk">تنزيل نسخة احتياطية</button>
    <hr style="border:0;border-top:1px solid var(--line);margin:22px 0">
    <h2>هذا الجهاز</h2>
    <p class="small muted">إلغاء التفعيل يخلي هذا الجهاز يحتاج كلمة سر المطعم مرة ثانية. استخدمه إذا الجهاز راح يطلع من المطعم أو ضاع.</p>
    ${B.mode === 'firebase' ? '<button class="btn danger" id="dv-out">إلغاء تفعيل هذا الجهاز</button>' : '<span class="mode">وضع تجربة</span>'}`;
  $('#imp').onclick = () => $('#imp-f').click();
  $('#imp-f').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importExcel(f); };
  $('#bk').onclick = () => {
    const data = { exportedAt: new Date().toISOString(), title: CONFIG.title, items: S.items, locations: S.locations, staff: S.staff.map(({ pinHash, ...x }) => x), moves: S.allMoves, stocktakes: S.stocktakes, audit: S.audit };
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
