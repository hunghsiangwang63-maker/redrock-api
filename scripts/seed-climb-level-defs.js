// 小蜘蛛人 1~16 級定義初始匯入（來源：小蜘蛛人上課紀錄表 V4）。冪等：已存在的級別不覆蓋（管理員可能已編修）。
// 用法：NODE_PATH=$PWD/node_modules GOOGLE_APPLICATION_CREDENTIALS=... node scripts/seed-climb-level-defs.js
require('../src/config/firebase').initFirebase();
const { getDb } = require('../src/config/firebase');
const D = [
  [16, '安全墜落姿勢', '標準:2、4、6 階安全墜落', 'Dead hang 20 秒'],
  [15, '簡單橫渡', '標準:任意點二樓橫渡', 'Dead hang 30 秒'],
  [14, '手點抓法練習', '正抓、倒拉、Pinch、Open；標準:固定路線', 'Dead hang 40 秒'],
  [13, '正確身體發力向上', '標準:手拿網球站三步', 'Dead hang 60 秒'],
  [12, '腳法運用', '內側踩，外側踩，換腳；標準:全外側、內側、全換腳', 'Active Dead hang 10 秒'],
  [11, '三角形平衡', '標準:指定三點作出平衡(6 個動作)', 'Active Dead hang 30 秒'],
  [10, '交叉手交叉腳', '標準:橫渡中各 5 次', 'Bent knee L hang 20 秒'],
  [9, '側身', '側身正出手、側身交叉出手；標準:指定路線', 'L Hang 10 秒'],
  [8, 'Flag (outside inside) & Layback', '', 'Toe to bar 5 下'],
  [7, 'DropKnee', '', 'Toe to bar 10 下'],
  [6, 'Heel hook、Toe hook & Bicycle', '', '雨刷(單腳) 5 下'],
  [5, 'Kneebar', '', '雨刷(雙腳) 5 下'],
  [4, 'Mantle', '', 'Pull up 5 下'],
  [3, 'Swing', '', 'Pull up 10 下'],
  [2, 'Dyno', '', '單手(左,右)Lock off 5 秒'],
  [1, 'Parkour', '', 'Toe to bar 5 下'], // 原表與 8 級重複，疑筆誤，待管理員修正
];
(async () => {
  const db = getDb(); let n = 0;
  for (const [level, title, standard, fitness] of D) {
    const id = `spider_${level}`;
    const ref = db.collection('climbLevelDefs').doc(id);
    if ((await ref.get()).exists) continue;
    await ref.set({ id, program: 'spider', level, group: level >= 9 ? '初階班' : '進階班', title, standard, fitness, description: '', createdAt: new Date(), source: 'seed-V4' });
    n++;
  }
  console.log('seeded', n);
})();
