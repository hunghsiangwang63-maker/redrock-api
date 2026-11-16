/**
 * 紙本單張入場券「使用回收」清冊（collection: paperTickets）
 *
 * 來源：管理員維護的 Excel「票卡使用紀錄.xlsx」的 11506／11701／21506 三個工作表（先前售出的紙本單張入場券，
 * 票號＝5 碼字軌＋4 碼流水號，如 11506-0123；原表 11506 工作表內混有誤植的「11501」前綴，一律以工作表名 11506 為準）。
 * 清冊只含「已售出」的票；查不到的票號一律視為無效。票號首碼不代表館別，兩館的票皆可在任一館使用。
 *
 * 文件 id＝9 碼票號（如 115060123）：{ticketNo, series, serial, sold, used, source}
 *   used:true 之後多帶 usedAt / usedBy / usedByName / usedGymId / useNote（匯入時就已是 used 的舊資料沒有 usedAt，標 usedLegacy:true）
 *   誤登復原：used 改回 false、清掉使用欄位，並把前一次使用紀錄推進 undoHistory（不刪除歷史）
 */
const COLLECTION = 'paperTickets';
const DEFAULT_SERIES = ['11506', '11701', '21506'];
const MAX_BATCH = 200;

// 只留數字；支援 "11506-0123"、115060123、「11506"0123"」等寫法。回傳 9 碼字串或 null。
function normalizeTicketNo(input) {
  const digits = String(input == null ? '' : input).replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}
const formatTicketNo = (no) => `${no.slice(0, 5)}-${no.slice(5)}`;

// 把一段文字（一行一張、或用空白／逗號／分號隔開）拆成票號清單
function parseTicketInput(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,;，；、]+/);
  return raw.map((s) => String(s).trim()).filter(Boolean);
}

const ts = (t) => (t && typeof t.toDate === 'function' ? t.toDate() : t instanceof Date ? t : null);

function describeUsed(d) {
  return {
    usedAt: ts(d.usedAt)?.toISOString() || null,
    usedByName: d.usedByName || null,
    usedGymId: d.usedGymId || null,
    useNote: d.useNote || null,
    legacy: !!d.usedLegacy,
  };
}

async function getSeriesList(db) {
  try {
    const s = await db.collection('systemSettings').doc('paperTicketSeries').get();
    const arr = s.exists ? s.data().series : null;
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (e) { /* 讀不到就用預設 */ }
  return DEFAULT_SERIES;
}

async function countWhere(db, ...conds) {
  let q = db.collection(COLLECTION);
  for (const [f, op, v] of conds) q = q.where(f, op, v);
  const snap = await q.count().get();
  return snap.data().count;
}

async function getSummary(db) {
  const list = await getSeriesList(db);
  const out = [];
  for (const series of list) {
    const [sold, used] = await Promise.all([
      countWhere(db, ['series', '==', series], ['sold', '==', true]),
      countWhere(db, ['series', '==', series], ['sold', '==', true], ['used', '==', true]),
    ]);
    out.push({ series, sold, used, unused: sold - used });
  }
  return out;
}

async function lookup(db, input) {
  const no = normalizeTicketNo(input);
  if (!no) return { ticketNo: String(input), status: 'invalid' };
  const d = await db.collection(COLLECTION).doc(no).get();
  if (!d.exists) return { ticketNo: formatTicketNo(no), status: 'not_found' };
  const x = d.data();
  if (!x.sold) return { ticketNo: formatTicketNo(no), status: 'not_sold' };
  if (x.used) return { ticketNo: formatTicketNo(no), status: 'already_used', ...describeUsed(x) };
  return { ticketNo: formatTicketNo(no), status: 'available' };
}

// 登記使用（回收）。每張各自用交易，避免兩人同時登記同一張。
async function redeemTickets(db, { ticketNos, gymId, staff, note }) {
  const seen = new Set();
  const results = [];
  for (const raw of ticketNos) {
    const no = normalizeTicketNo(raw);
    if (!no) { results.push({ input: raw, status: 'invalid' }); continue; }
    if (seen.has(no)) { results.push({ ticketNo: formatTicketNo(no), status: 'duplicate_in_request' }); continue; }
    seen.add(no);
    const ref = db.collection(COLLECTION).doc(no);
    const r = await db.runTransaction(async (tx) => {
      const d = await tx.get(ref);
      if (!d.exists) return { ticketNo: formatTicketNo(no), status: 'not_found' };
      const x = d.data();
      if (!x.sold) return { ticketNo: formatTicketNo(no), status: 'not_sold' };
      if (x.used) return { ticketNo: formatTicketNo(no), status: 'already_used', ...describeUsed(x) };
      tx.update(ref, {
        used: true, usedAt: new Date(), usedBy: staff.id || null, usedByName: staff.name || null,
        usedGymId: gymId, useNote: note || null, usedLegacy: false, updatedAt: new Date(),
      });
      return { ticketNo: formatTicketNo(no), status: 'redeemed' };
    });
    results.push(r);
  }
  return results;
}

async function undoRedeem(db, { ticketNo, reason, staff }) {
  const no = normalizeTicketNo(ticketNo);
  if (!no) { const e = new Error('票號格式不正確'); e.code = 'INVALID_TICKET'; throw e; }
  const ref = db.collection(COLLECTION).doc(no);
  return db.runTransaction(async (tx) => {
    const d = await tx.get(ref);
    if (!d.exists) { const e = new Error('查無此票號'); e.code = 'NOT_FOUND'; throw e; }
    const x = d.data();
    if (!x.used) { const e = new Error('此票尚未登記使用，無需復原'); e.code = 'NOT_USED'; throw e; }
    const prev = {
      usedAt: ts(x.usedAt), usedByName: x.usedByName || null, usedGymId: x.usedGymId || null,
      useNote: x.useNote || null, legacy: !!x.usedLegacy,
      undoneAt: new Date(), undoneBy: staff.id || null, undoneByName: staff.name || null, undoReason: reason,
    };
    const hist = Array.isArray(x.undoHistory) ? x.undoHistory.slice(-19) : [];
    tx.update(ref, {
      used: false, usedAt: null, usedBy: null, usedByName: null, usedGymId: null, useNote: null, usedLegacy: false,
      undoHistory: [...hist, prev], updatedAt: new Date(),
    });
    return { ticketNo: formatTicketNo(no) };
  });
}

// 最近的使用紀錄（只含系統內登記的，不含匯入時就是 used 的舊資料）
async function recentLog(db, { limit = 100, series } = {}) {
  let q = db.collection(COLLECTION).where('usedAt', '!=', null).orderBy('usedAt', 'desc').limit(Math.min(500, limit));
  const snap = await q.get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((x) => x.used && (!series || x.series === series))
    .map((x) => ({
      ticketNo: formatTicketNo(x.id), series: x.series, ...describeUsed(x),
    }));
}

module.exports = {
  COLLECTION, DEFAULT_SERIES, MAX_BATCH,
  normalizeTicketNo, formatTicketNo, parseTicketInput,
  getSummary, lookup, redeemTickets, undoRedeem, recentLog, getSeriesList,
};
