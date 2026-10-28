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
| `style.css` | الشكل. الألوان متغيرات بأعلى الملف (`--g1`/`--g2` تدرج أساسي، `--acc`، `--side1/2`، وألوان الحركات `--in1/2`…) — أزرق ملكي `#1e3a8a`/`#3b82f6` + كهرماني `#f59e0b`، خط IBM Plex Sans Arabic (اختيار سكل ui-ux-pro-max). `color-scheme: only light` يمنع وضع الظلام بالمتصفح من تخريب الألوان |
| `config.js` | اسم المطعم + إيميل حساب الأجهزة + إعدادات Firebase. إذا `apiKey` فارغ يشتغل «وضع تجربة» على localStorage |
| `firestore.rules` | قواعد الحماية (تنلصق يدوياً بـ Firebase Console ← Firestore ← Rules) |
| `.claude/skills/ui-ux-pro-max` | سكل تصميم (nextlevelbuilder/ui-ux-pro-max-skill، MIT). GitHub Pages ما ينشره |
| `logo.png` | اللوغو (مقصوص من سكرين انستغرام، دقة واطية — يُستبدل بالأصلي إذا توفر) |
| `xlsx.full.min.js` | مكتبة **xlsx-js-style 1.2.0** (نسخة SheetJS تدعم التنسيق) — للاستيراد والتصدير المنسّق. تنحمّل عند الحاجة فقط |

لا يوجد build ولا npm. أي تعديل = تعديل الملف ورفعه للمستودع.

## الحماية (3 طبقات)
1. **تفعيل الجهاز:** Firebase Auth بإيميل/باسورد لحساب واحد `device@fryday.iq`. أي جهاز جديد يكتب كلمة سر المطعم مرة وحدة. الدخول المجهول (Anonymous) **مطفي**.
2. **الموظف:** اسم + رمز 4–6 أرقام، مخزن بالقاعدة كـ SHA-256 (`pinHash`). صلاحيتين: `admin` و`staff`، والموظف ممكن ينطى `canEdit`.
3. **القواعد:** فقط `request.auth.token.email == 'device@fryday.iq'`. الحركات (`moves`) والفواتير (`invoices`) والتسديدات (`payments`) وصور الفواتير (`invoiceImages`) ما تنمسح أبداً؛ أي تحديث لازم يجي وياه سجل جديد بـ `audit` بنفس الـ batch (`lastAuditId` + `existsAfter`). الاستثناء الوحيد: تحديث `imageCount` لحاله بالفاتورة (إضافة صورة إضافة مو تعديل). `audit` و`stocktakes` إضافة فقط. `suppliers` تنضاف وتتعدل وما تنمسح (إيقاف).

### الصلاحيات (قرار صاحب المشروع)
- **الموظف يشوف كل شي يشوفه المدير:** الكلف والقيم ومتوسط الكلفة وقيمة المخزون (الرئيسية، الأرصدة، بطاقة المادة، السجل، التصدير)، والجرد، والتقارير، وشاشة «التعديلات والحذف»، وكل شاشات المشتريات.
- **للمدير فقط:** شاشة «الإدارة» (المواد، أماكن الخزن، الموظفين، الموردين بالإدارة، الاستيراد، النظام). وتسجيل «رصيد افتتاحي» من حركة جديدة (مثل الاستيراد).
- **التعديل والحذف** (الحركات، الفواتير، التسديدات، حذف صور الفواتير، تعديل الموردين): للمدير وللموظف اللي عنده `canEdit` («يعدّل ويحذف») — `canEdit()` بـ app.js.

ملاحظة: الصلاحيات (admin/staff/canEdit) مفروضة بالواجهة فقط، مو بالقواعد. القواعد تضمن السجل وعدم المسح.

## نموذج البيانات (Firestore collections)
- `items`: `name, group, baseUnit, bigUnit, pack, minQty, active`
- `locations`: `name, order, active`
- `staff`: `name, role, pinHash, canEdit, active`
- `moves`: `ts, type, itemId, itemName, unit, qty, factor, baseQty, baseUnit, price, cost, fromLoc, toLoc, reason, ref, note, staffId, staffName` + عند التعديل/الحذف: `lastAuditId, editCount, editedBy, editedAt, deleted, deletedBy, deletedAt`
  - الأنواع: `opening` رصيد افتتاحي، `in` وارد، `out` صرف، `transfer` نقل، `waste` تالف، `return` مرتجع للمورد، `adjust` تسوية جرد (baseQty موقّع)
  - كل الأرصدة تنحسب بالواجهة من الحركات (`balances()`)، ما اكو رصيد مخزّن.
  - `price` = سعر الوحدة المختارة، `cost` = price × qty. متوسط الكلفة = مجموع كلفة (in+opening) ÷ مجموع baseQty.
- `suppliers`: `name, phone, note, active`
- `invoices` (فاتورة مشتريات): `ts, date, supplierId, supplierName, ref, locId, note, lines[{moveId, itemId, itemName, unit, qty, factor, baseQty, baseUnit, price, total, share, cost}], subtotal, transport, loading, discount, total, payMode (paid|credit|partial), paid, moveIds, imageCount, staffId, staffName` + حقول التعديل/الحذف مثل الحركات
  - كل سطر = حركة `in` عادية بيها `invoiceId, supplierId, supplierName, invPrice` (سعر الفاتورة) و`extra` (حصتها من النقل+التحميل−الخصم بنسبة قيمة السطر). `cost` = إجمالي السطر + حصته، و`price` = cost ÷ qty، حتى متوسط الكلفة يشمل المصاريف.
  - حركات الفاتورة ما تتعدل من السجل؛ تتعدل/تنحذف من الفاتورة (batch واحد: audit + الفاتورة + الحركات).
