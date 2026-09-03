const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const credDir = path.join(process.env.HOME, 'Documents/RedRock/憑證');
const credFile = fs.readdirSync(credDir).find(f => f.includes('firebase-adminsdk'));
admin.initializeApp({ credential: admin.credential.cert(require(path.join(credDir, credFile))) });
const db = admin.firestore();

(async () => {
  const snap = await db.collection('competitionRegistrations').where('memberName', '==', '陳依婷').get();
  console.log('found:', snap.size);
  for (const d of snap.docs) {
    const r = d.data();
    console.log('\n--- doc', d.id, '---');
    console.log(JSON.stringify({
      competitionId: r.competitionId, competitionName: r.competitionName, divisionName: r.divisionName,
      status: r.status, paymentStatus: r.paymentStatus, paidAmount: r.paidAmount, registrationFee: r.registrationFee,
      refundRequested: r.refundRequested, refundAmount: r.refundAmount, refundBankCode: r.refundBankCode,
      cancelledAt: r.cancelledAt, cancelReason: r.cancelReason, isEarlyBird: r.isEarlyBird,
    }, null, 2));
    if (r.competitionId) {
      const c = await db.collection('competitions').doc(r.competitionId).get();
      if (c.exists) {
        const cd = c.data();
        console.log('competition fields:', Object.keys(cd));
        console.log('fees:', JSON.stringify(cd.fees, null, 2));
        console.log('eventDate:', cd.eventDate, 'regStart:', cd.regStart, 'regEnd:', cd.regEnd);
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
