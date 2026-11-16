/**
 * 小蜘蛛人學員資料匯入（等級通過紀錄＋衣服領取紀錄）
 *
 * 來源：「小蜘蛛人基本資料 2026年(請用這個檔案).xlsx」的「學員基本資料(含舊生)」（個人資料＋16~1 級通過日期）
 * 與「滿2年衣服再次發放」兩個工作表。
 *
 * 資料落點：
 *  - 等級：climbLevelRecords（每個通過的級數一筆，progress:100、passed:true、教練「舊紀錄匯入」，id 固定
 *    `imp_<memberId>_<level>`，所以重複匯入不會重複建立）。
 *  - 衣服：uniformIssues（每次發放一筆：日期、尺寸、第幾次發放、備註、原始文字）。
 *  - 尚未註冊的學員：存 climbPendingStudents（姓名＋家長電話＋等級＋衣服），該人日後註冊（或家長新增孩子）
 *    時由 claimPendingStudent 以「家長電話＋姓名」自動掛上，與前期請假補課券自動媒合同一套做法。
 */
const { v4: uuidv4 } = require('uuid');

const PENDING = 'climbPendingStudents';
const RECORDS = 'climbLevelRecords';
const UNIFORMS = 'uniformIssues';
const GYM = 'gym-hsinchu';
const IMPORT_COACH = '舊紀錄匯入';
const IMPORT_NOTE = 'Excel 匯入（小蜘蛛人基本資料 2026年）';

const normPhone = (p) => {
  const d = String(p == null ? '' : p).replace(/\D/g, '');
  if (d.length === 9) return `0${d}`;          // Excel 把開頭 0 吃掉的手機（937994419）
  return d;
};
const normName = (n) => String(n || '').replace(/[\s（(].*$/, '').replace(/\s/g, '');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const fromDateObj = (d) => ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());

// ── 等級日期欄解析（含打錯字的修正，回傳 {date, fixed:'說明'|null}；解析不出回 {date:null, bad:原值}）──
function parseLevelDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    let y = v.getFullYear();
    let fixed = null;
    if (y >= 3000) return { date: null, bad: `${y}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}（年份異常）` };   // 20256 之類無法猜
    if (y > 2100) { y -= 180; fixed = `年份 ${v.getFullYear()} 疑為 ${y}`; }   // 2202 → 2022
    return { date: ymd(y, v.getMonth() + 1, v.getDate()), fixed };
  }
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/))) return { date: ymd(m[1], m[2], m[3]), fixed: null };
  if ((m = s.match(/^(\d{4})\/(\d{2})(\d{2})$/))) return { date: ymd(m[1], m[2], m[3]), fixed: `「${s}」缺斜線，當成 ${m[1]}/${m[2]}/${m[3]}` };
  if ((m = s.match(/^(\d{4})\/(\d)(\d{2})$/))) return { date: ymd(m[1], m[2], m[3]), fixed: `「${s}」缺斜線，當成 ${m[1]}/${m[2]}/${m[3]}` };
  if ((m = s.match(/^(\d{4})\/(\d{1,2})\/0?(\d{2})\d?$/)) && s.split('/')[2].length === 3) return { date: ymd(m[1], m[2], m[3]), fixed: `「${s}」日期多一碼，當成 ${m[1]}/${m[2]}/${m[3]}` };
  if ((m = s.match(/^(\d{4})(\d)\/(\d)$/))) return { date: ymd(m[1], m[2], m[3]), fixed: `「${s}」年份後多一碼，當成 ${m[1]}/${m[2]}/${m[3]}` };
  return { date: null, bad: s };
}

