// 發票號碼管理（P2，見 docs/invoice-integration-plan.md §5.2/§5.2.1/§6）
// ⚠️ 與 invoiceService.js（§9 手動開立發票 modal 用的 invoiceRecords 過渡機制）是不同層次、不同集合：
//    - invoiceService.js / invoiceRecords：現行已上線，店員手動記帳過渡版，跟「印表機真的列印」無關。
//    - 本檔 / invoices 集合：對應第 1-8 節「WP-560 實體印表機自動列印」計畫，供 P3/P4 之後接線時使用。
// 本檔只管「號碼」——換捲設起始號、每次列印前配號（原子遞增）、校正；不處理發票內容/金額/退費邏輯（P4/P6）。

const { getDb } = require('../config/firebase');

const TRACK_RE = /^[A-Z]{2}$/;
const NUMBER_RE = /^\d{8}$/;
// 剩餘張數低於此值 → 視為「即將用完」（前端顯示醒目警語提醒備妥下一捲）；固定常數，非可設定值。
const ROLL_LOW_THRESHOLD = 5;
// 財政部二聯式收銀機發票每捲固定 250 張、捲末號碼固定落在這四組末三碼（見 SettingsPage.jsx
// invRollEndPreviewSuffixOk 同一組常數）——這是官方紙捲的固定編號規律，不論店員換捲重設時有沒有
// 記得填「這捲共幾張」（rollSize），只要配到的號碼末三碼命中，就自動視為「這捲已印完」，之後配號
// 直接擋下（即使沒設定 rollSize 也不會超印），逼一定要走一次換捲重設。
const ROLL_END_SUFFIXES = ['249', '499', '749', '999'];

const validateTrackNumber = (track, number) => {
  if (!TRACK_RE.test(track || '')) return { code: 'INVALID_TRACK', message: '字軌須為 2 碼大寫英文字母' };
  if (!NUMBER_RE.test(String(number || ''))) return { code: 'INVALID_NUMBER', message: '號碼須為 8 碼數字' };
  return null;
};

// 依 state 算出「剩餘張數／即將用完／已用完」——rollDepleted 由兩個獨立條件之一觸發：
// ①手動設過 rollSize 且已超出 rollEndNumber ②剛配出的號碼末三碼命中官方捲末規律（rollFinishedAtConvention，
// 不需要 rollSize 也會生效）。前端既有「🚨 這捲發票紙已用完」紅色警語（讀 rollDepleted）因此自動涵蓋這條新規則。
const withRollStatus = (state) => {
  if (!state) return state;
  const byConvention = !!state.rollFinishedAtConvention;
  if (!state.rollEndNumber) return { ...state, remaining: null, rollLow: false, rollDepleted: byConvention };
  const remaining = Number(state.rollEndNumber) - Number(state.currentNumber) + 1;
  return {
    ...state,
    remaining,
    rollLow: remaining <= ROLL_LOW_THRESHOLD && remaining > 0 && !byConvention,
    rollDepleted: remaining <= 0 || byConvention,
  };
};

// ── 讀取目前號碼狀態（未設定過回 null）──
const getInvoiceState = async (gymId) => {
  const db = getDb();
  const doc = await db.collection('gyms').doc(gymId).get();
  if (!doc.exists) return null;
  return withRollStatus(doc.data().invoiceState || null);
};

