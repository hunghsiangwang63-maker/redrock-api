const admin = require('firebase-admin');

let db, storage, auth;

const initFirebase = () => {
  if (admin.apps.length) return;

  const credential = process.env.FIREBASE_PRIVATE_KEY
    ? admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        clientId: process.env.FIREBASE_CLIENT_ID,
      })
    : admin.credential.applicationDefault();

  admin.initializeApp({
    credential,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  console.log('✅ Firebase initialized');
};

const getDb = () => {
  if (!db) db = admin.firestore();
  return db;
};

const getStorage = () => {
  if (!storage) storage = admin.storage(admin.app());
  return storage;
};

const getAuth = () => {
  if (!auth) auth = admin.auth();
  return auth;
};

const COLLECTIONS = {
  GYMS: 'gyms',
  MEMBERS: 'members',
  WAIVERS: 'waivers',
  PASS_TYPES: 'passTypes',
  MEMBER_PASSES: 'memberPasses',
  CHECK_INS: 'checkIns',
  FALL_TESTS: 'fallTests',
  STAFF: 'staff',
  COURSES: 'courses',
  COURSE_SESSIONS: 'courseSessions',
  COURSE_ENROLLMENTS: 'courseEnrollments',
  COURSE_ATTENDANCE: 'courseAttendance',
  COURSE_LEAVES: 'courseLeaves',
  COURSE_MAKEUPS: 'courseMakeups',
  TRANSACTIONS: 'transactions',
  PRODUCTS: 'products',
  NOTIFICATIONS: 'notifications',
  COMPETITIONS: 'competitions',
  COMPETITION_ENTRIES: 'competitionEntries',
  PERMISSION_OVERRIDES: 'permissionOverrides',
  AUDIT_LOG: 'auditLog',
  VIP_MEMBERS: 'vipMembers',
  SINGLE_ENTRY_TICKETS: 'singleEntryTickets',
  PENDING_CHECK_INS: 'pendingCheckIns',
  DISCOUNT_CARDS: 'discountCards',
  LEGACY_DISCOUNT_CARDS: 'legacyDiscountCards',
  BLACK_CARDS: 'blackCards',
  TEAM_MEMBERS: 'teamMembers',
  BONUS_PASSES: 'bonusPasses',
  INSTALLMENT_PLANS: 'installmentPlans',
  SCHEDULE_SHIFTS: 'scheduleShifts',
  COMPETITIONS: 'competitions',
  COMPETITION_REGISTRATIONS: 'competitionRegistrations',
  PASS_ADJUSTMENTS: 'passAdjustments',
  PASS_REQUESTS: 'passRequests',
};

module.exports = {
  initFirebase,
  getDb,
  getStorage,
  getAuth,
  COLLECTIONS,
};