// ── 衣服領取日欄解析 ──
// 型態：日期｜「已領」｜「已領\n日期」｜「日期\n日期」｜「日期試初M」｜「v」｜空白。
// 規則：多個日期＝第一個是首次、其後是再次發放；「已領＋一個日期」＝首次（日期不詳）＋再次發放（那個日期）；
// 單一日期＝首次。每筆保留原始文字（rawText）。
function parseClothing(v) {
  if (v == null || v === '') return [];
  if (v instanceof Date) return [{ kind: 'first', issuedAt: fromDateObj(v), datePrecision: 'day', rawText: fromDateObj(v), note: null, size: null }];
  const raw = String(v).trim();
  const found = [];
  const re = /(\d{4})[\/.-](\d{1,2})(?:[\/.-](\d{1,2}))?/g;
  let m;
  while ((m = re.exec(raw))) {
    found.push(m[3] ? { issuedAt: ymd(m[1], m[2], m[3]), datePrecision: 'day' } : { issuedAt: `${m[1]}-${pad(m[2])}`, datePrecision: 'month' });
  }
  const noteText = raw.replace(re, '').replace(/已領|\s/g, '').trim();  // 例：「試初M」「v」
  const noteOrNull = noteText && noteText !== 'v' ? noteText : null;
  const sizeGuess = (noteText.match(/(?:^|[^A-Za-z])(XXL|XL|XS|S|M|L)(?![A-Za-z])/i) || [])[1];
  const hasPaid = /已領/.test(raw);
  if (!found.length) return [{ kind: 'first', issuedAt: null, datePrecision: null, rawText: raw, note: noteOrNull, size: null }];
  const out = [];
  if (hasPaid && found.length === 1) {
    out.push({ kind: 'first', issuedAt: null, datePrecision: null, rawText: '已領', note: '已領（日期不詳）', size: null });
    out.push({ kind: 'replacement', ...found[0], rawText: raw, note: noteOrNull, size: sizeGuess ? sizeGuess.toUpperCase() : null });
    return out;
  }
  found.forEach((f, i) => out.push({ kind: i === 0 ? 'first' : 'replacement', ...f, rawText: raw, note: i === 0 ? noteOrNull : null, size: i === 0 && sizeGuess ? sizeGuess.toUpperCase() : null }));
  return out;
}

