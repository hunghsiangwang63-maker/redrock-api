/**
 * 體驗課程「參加人員」Excel 範本產生／上傳解析（2026-10-16）
 * 欄位沿用四欄：姓名、生日、國籍、身分證字號／護照號碼。
 * 只在記憶體解析，不存檔、不寫 log（內含身分證字號）。
 */
const XLSX = require('xlsx');
const dayjs = require('dayjs');
const { sanitizeSheet } = require('./xlsxSafe');

const MAX_PARTICIPANTS = 20;
const HEADERS = ['姓名', '生日', '國籍', '身分證字號／護照號碼'];

function buildTemplateBuffer() {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS]);
  ws['!cols'] = [14, 16, 10, 24].map(w => ({ wch: w }));
  const help = XLSX.utils.aoa_to_sheet([
    ['填寫說明'],
    [`1. 請從「參加人員」工作表第 2 列開始填寫，每人一列，最多 ${MAX_PARTICIPANTS} 人。`],
    ['2. 姓名請填真實姓名（投保用），不可用暱稱。'],
    ['3. 生日可填西元（例 1985-02-01、1985/2/1）或民國（例 740201）。未滿 4 歲無法報名。'],
    ['4. 國籍未填時視為「台灣」。'],
    ['5. 身分證字號／護照號碼為投保用，請確實填寫。'],
  ]);
  help['!cols'] = [{ wch: 80 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '參加人員');
  XLSX.utils.book_append_sheet(wb, help, '填寫說明');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// 各種生日寫法 → ISO（YYYY-MM-DD）；無法辨識回 null
function normalizeBirthday(v) {
  if (v === null || v === undefined || v === '') return '';
  let y, m, d;
  if (typeof v === 'number' && v >= 20000 && v <= 60000) {
    const c = XLSX.SSF.parse_date_code(v);
    if (!c) return null;
    ({ y, m, d } = c);
  } else {
    const s = String(v).trim();
    let r;
    if ((r = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else if ((r = s.match(/^(?:民國)?(\d{2,3})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { y = +r[1] + 1911; m = +r[2]; d = +r[3]; }
    else if (/^\d{8}$/.test(s)) { y = +s.slice(0, 4); m = +s.slice(4, 6); d = +s.slice(6, 8); }
    else if (/^\d{6,7}$/.test(s)) { y = +s.slice(0, -4) + 1911; m = +s.slice(-4, -2); d = +s.slice(-2); }
    else return null;
  }
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dj = dayjs(iso);
  if (!dj.isValid() || dj.format('YYYY-MM-DD') !== iso || y < 1900 || dj.isAfter(dayjs())) return null;
  return iso;
}

function parseParticipantsBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames.includes('參加人員') ? '參加人員' : wb.SheetNames[0];
  if (!sheetName) throw Object.assign(new Error('檔案內沒有工作表'), { code: 'EMPTY_FILE' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
  // 表頭列（前 5 列內含「姓名」）必須存在，否則視為不是範本格式（避免把任意檔案內容當成參加者）
  const headerIdx = rows.slice(0, 5).findIndex(r => r.some(c => String(c).trim() === '姓名'));
  if (headerIdx < 0) throw Object.assign(new Error('找不到「姓名」欄位，請使用範本格式填寫'), { code: 'BAD_FORMAT' });
  const col = { name: 0, birthday: 1, nationality: 2, id: 3 };
  rows[headerIdx].forEach((c, i) => {
    const h = String(c).trim();
    if (h.includes('姓名')) col.name = i;
    else if (h.includes('生日')) col.birthday = i;
    else if (h.includes('國籍')) col.nationality = i;
    else if (h.includes('身分證') || h.includes('護照')) col.id = i;
  });
  const participants = [], issues = [];
  const today = dayjs();
  rows.slice(headerIdx + 1).forEach((r, k) => {
    const rowNo = headerIdx + 2 + k;
    const name = String(r[col.name] ?? '').trim();
    const rawBirthday = r[col.birthday];
    const nationality = String(r[col.nationality] ?? '').trim();
    const idNumber = String(r[col.id] ?? '').trim().toUpperCase();
    if (!name && rawBirthday === '' && !nationality && !idNumber) return; // 空列
    const birthday = normalizeBirthday(rawBirthday);
    if (!name) issues.push({ row: rowNo, message: '缺姓名' });
    if (birthday === null) issues.push({ row: rowNo, name, message: `生日格式無法辨識（${String(rawBirthday).slice(0, 20)}）` });
    else if (birthday && today.diff(dayjs(birthday), 'year') < 4) issues.push({ row: rowNo, name, message: '未滿 4 歲無法報名體驗' });
    if (!idNumber) issues.push({ row: rowNo, name, message: '缺身分證字號／護照號碼' });
    participants.push({ name, birthday: birthday || '', nationality: nationality || '台灣', idNumber });
  });
  if (participants.length > MAX_PARTICIPANTS) {
    throw Object.assign(new Error(`最多 ${MAX_PARTICIPANTS} 人，檔案內有 ${participants.length} 人`), { code: 'TOO_MANY' });
  }
  if (!participants.length) throw Object.assign(new Error('檔案內沒有參加人員資料'), { code: 'EMPTY_FILE' });
  return { participants, issues };
}

module.exports = { MAX_PARTICIPANTS, buildTemplateBuffer, normalizeBirthday, parseParticipantsBuffer };
