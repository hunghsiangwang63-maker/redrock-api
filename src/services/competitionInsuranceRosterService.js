// ── 比賽簽到表暨保險名冊：共用資料準備（xlsx／PDF 兩種輸出格式共用同一份資料源）──────
// 2026-08-27 改版：依 成人(各組別)/未成年 分組（成人一組別一張表、未成年合一張）；
// 欄位改 背號/姓名/性別/身份證字號/民國生日/簽名/發票金額；依背號排序（無背號者排最後）。
// 背號來自計分系統（redrock-comp，athletes map 的 origId ↔ 報名文件 id，同報到掃描 3.379.0 的對應方式）；
// 發票金額走 computeNetReceivedAmount（與開發票 modal 預填/記帳同一單一來源，扣保費）。
const dayjs = require('dayjs');
const { getDb, COLLECTIONS } = require('../config/firebase');

const GYM_LABEL = { 'gym-hsinchu': '新竹紅石', 'gym-shilin': '士林紅石' };

const genderLabel = (g) => (g === 'male' ? '男' : g === 'female' ? '女' : '');

// 西元 YYYY-MM-DD → 民國 7 碼 YYYMMDD（比賽報名生日皆為西元 ISO 格式）
const toRoc7 = (isoDate) => {
  if (!isoDate) return '';
  const d = dayjs(isoDate);
  if (!d.isValid()) return '';
  return String(d.year() - 1911).padStart(3, '0') + String(d.month() + 1).padStart(2, '0') + String(d.date()).padStart(2, '0');
};

const DEFAULT_INSURANCE = {
  ageLabelUnder: '限15足歲以下',
  ageLabelOver: '滿15足歲以上~未滿80歲',
  rows: [
    { label: '特定活動死亡及失能保險', under: '無', over: '100萬' },
    { label: '特定活動醫療保險(實支實付型)', under: '10萬', over: '10萬' },
    { label: '特定活動緊急救援費用保險', under: '50萬', over: '50萬' },
  ],
};

/**
 * 準備某賽事的保險名冊資料：正取（confirmed）報名。
 * 分組＝成人依組別各一組（依賽事設定的組別順序）＋未成年合一組；各組內依背號排序（無背號者排最後、再依姓名）。
 * 回傳 { competition, titleBase, insurance, groups: [{ sheetName, title, rows }] }。
 * 未成年除參賽者本人簽名外，另帶出法定代理人簽名（有的話）供嵌入。
 */
async function buildCompetitionInsuranceRosterData(competitionId) {
  const db = getDb();
  const compDoc = await db.collection(COLLECTIONS.COMPETITIONS || 'competitions').doc(competitionId).get();
  if (!compDoc.exists) throw { code: 'NOT_FOUND', message: '找不到賽事' };
  const competition = { id: compDoc.id, ...compDoc.data() };

  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations')
    .where('competitionId', '==', competitionId)
    .where('status', '==', 'confirmed')
    .get();
  const regs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 背號：已對接計分系統才查得到；讀取失敗不阻斷名冊產出（背號留空）
  const bibByRegId = {};
  if (competition.compDocId) {
    try {
      const { getCompDb } = require('../config/compFirebase');
      const evDoc = await getCompDb().collection('competitions').doc(competition.compDocId).get();
      if (evDoc.exists) {
        Object.values(evDoc.data().athletes || {}).forEach(a => {
          if (a && a.origId && a.bib != null && String(a.bib) !== '') bibByRegId[a.origId] = String(a.bib);
        });
      }
    } catch (e) { console.error('[保險名冊] 讀取計分系統背號失敗（不阻斷）:', e.message); }
  }

  const { computeNetReceivedAmount } = require('./competitionService');

  const mapRow = (r) => ({
    bib: bibByRegId[r.id] || '',
    name: r.memberName || '',
    gender: genderLabel(r.gender),
    idNumber: r.idNumber || '',
    birthdayRoc: toRoc7(r.birthday),
    memberSignatureUrl: r.memberSignatureUrl || null,
    guardianSignatureUrl: r.isMinor ? (r.guardianSignatureUrl || null) : null,
    invoiceAmount: computeNetReceivedAmount(r),
    divisionName: r.divisionName || '',
  });

  // 依背號排序：有背號者按數字升冪在前，無背號者排最後（再依姓名）
  const sortByBib = (a, b) => {
    const na = a.bib === '' ? Infinity : Number(a.bib);
    const nb = b.bib === '' ? Infinity : Number(b.bib);
    if (na !== nb) return na - nb;
    return (a.name || '').localeCompare(b.name || '', 'zh-Hant');
  };

  const adults = regs.filter(r => !r.isMinor).map(mapRow);
  const minors = regs.filter(r => r.isMinor).map(mapRow).sort(sortByBib);

  // 成人依組別分組（依賽事設定的組別順序；報名記錄的組別不在設定清單中則附加在後）
  const divOrder = (competition.divisions || []).map(d => d.name).filter(Boolean);
  const adultByDiv = new Map();
  adults.forEach(r => {
    const key = r.divisionName || '未分組';
    if (!adultByDiv.has(key)) adultByDiv.set(key, []);
    adultByDiv.get(key).push(r);
  });
  const divKeys = [...adultByDiv.keys()].sort((a, b) => {
    const ia = divOrder.indexOf(a), ib = divOrder.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b, 'zh-Hant');
  });

  const gymLabel = GYM_LABEL[competition.gymId] || competition.gymId || '';
  const dateStr = competition.eventDate ? dayjs(competition.eventDate).format('YYYYMMDD') : '';
  const titleBase = `【${gymLabel}】${dateStr} ${competition.name}-簽到表暨保險名冊`;

  const groups = divKeys.map(k => ({
    sheetName: `成人(${k})`,
    title: `${titleBase}（成人 ${k}）`,
    rows: adultByDiv.get(k).sort(sortByBib),
  }));
  groups.push({ sheetName: '未成年', title: `${titleBase}（未成年）`, rows: minors });

  return { competition, titleBase, insurance: await loadInsurance(db), groups };
}

async function loadInsurance(db) {
  const insuranceDoc = await db.collection('systemSettings').doc('competitionInsurance').get();
  const insD = insuranceDoc.exists ? insuranceDoc.data() : {};
  return {
    ageLabelUnder: insD.ageLabelUnder || DEFAULT_INSURANCE.ageLabelUnder,
    ageLabelOver: insD.ageLabelOver || DEFAULT_INSURANCE.ageLabelOver,
    rows: (Array.isArray(insD.rows) && insD.rows.length) ? insD.rows : DEFAULT_INSURANCE.rows,
  };
}

module.exports = { buildCompetitionInsuranceRosterData, GYM_LABEL, toRoc7, DEFAULT_INSURANCE };
