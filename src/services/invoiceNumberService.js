// 發票號碼管理（P2，見 docs/invoice-integration-plan.md §5.2/§5.2.1/§6）
// ⚠️ 與 invoiceService.js（§9 手動開立發票 modal 用的 invoiceRecords 過渡機制）是不同層次、不同集合：
//    - invoiceService.js / invoiceRecords：現行已上線，店員手動記帳過渡版，跟「印表機真的列印」無關。
//    - 本檔 / invoices 集合：對應第 1-8 節「WP-560 實體印表機自動列印」計畫，供 P3/P4 之後接線時使用。
// 本檔只管「號碼」——換捲設起始號、每次列印前配號（原子遞增）、校正；不處理發票內容/金額/退費邏輯（P4/P6）。

const { getDb } = require('../config/firebase');

const TRACK_RE = /^[A-Z]{2}$/;
const NUMBER_RE = /^\d{8}$/;
// 剩餘張數低於此值 → 每次配號都提醒「即將用完」（固定常數，最後 5 張，非可設定值）。
const ROLL_LOW_THRESHOLD = 5;
// 財政部二聯式收銀機發票固定編號規律：每 1000 號分成四等分、各 250 張，末三碼固定落在這四組
// （見 SettingsPage.jsx 同一組常數，供換捲時的預覽文字使用）——這是官方紙捲的固定規律，只要知道
// 目前配到哪個號碼，就能直接反推這捲會印到哪個號碼結束，**不需要店員另外輸入「這捲共幾張」**
// （人工輸入容易忘記/填錯；官方規律是固定死的，用號碼本身反推才是唯一真相來源，見下方
// computeRollEndNumber）。
const ROLL_END_SUFFIXES = ['249', '499', '749', '999'];

const validateTrackNumber = (track, number) => {
  if (!TRACK_RE.test(track || '')) return { code: 'INVALID_TRACK', message: '字軌須為 2 碼大寫英文字母' };
  if (!NUMBER_RE.test(String(number || ''))) return { code: 'INVALID_NUMBER', message: '號碼須為 8 碼數字' };
  return null;
};

// 依「任一號碼」直接反推它所屬那一捲（250 張為一個四分位區間）的結束號碼——同一個 1000 號區間內，
// 0-249／250-499／500-749／750-999 四個四分位，各自的結尾固定是 249/499/749/999。不管這個號碼是
// 换捲重設當下輸入的起始號、還是中途校正的號碼，只要落在哪個四分位，那一捲就一定印到那個位置結束
// （物理紙捲本身的編號規律，不受店員什麼時候開始用這套系統影響——即使是接續舊有人工紀錄的中途號碼
// 也一樣適用）。
const computeRollEndNumber = (numberStr) => {
  const n = Number(numberStr);
  const base = Math.floor(n / 1000) * 1000;
  const rem = n - base;
  const boundary = ROLL_END_SUFFIXES.map(Number).find(b => rem <= b) ?? 999;
  return String(base + boundary).padStart(8, '0');
};

// 依 state 算出「剩餘張數／即將用完／已用完」——rollEndNumber 一律即時由 rollStart（該捲起始號）
// 反推計算，不讀任何店員手動輸入的張數，永遠有值（不會是 null）。
const withRollStatus = (state) => {
  if (!state) return state;
  const rollEndNumber = computeRollEndNumber(state.rollStart || state.currentNumber);
  const remaining = Number(rollEndNumber) - Number(state.currentNumber) + 1;
  return {
    ...state,
    rollEndNumber,
    remaining,
    rollLow: remaining <= ROLL_LOW_THRESHOLD && remaining > 0,
    rollDepleted: remaining <= 0,
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
// 這捲會印到哪裡結束一律由 startNumber 依官方固定規律反推（見 computeRollEndNumber），不再收
// 「這捲共幾張」這個手動欄位——人工輸入容易忘記/填錯，官方規律是固定死的，不需要店員另外量測告知。
const setInvoiceState = async (gymId, { track, startNumber, reason, force }, { staffId, staffName }) => {
  const db = getDb();
  const t = String(track || '').toUpperCase();
  const n = String(startNumber || '').padStart(8, '0');
  const invalid = validateTrackNumber(t, n);
  if (invalid) throw invalid;

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
    track: t, currentNumber: n, rollStart: n, updatedAt: now,
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
// ⚠️ 這捲已無號碼可配（currentNumber 已超出依官方規律反推的 rollEndNumber）→ 直接擋下、不予配號（紙上
// 根本沒有這個號碼可印），須先在「發票號碼管理」換上新捲、輸入新捲起始號才能繼續列印。
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
    const rollEndNumber = computeRollEndNumber(state.rollStart || state.currentNumber);
    if (Number(state.currentNumber) > Number(rollEndNumber)) {
      const e = new Error('此捲發票紙已用完，請更換新捲並在「發票號碼管理」設定新捲起始號');
      e.code = 'ROLL_DEPLETED';
      throw e;
    }
    const allocated = { track: state.track, number: state.currentNumber };
    const next = String(Number(state.currentNumber) + 1).padStart(8, '0');
    const nextState = { ...state, currentNumber: next, updatedAt: new Date() };
    tx.set(gymRef, { invoiceState: nextState }, { merge: true });
    return { ...allocated, ...withRollStatus(nextState) };
  });
};

module.exports = {
  validateTrackNumber,
  getInvoiceState,
  setInvoiceState,
  allocateInvoiceNumber,
  computeRollEndNumber,
  ROLL_LOW_THRESHOLD,
};
