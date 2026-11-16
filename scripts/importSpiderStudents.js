/**
 * 匯入「小蜘蛛人基本資料 2026年」：等級通過紀錄＋衣服領取紀錄（見 services/spiderImportService.js 說明）。
 *
 * 比對規則：A 級＝姓名相符＋（本人／家長電話相符或生日相符）→ 直接匯入；B 級＝只有姓名且唯一相符 → 預設不匯入，
 * 列清單給管理員確認（確認後用 --confirm-b=姓名1,姓名2 或 --all-b 匯入）；同名多筆 → 不匯入；查無（未註冊）→ 存待認領。
 * 冪等：等級紀錄 id＝imp_<memberId>_<級數>、衣服 id＝imp_<memberId>_u<序號>、待認領 id＝依姓名＋電話，可重複執行。
 *
 * 用法（redrock-api 目錄下）：
 *   預覽：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/importSpiderStudents.js [檔案.xlsx]
 *   寫入：... node scripts/importSpiderStudents.js [檔案.xlsx] --commit [--all-b | --confirm-b=姓名1,姓名2]
 */
const fs = require('fs');
const path = require('path');
const { initFirebase, getDb } = require('../src/config/firebase');
const svc = require('../src/services/spiderImportService');

const DEFAULT_FILE = '/Users/wanghongxiang/Downloads/小蜘蛛人基本資料 2026年(請用這個檔案).xlsx';
const OUT_DIR = path.join(process.env.HOME, 'Documents/Codex/2026-10-23/3-4-app-app-redrocktaiwan-com/outputs/小蜘蛛人匯入預覽');
const args = process.argv.slice(2);
const commit = args.includes('--commit');
const allB = args.includes('--all-b');
const confirmB = ((args.find((a) => a.startsWith('--confirm-b=')) || '').split('=')[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
const file = args.find((a) => !a.startsWith('--')) || DEFAULT_FILE;

(async () => {
  const { students, flags, unmatchedReissues } = await svc.readWorkbook(file);
  initFirebase();
  const db = getDb();
  const members = (await db.collection('members').select('name', 'phone', 'birthday', 'parentMemberId', 'isChildAccount').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const match = svc.buildMatcher(members);
  const res = { A: [], B: [], multi: [], none: [] };
  for (const s of students) {
    const m = match(s);
    (m.tier === 'A' ? res.A : m.tier === 'B' ? res.B : m.tier === 'multi' ? res.multi : res.none).push({ s, m });
  }
  const lvCount = (arr) => arr.reduce((n, x) => n + Object.keys(x.s.levels).length, 0);
  const unCount = (arr) => arr.reduce((n, x) => n + x.s.uniforms.length, 0);
  console.log(`學員 ${students.length} 人｜A 吻合 ${res.A.length}（等級 ${lvCount(res.A)} 筆、衣服 ${unCount(res.A)} 筆）｜B 僅姓名 ${res.B.length}｜同名多筆 ${res.multi.length}｜未註冊 ${res.none.length}（等級 ${lvCount(res.none)} 筆、衣服 ${unCount(res.none)} 筆）`);
  console.log(`日期欄異常 ${flags.length} 筆（已自動修正 ${flags.filter((f) => f.kind === 'fixed').length}、無法解析 ${flags.filter((f) => f.kind === 'unparsed').length}）；再次發放工作表找不到學員 ${unmatchedReissues.length} 筆`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = (arr, tier) => arr.map(({ s, m }) => ({
    tier, 姓名: s.name, 班別: s.cls, 家長電話: s.phones.join('/'), 生日: s.birthday, 等級數: Object.keys(s.levels).length, 衣服筆數: s.uniforms.length,
    系統會員: m.member ? `${m.member.name}（${m.member.id}，電話 ${m.member.phone}，生日 ${m.member.birthday ? String(m.member.birthday).slice(0, 10) : '—'}）` : (m.candidates || []).map((c) => `${c.name}(${c.id.slice(0, 8)})`).join('；'),
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'B_僅姓名吻合_請確認.json'), JSON.stringify(rows(res.B, 'B').concat(rows(res.multi, 'multi')), null, 2));
  fs.writeFileSync(path.join(OUT_DIR, '日期異常.json'), JSON.stringify({ flags, unmatchedReissues }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'A_已吻合.json'), JSON.stringify(rows(res.A, 'A'), null, 2));
  fs.writeFileSync(path.join(OUT_DIR, '衣服解析結果.json'), JSON.stringify(students.map((s) => ({ 姓名: s.name, uniforms: s.uniforms })), null, 2));
  console.log('明細已寫到', OUT_DIR);
  if (!commit) { console.log('（預覽模式，未寫入資料庫。加 --commit 才會寫入）'); process.exit(0); }

  let lv = 0, un = 0, pend = 0, skipB = 0;
  const doMember = async ({ s, m }) => { const r = await svc.applyStudentToMember(db, m.member.id, m.member.name, s); lv += r.levelsCreated; un += r.uniformsCreated; };
  for (const x of res.A) await doMember(x);
  for (const x of res.B) { if (allB || confirmB.includes(x.s.name)) await doMember(x); else skipB++; }
  for (const { s } of res.none) {
    const id = `p_${svc.normName(s.name)}_${s.phones[0] || 'nophone'}_${s.birthday || 'nobirth'}`.slice(0, 120);
    const ref = db.collection(svc.PENDING).doc(id);
    const ex = await ref.get();
    if (ex.exists && ex.data().status === 'claimed') continue;
    await ref.set({ id, status: 'pending', name: s.name, phone: s.phones[0] || null, phones: s.phones, birthday: s.birthday, cls: s.cls, email: s.email, levels: s.levels, uniforms: s.uniforms, source: 'xlsx-import', createdAt: ex.exists ? ex.data().createdAt : new Date(), updatedAt: new Date() }, { merge: false });
    pend++;
  }
  console.log(`✅ 完成：等級 ${lv} 筆、衣服 ${un} 筆、待認領 ${pend} 人；略過 B 級 ${skipB} 人、同名多筆 ${res.multi.length} 人`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