// ── 讀整份 Excel → 學員陣列 ──
async function readWorkbook(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const val = (c) => {
    const v = c && c.value;
    if (v == null) return null;
    if (v instanceof Date) return v;
    if (typeof v === 'object') return v.result ?? v.text ?? null;
    return v;
  };
  const ws = wb.getWorksheet('學員基本資料(含舊生)');
  if (!ws) throw new Error('找不到工作表「學員基本資料(含舊生)」');
  const students = [];
  const flags = [];
  ws.eachRow((row, n) => {
    if (n <= 2) return;
    const c = (i) => val(row.getCell(i + 1));
    const name = c(2);
    if (!name || !String(name).trim()) return;
    const s = {
      row: n, no: c(0), cls: String(c(1) || '').replace(/\s+/g, ''), name: String(name).trim(),
      birthday: c(4) instanceof Date ? fromDateObj(c(4)) : null,
      phones: [], email: c(9) ? String(c(9)).trim() : null, levels: {}, uniforms: [],
    };
    const phoneRaw = String(c(8) == null ? '' : c(8));
    const digits = phoneRaw.replace(/[^\d,;、/ ]/g, ' ').split(/[\s,;、/]+/).filter(Boolean);
    for (const d of digits) { const p = normPhone(d); if (p.length >= 9) s.phones.push(p); }
    if (!s.phones.length) { const p = normPhone(phoneRaw); if (p.length === 20) { s.phones.push(p.slice(0, 10), p.slice(10)); } else if (p.length >= 9) s.phones.push(p); }
    // 級別欄：第 12 欄＝16 級 … 第 27 欄＝1 級
    for (let i = 12; i <= 27; i++) {
      const lv = 28 - i;                          // 12→16, 27→1
      const raw = c(i);
      if (raw == null || raw === '') continue;
      const p = parseLevelDate(raw);
      if (!p || !p.date) { flags.push({ row: n, name: s.name, level: lv, kind: 'unparsed', raw: String(raw) }); continue; }
      if (p.fixed) flags.push({ row: n, name: s.name, level: lv, kind: 'fixed', raw: String(raw), note: p.fixed, date: p.date });
      s.levels[lv] = p.date;
    }
    s.uniforms = parseClothing(c(3)).map((u) => ({ ...u }));
    students.push(s);
  });
  // 同一位學員在表上出現多列（重複登打；有的列缺生日）→ 合併成一位：同姓名＋同電話＋生日相同或其中一邊沒填
  const merged = [];
  for (const s of students) {
    const dup = merged.find((m) => normName(m.name) === normName(s.name)
      && (m.phones.some((p) => s.phones.includes(p)) || (!m.phones.length && !s.phones.length))
      && (!m.birthday || !s.birthday || m.birthday === s.birthday));
    if (!dup) { merged.push(s); continue; }
    dup.mergedRows = [...(dup.mergedRows || [dup.row]), s.row];
    if (!dup.birthday) dup.birthday = s.birthday;
    for (const [lv, d] of Object.entries(s.levels)) if (!dup.levels[lv]) dup.levels[lv] = d;
    for (const u of s.uniforms) {
      if (!dup.uniforms.some((x) => x.kind === u.kind && x.issuedAt === u.issuedAt && (x.rawText || '') === (u.rawText || ''))) dup.uniforms.push(u);
    }
  }
  students.length = 0; students.push(...merged);

  // 滿 2 年衣服再次發放
  const ws2 = wb.getWorksheet('滿2年衣服再次發放');
  const reissues = [];
  if (ws2) {
    ws2.eachRow((row, n) => {
      if (n === 1) return;
      const nm = val(row.getCell(2));
      if (!nm) return;
      const d = val(row.getCell(4));
      const size = val(row.getCell(6));
      const note = [val(row.getCell(7)), val(row.getCell(8))].filter(Boolean).map((x) => String(x).replace(/\s+/g, ' ').trim()).join('；') || null;
      reissues.push({
        row: n, name: String(nm).trim(), cls: String(val(row.getCell(3)) || '').replace(/\s+/g, ''),
        issuedAt: d instanceof Date ? fromDateObj(d) : null, size: size != null ? String(size).trim() : null, note,
      });
    });
  }
  // 把再次發放併進學員（同姓名；同日期則補尺寸與備註，不同日期另加一筆）
  const unmatchedReissues = [];
  for (const r of reissues) {
    const hits = students.filter((s) => normName(s.name) === normName(r.name));
    if (!hits.length) { unmatchedReissues.push(r); continue; }
    const s = hits[0];
    const same = s.uniforms.find((u) => u.issuedAt === r.issuedAt && r.issuedAt);
    if (same) { if (r.size) same.size = r.size; if (r.note) same.note = [same.note, r.note].filter(Boolean).join('；'); same.fromReissueSheet = true; }
    else s.uniforms.push({ kind: 'replacement', issuedAt: r.issuedAt, datePrecision: r.issuedAt ? 'day' : null, size: r.size, note: r.note, rawText: '「滿2年衣服再次發放」工作表', fromReissueSheet: true });
  }
  return { students, flags, reissues, unmatchedReissues };
}

