const { initFirebase, getDb } = require('../src/config/firebase');
initFirebase(); const db = getDb();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');

(async () => {
  const passTypeId = uuidv4();
  await db.collection('passTypes').doc(passTypeId).set({
    id: passTypeId, name: '【練習】半年分期示範票', price: 6000,
    durationMonths: 6, scope: 'shared', isActive: true, credits: null,
    installment: { enabled: true, periods: [
      { percent: 40, dueOffsetDays: 0 },
      { percent: 30, dueOffsetDays: 60 },
      { percent: 30, dueOffsetDays: 120 },
    ] },
    createdAt: new Date(), updatedAt: new Date(),
  });
  console.log('passTypeId:', passTypeId);

  const memberId = uuidv4();
  await db.collection('members').doc(memberId).set({
    id: memberId, name: '【練習】分期流程示範', phone: '0900777888',
    passwordHash: await bcrypt.hash('test1234', 10),
    birthday: '1990-01-01', emailVerified: true, registeredBy: 'self',
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.collection('waivers').doc(memberId).set({ memberId, isComplete: true, signedAt: new Date() });
  await db.collection('fallTests').add({
    memberId, result: 'passed', testedAt: new Date(),
    expiresAt: '2027-12-31',
  });
  console.log('memberId:', memberId);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
