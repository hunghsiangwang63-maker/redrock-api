// 角色判斷共用：管理層＝超級管理員或館長。
// 取代各檔手寫的 ['super_admin', 'gym_manager'].includes(role)（2026-10-14 統一；語意完全相同，role 為 undefined 時回 false）。
const MANAGER_ROLES = ['super_admin', 'gym_manager'];
const isManagerRole = (role) => MANAGER_ROLES.includes(role);
module.exports = { MANAGER_ROLES, isManagerRole };
