// 發票號碼管理（P2，見 docs/invoice-integration-plan.md §5.2/§5.2.1/§6）
// ⚠️ 與 invoiceService.js（§9 手動開立發票 modal 用的 invoiceRecords 過渡機制）是不同層次、不同集合：
//    - invoiceService.js / invoiceRecords：現行已上線，店員手動記帳過渡版，跟「印表機真的列印」無關。
//    - 本檔 / invoices 集合：對應第 1-8 節「WP-560 實體印表機自動列印」計畫，供 P3/P4 之後接線時使用。
// 本檔只管「號碼」——換捲設起始號、每次列印前配號（原子遞增）、校正；不處理發票內容/金額/退費邏輯（P4/P6）。

const { getDb } = require('../config/firebase');

const TRACK_RE = /^[A-Z]{2}$/;
const NUMBER_RE = /^\d{8}$/;

const validateTrackNumber = (track, number) => {
  if (!TRACK_RE.test(track || '')) return { code: 'INVALID_TRACK', message: '字軌須為 2 碼大寫英文字母' };
  if (!NUMBER_RE.test(String(number || ''))) return { code: 'INVALID_NUMBER', message: '號碼須為 8 碼數字' };
  return null;
};

// ── 讀取目前號碼狀態（未設定過回 null）──
const getInvoiceState = async (gymId) => {
  const db = getDb();
  const doc = await db.collection('gyms').doc(gymId).get();
  if (!doc.exists) return null;
  return doc.data().invoiceState || null;
};

// ── 換捲重設／中途校正（同一動作，見 §5.2.1）──
// force=true 時跳過重複號碼警訊直接寫入；否則若該字軌+號碼已出現在 invoices 集合中，回傳 warning 不寫入。
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
  return { success: true, invoiceState };
};

// ── 配號（原子遞增；印表機正式列印前呼叫，P3 InvoiceCheckout 用）──
// 回傳本次配到的號碼（配號當下的 currentNumber），並把 gyms.invoiceState.currentNumber 遞增為下一號。
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
    const allocated = { track: state.track, number: state.currentNumber };
    const next = String(Number(state.currentNumber) + 1).padStart(8, '0');
    tx.set(gymRef, { invoiceState: { ...state, currentNumber: next, updatedAt: new Date() } }, { merge: true });
    return allocated;
  });
};

module.exports = {
  validateTrackNumber,
  getInvoiceState,
  setInvoiceState,
  allocateInvoiceNumber,
};