// ── 比對既有會員 ──
// A 級＝姓名相符＋（本人電話或家長電話相符，或生日相符）；B 級＝只有姓名且唯一相符；其餘＝查無／同名多筆。
function buildMatcher(members) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const byName = new Map();
  for (const m of members) { const k = normName(m.name); if (!k) continue; (byName.get(k) || byName.set(k, []).get(k)).push(m); }
  const phoneOf = (m) => {
    const own = normPhone(m.phone);
    const par = m.parentMemberId ? normPhone((byId.get(m.parentMemberId) || {}).phone) : '';
    return [own, par].filter(Boolean);
  };
  return (s) => {
    const cand = byName.get(normName(s.name)) || [];
    const bdiff = (m) => !!(s.birthday && m.birthday && String(m.birthday).slice(0, 10) !== s.birthday);   // 生日兩邊都有且不同 → 不同人
    const strong = cand.filter((m) => !bdiff(m) && (phoneOf(m).some((p) => s.phones.includes(p)) || (s.birthday && m.birthday && String(m.birthday).slice(0, 10) === s.birthday)));
    if (strong.length === 1) return { tier: 'A', member: strong[0] };
    if (strong.length > 1) return { tier: 'multi', candidates: strong };
    // 生日兩邊都有、而且不一樣 → 一定是不同人（例如同名的成人會員），視為尚未註冊
    const plausible = cand.filter((m) => !(s.birthday && m.birthday && String(m.birthday).slice(0, 10) !== s.birthday));
    if (plausible.length === 1) return { tier: 'B', member: plausible[0] };
    if (plausible.length > 1) return { tier: 'multi', candidates: plausible };
    return { tier: 'none' };
  };
}

// ── 把一位學員的等級＋衣服套用到一個會員（冪等）──
async function applyStudentToMember(db, memberId, memberName, s, { actor = 'import', actorName = '匯入', now = new Date() } = {}) {
  let levelsCreated = 0, uniformsCreated = 0;
  const batch = db.batch();
  for (const [lv, date] of Object.entries(s.levels || {})) {
    const id = `imp_${memberId}_${lv}`;
    const ref = db.collection(RECORDS).doc(id);
    const ex = await ref.get();
    if (ex.exists) continue;
    batch.set(ref, {
      id, program: 'spider', memberId, memberName: memberName || s.name, level: Number(lv), progress: 100, passed: true, date,
      coachName: IMPORT_COACH, courseId: null, courseName: '', gymId: GYM, description: '', note: IMPORT_NOTE,
      voided: false, source: 'xlsx-import', createdBy: actor, createdByName: actorName, createdAt: now,
    });
    levelsCreated++;
  }
  (s.uniforms || []).forEach((u, i) => {
    const id = `imp_${memberId}_u${i}`;
    batch.set(db.collection(UNIFORMS).doc(id), {
      id, memberId, memberName: memberName || s.name, gymId: GYM, kind: u.kind, issuedAt: u.issuedAt || null, datePrecision: u.datePrecision || null,
      size: u.size || null, note: u.note || null, rawText: u.rawText || null, source: 'xlsx-import',
      voided: false, createdBy: actor, createdByName: actorName, createdAt: now,
    }, { merge: false });
    uniformsCreated++;
  });
  if (levelsCreated || uniformsCreated) await batch.commit();
  return { levelsCreated, uniformsCreated };
}

// ── 註冊／新增家庭成員時自動認領（家長電話＋姓名）──
async function claimPendingStudent(db, memberId, member, parentPhone) {
  try {
    const phones = [normPhone(member.phone), normPhone(parentPhone)].filter(Boolean);
    if (!phones.length) return null;
    const uniq = [...new Set(phones)];
    const snap = await db.collection(PENDING).where('phone', 'in', uniq.slice(0, 10)).get();
    const mine = normName(member.name);
    const hit = snap.docs.find((d) => { const x = d.data(); return x.status === 'pending' && normName(x.name) === mine; });
    if (!hit) return null;
    const x = hit.data();
    const r = await applyStudentToMember(db, memberId, member.name, x, { actor: 'claim', actorName: '註冊自動認領' });
    await hit.ref.update({ status: 'claimed', claimedBy: memberId, claimedAt: new Date(), updatedAt: new Date() });
    console.log(`[小蜘蛛人認領] ${member.name} → 等級 ${r.levelsCreated} 筆、衣服 ${r.uniformsCreated} 筆`);
    return r;
  } catch (e) {
    console.error('claimPendingStudent 失敗（不阻斷建立會員）:', e.message);
    return null;
  }
}

module.exports = {
  PENDING, RECORDS, UNIFORMS, GYM, normPhone, normName, parseLevelDate, parseClothing,
  readWorkbook, buildMatcher, applyStudentToMember, claimPendingStudent,
};