- `invoiceImages` (صور الفواتير، نفس أسلوب fryday-store): `ts, invoiceId, supplierId, data (data:image/jpeg;base64), w, h, bytes, staffId, staffName` + `deleted, deletedBy, deletedAt, lastAuditId`
  - كل صورة وثيقة منفصلة (مو داخل الفاتورة)، بدون Firebase Storage. تنضغط بالمتصفح لحوالي 250KB (`compressImage()`: JPEG، بحث ثنائي على الجودة، أطول ضلع 1800 وتصغير إذا ما كفى). القواعد ترفض فوق 700KB نص.
  - ما تنراقب ويا البيانات (مو بـ `COLS`)؛ تنجاب عند الحاجة بـ `B.images(invoiceId)` وتنخزن مؤقتاً بـ `imgCache`. الفاتورة بيها `imageCount` بس حتى القوائم تعرف وين اكو صور.
  - الإضافة: من فورم الفاتورة (جديدة، أو تعديل ← ينسجل «ضاف n صورة» بالتعديل) أو من «عرض» الفاتورة (للكل، تحديث `imageCount` بس). الصور تنحفظ بطلبات منفصلة 8 صور بكل طلب.
  - الحذف = `deleted` ويا audit (`kind: 'image'`) و`imageCount` ينقص بنفس الـ batch. للمدير ولمن عنده `canEdit`.
  - العرض والتكبير (`imageViewer()`: أصابع، عجلة الماوس، أزرار، نقرتين) من: الفاتورة، قائمة الفواتير، وكشف حساب المورد.
- **التخزين** (الإدارة ← التخزين، `admStorage()`): تقدير لحجم Firestore مقابل حد الخطة — الصور (`imageCount` + المحذوفة من audit) × ~340KB + باقي البيانات (JSON × 2 للفهارس). الحد `CONFIG.storageLimitGB` (افتراضي 1 = خطة Spark المجانية). من 80% يطلع تحذير أحمر بالرئيسية للمدير و⚠ على التبويب. القرار: لما يوصل 80% صاحب المشروع يرقّي لخطة Blaze (ويحط Budget alert)، وبعدها نرفع `storageLimitGB` بـ config.js.
- `payments` (تسديد للمورد على حسابه كله): `ts, date, supplierId, supplierName, amount, method (cash|transfer), note, staffId, staffName` + حقول التعديل/الحذف
  - المتبقي بذمتي للمورد = Σ(total − paid) للفواتير − Σ التسديدات (`supDue()`).
- `audit`: `ts, action (edit|delete), moveId, moveType, itemId, itemName, moveTs, moveStaff, by, byId, why, changed, before, after` — ولتعديلات المشتريات: `kind (invoice|payment|image), invoiceId|paymentId|imageId, supplierName, ref, summary[]`
- `stocktakes`: ملخص كل جرد + `lines`

## الوحدات
كل مادة إلها وحدة أساسية (الصرف والجرد بيها) ووحدة كبيرة اختيارية + تعبئة. الحركة تنسجل بالوحدة المختارة وتتحول لـ `baseQty`. الجرد يقبل «كبيرة مقفلة + أساسية مفتوحة».

## الشاشات
الرئيسية · حركة جديدة · المشتريات (فاتورة جديدة + صور الفاتورة بالكاميرا أو المعرض، الفواتير، الموردين ← كشف حساب + تسديد) · الأرصدة (مجموعات + بحث + ملخص كمية/قيمة، والضغط على المادة يفتح بطاقتها) · السجل (تعديل/حذف بسبب إجباري) · الجرد · التقارير · التعديلات والحذف · الإدارة* (المواد، أماكن الخزن، الموظفين، الموردين، التخزين، النظام: استيراد إكسل + نسخة احتياطية JSON (ويا صور الفواتير) + إلغاء تفعيل الجهاز). (* للمدير فقط — راجع «الصلاحيات»). زر «وارد» يفتح فاتورة المشتريات (نموذج الوارد القديم انشال؛ «رصيد افتتاحي» باقي).

## الاستيراد من إكسل
قالب أعمدته: المخزن، المجموعة، اسم المادة، الوحدة الأساسية، الوحدة الكبيرة، التعبئة، الرصيد (بالأساسية)، سعر الوحدة الأساسية، حد الأمان. يتعرف على الأعمدة بالاسم، يعرض شاشة مراجعة (أخطاء/تكرار/استيراد سابق) قبل الحفظ، ويسوي المخازن والمواد الناقصة + حركات `opening`.

## التصدير
`exportSheet()` يطلع xlsx منسّق RTL (عنوان، شريط فلترة، رؤوس زرقاء، أسطر مجموعات، سطر مجموع بمعادلة SUM). الكل يصدّر بالأسعار والكلف.

## قرارات صاحب المشروع
- يفضّل خطوات واضحة وحدة وحدة، وصراحة بالرأي، وتقليل الخيارات.
- اعتمد التصدير المنسّق بدل CSV.
- التصفير يتم من Firebase Console (حذف collections عدا `staff`)، مو من الموقع.

## أفكار مطروحة ولم تُنفّذ بعد
- تقرير شهري لكل مخزن لحاله (حالياً التقرير يجمع كل المخازن).
- ربط الموظف بمخزن معيّن.
- استبدال اللوغو بالملف الأصلي.
- فرض الصلاحيات بالقواعد نفسها (Custom claims أو حساب لكل موظف).
