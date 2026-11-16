// 小蜘蛛人等級制啟用範圍（可被 systemSettings/climbLevels 覆寫）。初階班 16~9、進階班 8~1（來源：小蜘蛛人上課紀錄表 V4）
const DEFAULT_PROGRAMS = {
  spider: {
    name: '小蜘蛛人',
    gymIds: ['gym-hsinchu'],
    categoryIds: ['ebf83b51-ae84-4aa5-975a-7c3050afa7ff', '48151e8e-884b-42aa-b368-bed118a48f14'], // 小蜘蛛人初級班、進階班
    minLevel: 1, maxLevel: 16,
  },
  // 2026-11-16 新增：青少年初級班、青少年進階班（新竹）。級數同為 1~16，但考核內容獨立一套（climbLevelDefs/teen_N，初始複製自 spider，由管理員修改）
  teen: {
    name: '青少年',
    gymIds: ['gym-hsinchu'],
    categoryIds: ['5c425d99-442d-4619-9df8-858f131a5fca', '6a26014f-6f12-4b3a-9dc5-847181e14050'],
    minLevel: 1, maxLevel: 16,
  },
};
const PROGRAM_KEYS = Object.keys(DEFAULT_PROGRAMS);

const getProgram = async (db, key) => {
  const base = DEFAULT_PROGRAMS[key];
  if (!base) return null;
  try {
    const s = await db.collection('systemSettings').doc('climbLevels').get();
    const o = s.exists ? (s.data()[key] || {}) : {};
    return { key, ...base, ...o };
  } catch (e) { return { key, ...base }; }
};

// 這門課是否屬於該等級制（週課＋指定班別＋指定場館）
const isProgramCourse = (prog, course) => !!course && course.type !== 'workshop'
  && (prog.categoryIds || []).includes(course.categoryId) && (!prog.gymIds || !prog.gymIds.length || prog.gymIds.includes(course.gymId));

// 全部等級制（小蜘蛛人＋青少年）與「這門課屬於哪一個」
const getPrograms = (db) => Promise.all(PROGRAM_KEYS.map((k) => getProgram(db, k)));
const programForCourse = (programs, course) => programs.find((p) => isProgramCourse(p, course)) || null;

module.exports = { DEFAULT_PROGRAMS, PROGRAM_KEYS, getProgram, getPrograms, programForCourse, isProgramCourse };
