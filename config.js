// إعدادات الموقع
// ─────────────────────────────────────────────
// 1) اسم المطعم أو المخزن اللي يظهر بأعلى الصفحة
// 2) إعدادات Firebase: تنسخها من Firebase Console ← Project settings ← Your apps ← Web app
//    إذا تركتها فارغة يشتغل الموقع "وضع تجربة" والبيانات تنحفظ على هذا الجهاز فقط.

export const CONFIG = {
  title: "مخزن فرايدي",

  // إيميل حساب المطعم اللي تسويه بـ Firebase ← Authentication ← Users
  deviceEmail: "device@fryday.iq",

  firebase: {
    apiKey: "AIzaSyAMEfS_rfcEfGFa_oMX-y7Wk_FVeJTuEXI",
    authDomain: "stock-dc518.firebaseapp.com",
    projectId: "stock-dc518",
    storageBucket: "stock-dc518.firebasestorage.app",
    messagingSenderId: "245652100669",
    appId: "1:245652100669:web:c01568eb918be1fabbfc54"
  }
};
