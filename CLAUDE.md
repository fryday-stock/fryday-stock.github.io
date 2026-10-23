# مخزن فرايدي — ملاحظات المشروع (للمطوّر و Claude)

نظام مخزن لمطعم **FryDay (فرايدي)** بالنجف. صاحب المشروع: أحمد الحجيمي. اللغة: عربي (لهجة عراقية بالمحادثة)، الواجهة كلها عربي RTL.

- الرابط: https://fryday-stock.github.io
- المستودع: `fryday-stock/fryday-stock.github.io` (GitHub Pages من فرع `main`، الجذر)
- قاعدة البيانات: Firebase مشروع `stock-dc518` — Firestore (Standard، europe-west3) + Authentication

## الملفات
| الملف | الدور |
|---|---|
| `index.html` | الهيكل فقط |
| `app.js` | كل المنطق (ES module، بدون build) |
| `style.css` | الشكل. الألوان متغيرات بأعلى الملف (`--pri`, `--side`, `--acc`…) من لوغو فرايدي: أزرق `#0b3d6e`/`#1a85d6` وأصفر `#f5d312` |
| `config.js` | اسم المطعم + إيميل حساب الأجهزة + إعدادات Firebase. إذا `apiKey` فارغ يشتغل «وضع تجربة» على localStorage |
| `firestore.rules` | قواعد الحماية (تنلصق يدوياً بـ Firebase Console ← Firestore ← Rules) |
| `logo.png` | اللوغو (مقصوص من سكرين انستغرام، دقة واطية — يُستبدل بالأصلي إذا توفر) |
| `xlsx.full.min.js` | مكتبة **xlsx-js-style 1.2.0** (نسخة SheetJS تدعم التنسيق) — للاستيراد والتصدير المنسّق. تنحمّل عند الحاجة فقط |

لا يوجد build ولا npm. أي تعديل = تعديل الملف ورفعه للمستودع.

## الحماية (3 طبقات)
1. **تفعيل الجهاز:** Firebase Auth بإيميل/باسورد لحساب واحد `device@fryday.iq`. أي جهاز جديد يكتب كلمة سر المطعم مرة وحدة. الدخول المجهول (Anonymous) **مطفي**.
2. **الموظف:** اسم + رمز 4–6 أرقام، مخزن بالقاعدة كـ SHA-256 (`pinHash`). صلاحيتين: `admin` و`staff`، والموظف ممكن ينطى `canEdit`.
3. **القواعد:** فقط `request.auth.token.email == 'device@fryday.iq'`. الحركات (`moves`) ما تنمسح أبداً؛ أي تحديث لازم يجي وياه سجل جديد بـ `audit` بنفس الـ batch (`lastAuditId` + `existsAfter`). `audit` و`stocktakes` إضافة فقط.

ملاحظة: الصلاحيات (admin/staff/canEdit) مفروضة بالواجهة فقط، مو بالقواعد. القواعد تضمن السجل وعدم المسح.

## نموذج البيانات (Firestore collections)
- `items`: `name, group, baseUnit, bigUnit, pack, minQty, active`
- `locations`: `name, order, active`
- `staff`: `name, role, pinHash, canEdit, active`
- `moves`: `ts, type, itemId, itemName, unit, qty, factor, baseQty, baseUnit, price, cost, fromLoc, toLoc, reason, ref, note, staffId, staffName` + عند التعديل/الحذف: `lastAuditId, editCount, editedBy, editedAt, deleted, deletedBy, deletedAt`
  - الأنواع: `opening` رصيد افتتاحي، `in` وارد، `out` صرف، `transfer` نقل، `waste` تالف، `return` مرتجع للمورد، `adjust` تسوية جرد (baseQty موقّع)
  - كل الأرصدة تنحسب بالواجهة من الحركات (`balances()`)، ما اكو رصيد مخزّن.
  - `price` = سعر الوحدة المختارة، `cost` = price × qty. متوسط الكلفة = مجموع كلفة (in+opening) ÷ مجموع baseQty.
- `audit`: `ts, action (edit|delete), moveId, moveType, itemId, itemName, moveTs, moveStaff, by, byId, why, changed, before, after`
- `stocktakes`: ملخص كل جرد + `lines`

## الوحدات
كل مادة إلها وحدة أساسية (الصرف والجرد بيها) ووحدة كبيرة اختيارية + تعبئة. الحركة تنسجل بالوحدة المختارة وتتحول لـ `baseQty`. الجرد يقبل «كبيرة مقفلة + أساسية مفتوحة».

## الشاشات
الرئيسية · حركة جديدة · الأرصدة (مجموعات + بحث + ملخص كمية/قيمة) · السجل (تعديل/حذف بسبب إجباري) · الجرد* · التقارير* · التعديلات والحذف* · الإدارة* (المواد، أماكن الخزن، الموظفين، النظام: استيراد إكسل + نسخة احتياطية JSON + إلغاء تفعيل الجهاز). (* للمدير)

## الاستيراد من إكسل
قالب أعمدته: المخزن، المجموعة، اسم المادة، الوحدة الأساسية، الوحدة الكبيرة، التعبئة، الرصيد (بالأساسية)، سعر الوحدة الأساسية، حد الأمان. يتعرف على الأعمدة بالاسم، يعرض شاشة مراجعة (أخطاء/تكرار/استيراد سابق) قبل الحفظ، ويسوي المخازن والمواد الناقصة + حركات `opening`.

## التصدير
`exportSheet()` يطلع xlsx منسّق RTL (عنوان، شريط فلترة، رؤوس زرقاء، أسطر مجموعات، سطر مجموع بمعادلة SUM). الموظف يصدّر بدون أسعار.

## قرارات صاحب المشروع
- يفضّل خطوات واضحة وحدة وحدة، وصراحة بالرأي، وتقليل الخيارات.
- اعتمد التصدير المنسّق بدل CSV.
- التصفير يتم من Firebase Console (حذف collections عدا `staff`)، مو من الموقع.

## أفكار مطروحة ولم تُنفّذ بعد
- تقرير شهري لكل مخزن لحاله (حالياً التقرير يجمع كل المخازن).
- ربط الموظف بمخزن معيّن.
- صلاحية وسطى: موظف يضيف مواد بدون ما يشوف الكلف.
- استبدال اللوغو بالملف الأصلي.
- فرض الصلاحيات بالقواعد نفسها (Custom claims أو حساب لكل موظف).
