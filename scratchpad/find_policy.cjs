const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const credDir = path.join(process.env.HOME, 'Documents/RedRock/憑證');
const credFile = fs.readdirSync(credDir).find(f => f.includes('firebase-adminsdk'));
admin.initializeApp({ credential: admin.credential.cert(require(path.join(credDir, credFile))) });
const db = admin.firestore();
(async () => {
  const c = await db.collection('competitions').doc('ced676c3-1361-48c5-996c-74033a04c4f8').get();
  console.log(JSON.stringify(c.data().refundPolicies, null, 2));
})();