// ── 換捲重設／中途校正（同一動作，見 §5.2.1）──
// force=true 時跳過重複號碼警訊直接寫入；否則若該字軌+號碼已出現在 invoices 集合中，回傳 warning 不寫入。
// rollSize（選填）：這捲共幾張——填了才會算出 rollEndNumber，之後配號才會出現「即將用完/已用完」警語；
// 不填則沿用舊行為（無邊界、不警示，供中途校正/未量測張數時使用）。
const setInvoiceState = async (gymId, { track, startNumber, reason, force, rollSize }, { staffId, staffName }) => {
  const db = getDb();
  const t = String(track || '').toUpperCase();
  const n = String(startNumber || '').padStart(8, '0');
  const invalid = validateTrackNumber(t, n);
  if (invalid) throw invalid;
  const size = rollSize != null && rollSize !== '' ? Number(rollSize) : null;
  if (size != null && (!Number.isInteger(size) || size <= 0)) {
    const e = new Error('紙捲張數須為正整數'); e.code = 'INVALID_ROLL_SIZE'; throw e;
  }
  const rollEndNumber = size != null ? String(Number(n) + size - 1).padStart(8, '0') : null;

  if (!force) {
    const dupSnap = await db.collection('invoices')
      .where('track', '==', t).where('number', '==', n).limit(1).get();
    if (!dupSnap.empty) {
      const existing = dupSnap.docs[0].data();
      return { warning: 'DUPLICATE_NUMBER', message: `此號碼（${t}${n}）已被使用過（發票 ${dupSnap.docs[0].id}，狀態：${existing.status}），確定要繼續請重新送出並勾選強制覆寫`, existing: { id: dupSnap.docs[0].id, status: existing.status, date: existing.date } };
    }
  }

  const gymRef = db.collection('gyms').doc(gymId);
  const gymDoc = await gymRef.get();
  const prevState = gymDoc.exists ? (gymDoc.data().invoiceState || null) : null;
  const now = new Date();
  const invoiceState = {
    track: t, currentNumber: n, rollStart: n, rollSize: size, rollEndNumber, updatedAt: now,
    rollFinishedAtConvention: false, // 換捲重設一律重新起算，明確清掉上一捲留下的捲末標記（見上方 withRollStatus）
    lastChange: {
      by: staffId || null, byName: staffName || '', at: now, reason: reason || '',
      from: prevState ? { track: prevState.track, number: prevState.currentNumber } : null,
      to: { track: t, number: n },
    },
  };
  await gymRef.set({ invoiceState }, { merge: true });
  return { success: true, invoiceState: withRollStatus(invoiceState) };
};

// ── 配號（原子遞增；印表機正式列印前呼叫，P3 InvoiceCheckout 用）──
// 回傳本次配到的號碼（配號當下的 currentNumber）+ 配號後剩餘狀態，並把 gyms.invoiceState.currentNumber 遞增為下一號。
// ⚠️ 已設定紙捲張數且這捲已無號碼可配（currentNumber 已超出 rollEndNumber）→ 直接擋下、不予配號（紙上根本
// 沒有這個號碼可印），須先在「發票號碼管理」換上新捲、輸入新捲起始號才能繼續列印。
const allocateInvoiceNumber = async (gymId) => {
  const db = getDb();
  const gymRef = db.collection('gyms').doc(gymId);
  return db.runTransaction(async (tx) => {
    const gymDoc = await tx.get(gymRef);
    const state = gymDoc.exists ? gymDoc.data().invoiceState : null;
    if (!state || !state.track || !state.currentNumber) {
      const e = new Error('此館尚未設定發票號碼（請先在發票號碼管理設定換捲起始號）');
      e.code = 'INVOICE_STATE_NOT_CONFIGURED';
      throw e;
    }
    if (state.rollEndNumber && Number(state.currentNumber) > Number(state.rollEndNumber)) {
      const e = new Error('此捲發票紙已用完，請更換新捲並在「發票號碼管理」設定新捲起始號');
      e.code = 'ROLL_DEPLETED';
      throw e;
    }
    // 上一次配出的號碼若剛好命中官方捲末末三碼（見 ROLL_END_SUFFIXES），代表那張就是這捲最後一張，
    // 這次配號直接擋下——即使當初換捲重設時沒填 rollSize，也能自動抓到捲已印完，逼一定要走換捲重設。
    if (state.rollFinishedAtConvention) {
      const e = new Error('此捲發票紙已印到本捲末三碼（249/499/749/999），請更換新捲並在「發票號碼管理」設定新捲起始號');
      e.code = 'ROLL_DEPLETED';
      throw e;
    }
    const allocated = { track: state.track, number: state.currentNumber };
    const next = String(Number(state.currentNumber) + 1).padStart(8, '0');
    const finishedAtConvention = ROLL_END_SUFFIXES.includes(allocated.number.slice(-3));
    const nextState = { ...state, currentNumber: next, updatedAt: new Date(), rollFinishedAtConvention: finishedAtConvention };
    tx.set(gymRef, { invoiceState: nextState }, { merge: true });
    return { ...allocated, ...withRollStatus(nextState) };
  });
};

module.exports = {
  validateTrackNumber,
  getInvoiceState,
  setInvoiceState,
  allocateInvoiceNumber,
  ROLL_LOW_THRESHOLD,
};
