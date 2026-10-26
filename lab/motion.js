/* ═════ تجربة GSAP (lab) — حركات عرض فقط، ما تلمس المنطق ═════
   التوقيتات من سكل ui-ux-pro-max (motion.csv):
   - دخول البطاقات: «Stagger List / Subtle» — opacity + y صغير، 0.3s، power1.out، stagger 0.035
   - ضغط الأزرار: «Micro-interaction / Subtle» — 0.15s، إزاحة صغيرة، ويرجع إذا الإصبع طلع
   - النوافذ: الفتح 0.25s والسكر أسرع (~65%) حسب قاعدة exit-faster-than-enter
   - عدّاد الأرقام: ما اكو تطابق بقاعدة السكل، فاستخدمنا توقيت Subtle (0.35s) ويّا فواصل الآلاف
   كل حركة أقل من 0.4 ثانية، وكلها تنطفي مع prefers-reduced-motion. */
(() => {
  const g = window.gsap;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  // علامة صغيرة تبين حالة الحركات حتى نعرف السبب إذا ما بانت
  const badge = document.createElement('div');
  badge.className = 'lab-badge';
  const setBadge = () => {
    badge.textContent = !g ? 'نسخة تجريبية — GSAP ما انحمّل (تأكد من الإنترنت)'
      : reduce.matches ? 'نسخة تجريبية — الحركات مطفية: الجهاز مفعّل عليه «تقليل الحركة»'
      : 'نسخة تجريبية — حركات GSAP شغالة';
    badge.classList.toggle('off', !g || reduce.matches);
  };
  setBadge(); reduce.addEventListener?.('change', setBadge);
  document.body.appendChild(badge);
  if (!g) return; // إذا GSAP ما انحمّل، الموقع يشتغل عادي بدون حركات
  document.documentElement.classList.add('lab-gsap');
  document.title = 'LAB — ' + document.title;

  const on = () => !reduce.matches;
  const T = { enter: 0.3, stagger: 0.035, y: 10, count: 0.35, open: 0.25, close: 0.16, press: 0.15, release: 0.2 };
  const EASE = 'power1.out';
  const CARDS = '.actions .act, .valcard, .kpi, .card, .loc, .sumbar, .tabs, .filters, .chips';
  const MAX = 14; // البطاقات بعد هذا العدد تطلع مباشرة حتى الدخول ما يطوّل

  /* ── 1) دخول ناعم للبطاقات: بس لما تتغير الصفحة، مو كل إعادة رسم (مثل الكتابة بالبحث) ── */
  let lastKey = '';
  const pageKey = vr => {
    const h1 = vr.querySelector('.topline h1')?.textContent.trim() || '';
    const tab = vr.querySelector('.tabs .on')?.textContent.trim() || '';
    return h1 + '|' + tab;
  };
  function enter(vr) {
    const all = [...vr.querySelectorAll(CARDS)].filter(el => !el.parentElement.closest(CARDS));
    const list = all.slice(0, MAX);
    if (!list.length) return;
    g.fromTo(list, { opacity: 0, y: T.y }, { opacity: 1, y: 0, duration: T.enter, ease: EASE, stagger: T.stagger, clearProps: 'opacity,transform' });
    if (vr.querySelector('.actions')) countUp(vr); // الأرقام: بالرئيسية بس
  }

  /* ── 2) الأرقام بالرئيسية تعدّ من صفر لقيمتها ── */
  function countUp(vr) {
    vr.querySelectorAll('.overview .kpi .v, .valcard .vc-num bdi').forEach(el => {
      const txt = el.textContent.trim(), target = +txt.replace(/,/g, '');
      if (!isFinite(target) || target === 0) return;
      const o = { v: 0 };
      el.textContent = '0';
      g.to(o, { v: target, duration: T.count, ease: EASE, onUpdate: () => { el.textContent = Math.round(o.v).toLocaleString('en-US'); }, onComplete: () => { el.textContent = txt; } });
    });
  }

  // الـ MutationObserver يشتغل بعد ما app.js يخلص الرسم وقبل ما المتصفح يرسم الشاشة، فما يصير وميض
  new MutationObserver(() => {
    const vr = document.getElementById('view-root');
    if (!vr) { lastKey = ''; return; }
    const key = pageKey(vr);
    if (key === lastKey) return;
    lastKey = key;
    if (on()) enter(vr);
  }).observe(document.getElementById('app'), { childList: true, subtree: true });

  /* ── 3) فتح وسكر النوافذ ورسالة التأكيد ── */
  const mroot = document.getElementById('modal-root');
  new MutationObserver(muts => {
    if (!on()) return;
    for (const m of muts) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement) || !n.classList.contains('modal-bg')) continue;
      g.fromTo(n, { opacity: 0 }, { opacity: 1, duration: T.open, ease: EASE, clearProps: 'opacity' });
      g.fromTo(n.querySelector('.modal'), { opacity: 0, y: 12, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: T.open, ease: EASE, clearProps: 'opacity,transform' });
    }
  }).observe(mroot, { childList: true });
  // app.js (نسخة lab) يستدعي هاي بدل ما يفرّغ النافذة مباشرة
  window.labMotion = {
    closeModal(root) {
      const bg = root.querySelector('.modal-bg');
      if (!bg) return;
      if (!on()) { bg.remove(); return; }
      bg.style.pointerEvents = 'none'; // الضغطات تعبر من وره النافذة وهي تختفي
      g.to(bg.querySelector('.modal'), { opacity: 0, y: 8, scale: 0.98, duration: T.close, ease: 'power1.in' });
      g.to(bg, { opacity: 0, duration: T.close, ease: 'power1.in', onComplete: () => bg.remove() });
    }
  };

  /* ── 4) تأثير خفيف لما تضغط على أزرار الحركات ── */
  const PRESS = '.actions .act, .seg button, .btn.big';
  let pressed = null;
  const release = () => {
    if (!pressed) return;
    g.to(pressed, { scale: 1, duration: T.release, ease: EASE, clearProps: 'transform' });
    pressed = null;
  };
  document.addEventListener('pointerdown', e => {
    if (!on()) return;
    const el = e.target.closest(PRESS);
    if (!el || el.disabled) return;
    pressed = el;
    el.addEventListener('pointerleave', release, { once: true }); // إذا الإصبع طلع من الزر يرجع
    g.to(el, { scale: 0.97, duration: T.press, ease: EASE });
  });
  ['pointerup', 'pointercancel', 'blur'].forEach(t => window.addEventListener(t, release, true));

})();
