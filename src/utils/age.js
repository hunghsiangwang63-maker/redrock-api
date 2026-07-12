/**
 * 年齡工具 —— 一律以「出生日期」計算實際年齡，避免各處重寫 dayjs().diff，
 * 也避免用 getMemberType（memberType 可被 VIP/隊員覆蓋而繞過年齡限制）。
 */
const dayjs = require('dayjs');

// 接受 member 物件或 birthday 字串
const _birthdayOf = (x) => (x && typeof x === 'object') ? x.birthday : x;

// birthday → 整數歲（無 birthday / 格式錯誤回 null）
const ageOf = (birthday) => {
  const b = _birthdayOf(birthday);
  if (!b) return null;
  const d = dayjs(b);
  if (!d.isValid()) return null;
  return dayjs().diff(d, 'year');
};

// birthday 存在且 <5（未滿 5 歲）
const isUnder5 = (memberOrBirthday) => {
  const age = ageOf(memberOrBirthday);
  return age !== null && age < 5;
};

// 兒童：birthday 存在且 <13。刻意用「出生日期年齡」而非 getMemberType，
// 避免小孩被設成 VIP/隊員時 memberType 蓋掉 'child' 而繞過限制。
const isChild = (memberOrBirthday) => {
  const age = ageOf(memberOrBirthday);
  return age !== null && age < 13;
};

// 未成年：birthday 存在且 <18（需家長/法定代理人簽名）
const isMinor = (memberOrBirthday) => {
  const age = ageOf(memberOrBirthday);
  return age !== null && age < 18;
};

module.exports = { ageOf, isUnder5, isChild, isMinor };
