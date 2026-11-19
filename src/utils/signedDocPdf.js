// ── 已簽署文件副本 PDF（風險安全聲明書／墜落測驗同意書）：員工端會員詳情「下載 PDF」
// 內容＝簽署當下的文字快照（contentSnapshot.zh）＋本人／法定代理人簽名圖，與「列印」版內容一致。
// 版面元件（字型、簽名欄框線）與合約 PDF 共用 contractPdfShared.js。
const { getPrinter, signatureCell, ACCENT } = require('./contractPdfShared');

// 簽名圖：data URL 直接用；http(s) 網址（舊資料）就下載轉成 data URL；失敗回 null（欄位顯示「未附檔」）
async function toImageSrc(src) {
  if (!src || typeof src !== 'string') return null;
  if (src.startsWith('data:image/')) return src;
  if (/^https?:\/\//.test(src)) {
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get('content-type') || 'image/png';
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch (e) { return null; }
  }
  return null;
}

// opts: { title, memberName, signedAtText, body, signerLabel, signatureImg,
//         guardian?: { name, relation, signedAtText, signatureImg }, notice? }
async function buildSignedDocPdfBuffer(opts) {
  const sig = await toImageSrc(opts.signatureImg);
  const gsig = opts.guardian ? await toImageSrc(opts.guardian.signatureImg) : null;
  // 字型沒有 emoji／特殊空白字元（會變成方框）：⭐→★，其餘 emoji 移除，全形／細空白轉一般空白
  const bodyText = String(opts.body || '').replace(/\r\n/g, '\n')
    .replace(/⭐/g, '\u0001').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').replace(/\u0001/g, '★')
    .replace(/[\u2002\u2003\u2009\u200b]/g, ' ');
  // 空白行分段；每段保留段內換行，避免編號項目擠成一行
  const paragraphs = bodyText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => ({ text: p, margin: [0, 0, 0, 7], lineHeight: 1.35 }));
  const content = [
    { text: opts.title, bold: true, fontSize: 15, color: ACCENT, margin: [0, 0, 0, 4] },
    { text: [opts.memberName ? `會員：${opts.memberName}　` : '', `簽署時間：${opts.signedAtText || '-'}`].join(''), fontSize: 9, color: '#666', margin: [0, 0, 0, 3] },
  ];
  if (opts.notice) content.push({ text: opts.notice, fontSize: 8.5, color: '#B3261E', margin: [0, 0, 0, 3] });
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.2, lineColor: ACCENT }], margin: [0, 2, 0, 8] });
  content.push(...(paragraphs.length ? paragraphs : [{ text: '（無文字內容）', color: '#999' }]));
  const boxes = [{ width: 230, ...signatureCell(opts.signerLabel, sig, 190) }];
  if (opts.guardian) {
    const g = opts.guardian;
    const label = '法定代理人簽名' + (g.name ? `（${g.name}${g.relation ? '・' + g.relation : ''}）` : '');
    boxes.push({ width: 230, ...signatureCell(label, gsig, 190) });
  }
  content.push({ unbreakable: true, margin: [0, 10, 0, 0], stack: [
    ...(opts.guardian && opts.guardian.signedAtText ? [{ text: `法定代理人簽署時間：${opts.guardian.signedAtText}`, fontSize: 8.5, color: '#666', margin: [0, 0, 0, 4] }] : []),
    { columns: boxes, columnGap: 16 },
  ] });
  const docDefinition = {
    defaultStyle: { font: 'NotoSansTC', fontSize: 10, lineHeight: 1.2 },
    pageSize: 'A4', pageMargins: [40, 36, 40, 36],
    footer: (cur, total) => ({ text: `紅石攀岩館　第 ${cur} 頁，共 ${total} 頁`, alignment: 'center', fontSize: 8, color: '#999', margin: [0, 4, 0, 0] }),
    content,
  };
  const pdfDoc = await getPrinter().createPdfKitDocument(docDefinition);
  return new Promise((resolve, reject) => {
    const chunks = [];
    pdfDoc.on('data', c => chunks.push(c));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}

module.exports = { buildSignedDocPdfBuffer };
