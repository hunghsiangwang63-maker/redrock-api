require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { initFirebase } = require('./config/firebase');

// ── 初始化 Firebase ───────────────────────────────────────────────
initFirebase();

const app = express();

// ── Middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174',
    'https://app.redrocktaiwan.com', 'https://staff.redrocktaiwan.com',
    'https://redrock-member.web.app', 'https://redrock-staff.web.app',
    'https://redrock-web-three.vercel.app', 'https://redrock-dev-a35c1.web.app', 'https://redrock-dev-a35c1.firebaseapp.com',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' })); // 需要較大限制以支援 base64 簽名圖
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Routes ────────────────────────────────────────────────────────
app.use('/auth',         require('./routes/auth'));
app.use('/members',      require('./routes/members'));
app.use('/checkin',      require('./routes/checkin'));
app.use('/passes',       require('./routes/passes'));
app.use('/installments', require('./routes/installments'));
app.use('/schedule',     require('./routes/schedule'));
app.use('/competitions', require('./routes/competitions'));
app.use('/staff',        require('./routes/staff'));
app.use('/pass-adjustments', require('./routes/passAdjustments'));
app.use('/course-adjustments', require('./routes/courseAdjustments'));
app.use('/team', require('./routes/teamMembers'));
app.use('/rentals', require('./routes/rentals'));
app.use('/pending-tasks', require('./routes/pendingTasks'));
app.use('/experience-bookings', require('./routes/experienceBookings'));
app.use('/cards',        require('./routes/cards'));
app.use('/team-members', require('./routes/teamMembers'));
app.use('/gyms',         require('./routes/gyms'));
app.use('/courses',      require('./routes/courses'));
app.use('/vip',          require('./routes/vip'));
app.use('/course-categories', require('./routes/courseCategories'));
app.use('/products',      require('./routes/products'));
app.use('/settings',       require('./routes/settings'));
app.use('/stations',       require('./routes/stations'));
app.use('/transfers',      require('./routes/transfers'));
app.use('/notifications', require('./routes/notifications'));
app.use('/payments',      require('./routes/payments'));

// Phase 2 以後的路由（預留）
// app.use('/courses',   require('./routes/courses'));
// app.use('/waivers',   require('./routes/waivers'));
app.use('/revenue',      require('./routes/revenue'));
app.use('/ticket-transfers', require('./routes/ticketTransfers'));
app.use('/daily-settlements', require('./routes/dailySettlements'));
app.use('/fall-tests',   require('./routes/fallTests'));
app.use('/cancel-checkins', require('./routes/cancelCheckin'));
// app.use('/gyms',      require('./routes/gyms'));
// app.use('/staff',     require('./routes/staff'));
// app.use('/notifications', require('./routes/notifications'));
// app.use('/competitions',  require('./routes/competitions'));
// app.use('/permissions',   require('./routes/permissions'));

// ── Health Check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    version: '1.3.1-transfer-all-orders',
  });
});

// ── 404 Handler ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
});

// ── Error Handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.code || 'SERVER_ERROR',
    message: process.env.NODE_ENV === 'production' ? '伺服器發生錯誤' : err.message,
  });
});

// ── Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🏔  RedRock API Server running on port ${PORT}`);
  });
}

module.exports = app;
