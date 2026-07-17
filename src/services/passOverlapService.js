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

module.exports = { applyCourseOverlapPassExtension, applyCourseOverlapForMember };
