process.env.GOOGLE_APPLICATION_CREDENTIALS = '/Users/wanghongxiang/Documents/RedRock/憑證/redrock-dev-a35c1-firebase-adminsdk-fbsvc-51b6aca85d.json';
const { initFirebase, getDb } = require('../src/config/firebase');
initFirebase();
(async () => {
  const db = getDb();
  const snap = await db.collection('checkIns').where('isCancelled','==',true).get();
  console.log('全庫已取消的入場紀錄共', snap.size, '筆');
  // 抽樣最近10筆看看
  const docs = snap.docs.sort((a,b) => (b.data().cancelledAt?._seconds||0) - (a.data().cancelledAt?._seconds||0)).slice(0,10);
  docs.forEach(d => {
    const c = d.data();
    console.log(d.id, '|', c.memberName, '| cancelledAt:', c.cancelledAt?._seconds ? new Date(c.cancelledAt._seconds*1000).toISOString() : c.cancelledAt, '| cancelledBy:', c.cancelledBy);
  });
})();
