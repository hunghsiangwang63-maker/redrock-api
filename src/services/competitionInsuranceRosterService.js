// ── 比賽簽到表暨保險名冊：共用資料準備（xlsx／PDF 兩種輸出格式共用同一份資料源）──────
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
 * 準備某賽事的保險名冊資料：正取（confirmed）報名，依組別→姓名排序，分成人/未成年兩組（依 isMinor，18歲門檻）。
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
  const regs = snap.docs.map(d => d.data());

  const sortFn = (a, b) =>
    (a.divisionName || '').localeCompare(b.divisionName || '', 'zh-Hant') ||
    (a.memberName || '').localeCompare(b.memberName || '', 'zh-Hant');

  const mapRow = (r, idx) => ({
    no: idx + 1,
    name: r.memberName || '',
    gender: genderLabel(r.gender),
    idNumber: r.idNumber || '',
    birthdayRoc: toRoc7(r.birthday),
    memberSignatureUrl: r.memberSignatureUrl || null,
    guardianSignatureUrl: r.isMinor ? (r.guardianSignatureUrl || null) : null,
    note: r.memberNote || '',
    divisionName: r.divisionName || '',
  });

  const adults = regs.filter(r => !r.isMinor).sort(sortFn).map(mapRow);
  const minors = regs.filter(r => r.isMinor).sort(sortFn).map(mapRow);

  const insuranceDoc = await db.collection('systemSettings').doc('competitionInsurance').get();
  const insD = insuranceDoc.exists ? insuranceDoc.data() : {};
  const insurance = {
    ageLabelUnder: insD.ageLabelUnder || DEFAULT_INSURANCE.ageLabelUnder,
    ageLabelOver: insD.ageLabelOver || DEFAULT_INSURANCE.ageLabelOver,
    rows: (Array.isArray(insD.rows) && insD.rows.length) ? insD.rows : DEFAULT_INSURANCE.rows,
  };

  const gymLabel = GYM_LABEL[competition.gymId] || competition.gymId || '';
  const dateStr = competition.eventDate ? dayjs(competition.eventDate).format('YYYYMMDD') : '';
  const titleBase = `【${gymLabel}】${dateStr} ${competition.name}-簽到表暨保險名冊`;

  return { competition, titleBase, insurance, adults, minors };
}

module.exports = { buildCompetitionInsuranceRosterData, GYM_LABEL, toRoc7, DEFAULT_INSURANCE };
