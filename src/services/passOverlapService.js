/**
 * passOverlapService — 定期票 × 課程學員免費入場期間 重疊補償（政策 2026-07-17）
 *
 * 會員在定期票有效區間內成為課程學員（有免費入場期間）→ 票在免費期間等同「暫停」，
 * 到期日直接延長 overlap 天數：newEnd = max(原到期日, 免費期間結束日) + overlapDays
 * （用 max 是避免延長的部分又落在免費期間內再被浪費，等同剩餘天數完整挪到免費期後使用）。
 *
 * 規則：
 * - 僅適用「算天數」定期票（credits==null）；回數票不耗天、不延長。
 * - overlap = [max(票起始, 免費起始*), min(票到期, 免費結束)]（*含個別 courseAccessStart 覆寫，取較晚）。
 * - 冪等：每張票對同一課程只套一次（pass.courseOverlapExt[courseId]）。
 * - 全程 try/catch 不阻斷呼叫端（報名/認領/收款確認）。
 *
 * 呼叫點：課程名單自動認領（memberService.claimPendingCourseEnrollment）、
 *         課程收款確認（transfers.js confirm course side-effect）、手動加名單腳本/回填。
 */
const { getDb } = require('../config/firebase');
const dayjs = require('dayjs');

async function applyCourseOverlapPassExtension({ memberId, courseId }) {
  const db = getDb();
  try {
    if (!memberId || !courseId) return null;
    const cdoc = await db.collection('courses').doc(courseId).get();
    if (!cdoc.exists) return null;
    const c = cdoc.data();
    let freeStart = c.unlimitedPracticeStart || c.startDate;
    const freeEnd = c.unlimitedPracticeEnd ||
      (c.endDate ? dayjs(c.endDate).add(c.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD') : null);
    if (!freeStart || !freeEnd) return null;

    // 個別入館起始覆寫（插班 courseAccessStart）：取較晚者（與 getCourseAccess 一致）
    const enSnap = await db.collection('courseEnrollments')
      .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
    if (enSnap.empty) return null; // 非此課學員不套
    const overrides = enSnap.docs.map(d => d.data().courseAccessStart).filter(Boolean).sort();
    if (overrides.length && overrides[overrides.length - 1] > freeStart) freeStart = overrides[overrides.length - 1];
    if (freeStart > freeEnd) return null;

    const snap = await db.collection('memberPasses').where('memberId', '==', memberId).get();
    const results = [];
    for (const doc of snap.docs) {
      const p = doc.data();
      if (p.status !== 'active') continue;
      if (p.credits !== null && p.credits !== undefined) continue;   // 回數票不延長
      if (p.courseOverlapExt && p.courseOverlapExt[courseId]) continue; // 冪等
      const ps = p.startDate, pe = p.endDate;
      if (!ps || !pe) continue;
      const oStart = ps > freeStart ? ps : freeStart;
      const oEnd = pe < freeEnd ? pe : freeEnd;
      if (oStart > oEnd) continue;                                    // 無重疊
      const overlapDays = dayjs(oEnd).diff(dayjs(oStart), 'day') + 1; // 含頭尾
      const base = pe > freeEnd ? pe : freeEnd;
      const newEnd = dayjs(base).add(overlapDays, 'day').format('YYYY-MM-DD');
      const now = new Date();
      await doc.ref.update({
        endDate: newEnd,
        courseOverlapExt: { ...(p.courseOverlapExt || {}), [courseId]: { days: overlapDays, prevEndDate: pe, freeStart, freeEnd, courseName: c.name || '', appliedAt: now } },
        notes: `${p.notes ? p.notes + '\n' : ''}課程學員免費期間重疊補償 +${overlapDays} 天（${c.name || courseId}；原到期 ${pe} → ${newEnd}）`,
        updatedAt: now,
      });
      results.push({ passId: doc.id, passTypeName: p.passTypeName, overlapDays, prevEndDate: pe, newEndDate: newEnd });
      console.log(`[課程重疊補償] ${memberId} ${p.passTypeName || doc.id} +${overlapDays}天 ${pe}→${newEnd}（${c.name || courseId}）`);
    }
    return results;
  } catch (e) {
    console.error('applyCourseOverlapPassExtension 失敗（不阻斷）:', e.message);
    return null;
  }
}

// 反向：買定期票當下已是課程學員 → 對該會員全部 confirmed 課程各套一次（冪等）。
// 呼叫點：櫃檯賣票 POST /passes、入場購票 buy_pass confirmCheckIn（新票建立後）。
async function applyCourseOverlapForMember(memberId) {
  const db = getDb();
  try {
    if (!memberId) return null;
    const en = await db.collection('courseEnrollments')
      .where('memberId', '==', memberId).where('status', '==', 'confirmed').get();
    const courseIds = [...new Set(en.docs.map(d => d.data().courseId).filter(Boolean))];
    const all = [];
    for (const cid of courseIds) {
      const r = await applyCourseOverlapPassExtension({ memberId, courseId: cid });
      if (r && r.length) all.push(...r);
    }
    return all;
  } catch (e) {
    console.error('applyCourseOverlapForMember 失敗（不阻斷）:', e.message);
    return null;
  }
}

// ── 還原（退費連動）───────────────────────────────────────────────
// 當時延長量 delta = newEnd − prevEnd = (max(prevEnd, freeEnd) − prevEnd) + days（由已存欄位精確重算）。
// 還原＝endDate 回推 delta、移除該課程 marker；多課程堆疊為線性加總，逐一回推仍正確。
const extDelta = (ext) => {
  const base = ext.prevEndDate > ext.freeEnd ? ext.prevEndDate : ext.freeEnd;
  return dayjs(base).diff(dayjs(ext.prevEndDate), 'day') + (ext.days || 0);
};

// 課程退費核准 → 還原該會員全部票上「此課程」的延長
async function revertCourseOverlapExtension({ memberId, courseId }) {
  const db = getDb();
  try {
    if (!memberId || !courseId) return null;
    const snap = await db.collection('memberPasses').where('memberId', '==', memberId).get();
    const results = [];
    for (const doc of snap.docs) {
      const p = doc.data();
      const ext = p.courseOverlapExt && p.courseOverlapExt[courseId];
      if (!ext) continue;
      const delta = extDelta(ext);
      const newEnd = dayjs(p.endDate).subtract(delta, 'day').format('YYYY-MM-DD');
      const rest = { ...p.courseOverlapExt }; delete rest[courseId];
      const now = new Date();
      await doc.ref.update({
        endDate: newEnd,
        courseOverlapExt: Object.keys(rest).length ? rest : admin_FieldValue().delete(),
        notes: `${p.notes ? p.notes + '\n' : ''}課程退費 → 還原重疊補償 −${delta} 天（${ext.courseName || courseId}；${p.endDate} → ${newEnd}）`,
        updatedAt: now,
      });
      results.push({ passId: doc.id, passTypeName: p.passTypeName, revertedDays: delta, newEndDate: newEnd });
      console.log(`[重疊補償還原] ${memberId} ${p.passTypeName || doc.id} −${delta}天 ${p.endDate}→${newEnd}（課程退費 ${ext.courseName || courseId}）`);
    }
    return results;
  } catch (e) { console.error('revertCourseOverlapExtension 失敗（不阻斷）:', e.message); return null; }
}

// 定期票退費核准 → 該票「全部」延長先還原（退費天數比例回到原值，避免補償天數被當付費價值多退）
async function revertAllOverlapForPass(passId) {
  const db = getDb();
  try {
    const ref = db.collection('memberPasses').doc(passId);
    const doc = await ref.get();
    if (!doc.exists) return null;
    const p = doc.data();
    if (!p.courseOverlapExt || !Object.keys(p.courseOverlapExt).length) return null;
    let end = p.endDate; let total = 0; const names = [];
    for (const [cid, ext] of Object.entries(p.courseOverlapExt)) {
      const d = extDelta(ext); total += d; names.push(ext.courseName || cid);
      end = dayjs(end).subtract(d, 'day').format('YYYY-MM-DD');
    }
    const now = new Date();
    await ref.update({
      endDate: end,
      courseOverlapExt: admin_FieldValue().delete(),
      notes: `${p.notes ? p.notes + '\n' : ''}定期票退費 → 還原全部重疊補償 −${total} 天（${names.join('、')}；${p.endDate} → ${end}）`,
      updatedAt: now,
    });
    console.log(`[重疊補償還原] 票 ${passId} 退費前還原 −${total}天 ${p.endDate}→${end}`);
    return { revertedDays: total, newEndDate: end };
  } catch (e) { console.error('revertAllOverlapForPass 失敗（不阻斷）:', e.message); return null; }
}

// FieldValue.delete()（lazy 取得，避免頂層依賴 firebase-admin 初始化順序）
function admin_FieldValue() {
  return require('firebase-admin').firestore.FieldValue;
}

module.exports = { applyCourseOverlapPassExtension, applyCourseOverlapForMember, revertCourseOverlapExtension, revertAllOverlapForPass };
