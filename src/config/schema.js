/**
 * 紅石攀岩館 Firestore Schema
 */

const gymSchema = {
  id: 'string',
  name: 'string',
  shortName: 'string',
  address: 'string',
  phone: 'string',
  status: 'active|inactive',
  paymentSettings: {
    ecpayMerchantId: 'string',
    ecpayHashKey: 'string',
    ecpayHashIv: 'string',
    bankName: 'string',
    bankCode: 'string',
    bankAccount: 'string',
    bankAccountName: 'string',
    jkoPayEnabled: 'boolean',
    linePayChannelId: 'string',
    linePayChannelSecret: 'string',
    paymentDeadlineHours: 'number',
    refundRules: {
      fullRefundDays: 'number',
      partialRefundDays: 'number',
      partialRefundPct: 'number',
      noRefundDays: 'number',
    },
  },
  createdAt: 'Timestamp',
  updatedAt: 'Timestamp',
};

const memberSchema = {
  id: 'string',
  name: 'string',
  phone: 'string',
  email: 'string',
  birthday: 'string',           // YYYY-MM-DD
  gender: 'male|female|other',
  emergencyContact: {
    name: 'string',
    phone: 'string',
    relation: 'string',
  },
  qrCode: 'string',
  qrCodeId: 'string',

  // 身份別（系統自動 + 人工審核）
  memberType: 'general|child|student|vip',
  // child: 未滿13歲（生日自動判斷）
  // student: 13~22歲（生日自動判斷）；超過22歲需人工審核學生證
  studentVerified: 'boolean',       // 超過22歲學生證已審核
  studentVerifiedBy: 'string',      // staffId
  studentVerifiedAt: 'Timestamp',
  studentIdImageUrl: 'string',      // 學生證照片（Storage URL）

  isMinor: 'boolean',               // < 18歲（家長waiver用）
  isChildAccount: 'boolean',
  parentMemberId: 'string',

  registeredBy: 'self|staff|migration',
  emailVerified: 'boolean',
  emailVerifyToken: 'string',
  emailVerifyExpiry: 'Timestamp',

  isBlocked: 'boolean',
  blockReasons: 'string[]',

  migratedFrom: 'string',
  legacyBarcode: 'string',
  notes: 'string',
  createdAt: 'Timestamp',
  updatedAt: 'Timestamp',
};

const waiverSchema = {
  memberId: 'string',
  memberName: 'string',
  memberSignatureUrl: 'string',
  memberSignedAt: 'Timestamp',
  memberSignedIp: 'string',
  memberSignedBy: 'string',
  parentRequired: 'boolean',
  parentName: 'string',
  parentEmail: 'string',
  parentPhone: 'string',
  parentRelation: 'string',
  parentSignatureUrl: 'string',
  parentSignedAt: 'Timestamp',
  parentSignedIp: 'string',
  parentSignToken: 'string',
  parentSignTokenExpiry: 'Timestamp',
  isComplete: 'boolean',
  source: 'new|migrated',
  lockedAt: 'Timestamp',
  createdAt: 'Timestamp',
};

const fallTestSchema = {
  id: 'string',
  memberId: 'string',
  gymId: 'string',
  result: 'pass|fail',
  testedAt: 'Timestamp',
  confirmedBy: 'string',
  notes: 'string',
  // 有效期延展紀錄
  extensionCount: 'number',         // 累計延展次數
  currentExpiresAt: 'string',       // YYYY-MM-DD 目前有效期（含所有延展）
  extensionLog: [{
    extendedAt: 'Timestamp',        // 觸發延展的入場時間
    checkInId: 'string',
    previousExpiresAt: 'string',
    newExpiresAt: 'string',
  }],
  createdAt: 'Timestamp',
};

const passTypeSchema = {
  id: 'string',
  gymId: 'string',
  name: 'string',
  scope: 'single|shared',
  targetGymId: 'string',
  price: 'number',
  durationDays: 'number|null',    // 曆日效期（未設月數時採用）
  durationMonths: 'number|null',  // 月數效期（優先；一個月一個月算，7/6→10/6）
  credits: 'number|null',
  isActive: 'boolean',
  createdAt: 'Timestamp',
  updatedAt: 'Timestamp',
};

const memberPassSchema = {
  id: 'string',
  memberId: 'string',
  gymId: 'string',
  passTypeId: 'string',
  passTypeName: 'string',
  scope: 'single|shared',
  targetGymId: 'string',
  startDate: 'string',
  endDate: 'string',
  credits: 'number|null',
  originalCredits: 'number|null',
  status: 'active|expired|cancelled',
  paymentId: 'string',
  soldByStaffId: 'string',
  notes: 'string',
  createdAt: 'Timestamp',
  updatedAt: 'Timestamp',
};

const checkInSchema = {
  id: 'string',
  memberId: 'string',
  memberName: 'string',
  gymId: 'string',
  entryType: 'pass|course_access|discount_card|black_card|single_entry_ticket|single_ticket|vip|staff_override',
  passId: 'string|null',
  courseEnrollmentId: 'string|null',
  discountCardId: 'string|null',
  blackCardId: 'string|null',
  singleEntryTicketId: 'string|null',
  transactionId: 'string|null',
  qrToken: 'string|null',           // 對應 pendingCheckIn
  // 付費資訊快照
  amountPaid: 'number',
  paymentMethod: 'string|null',
  isTeamDiscount: 'boolean',
  // 岩鞋
  rentShoes: 'boolean',
  shoesPrice: 'number',
  // 取消機制
  cancelledAt: 'Timestamp|null',
  cancelledBy: 'string|null',
  isCancelled: 'boolean',
  checkedInAt: 'Timestamp',
  checkedInBy: 'string',
  notes: 'string',
  createdAt: 'Timestamp',
};

const staffSchema = {
  id: 'string',
  gymId: 'string',
  name: 'string',
  email: 'string',
  phone: 'string',
  role: 'super_admin|gym_manager|full_time|part_time',
  isActive: 'boolean',
  lastLoginAt: 'Timestamp',
  createdAt: 'Timestamp',
  updatedAt: 'Timestamp',
};

const transactionSchema = {
  id: 'string',
  receiptNo: 'string',
  gymId: 'string',
  memberId: 'string|null',
  staffId: 'string',
  type: 'pass|checkin|course|product|competition|single_entry_ticket',
  referenceId: 'string',
  items: [{
    productId: 'string',
    productName: 'string',
    quantity: 'number',
    unitPrice: 'number',
    subtotal: 'number',
  }],
  totalAmount: 'number',
  paymentMethod: 'cash|linepay|jkopay|taiwanpay|ecpay_atm',
  paymentStatus: 'pending|completed|failed|refunded',
  ecpayTradeNo: 'string',
  paidAt: 'Timestamp',
  confirmedBy: 'string',
  createdAt: 'Timestamp',
  updatedAt: 'Timestamp',
};

// ── VIP 永久免費入場名單 ─────────────────────────────────────────
const vipSchema = {
  id: 'string',
  memberId: 'string',
  memberName: 'string',          // 快照
  note: 'string',                // 備註
  createdBy: 'string',           // super_admin staffId
  createdAt: 'Timestamp',
  updatedAt: 'Timestamp',
};

// ── 單次入場券 ──────────────────────────────────────────────────
const singleEntryTicketSchema = {
  id: 'string',
  memberId: 'string',            // 目前持有人
  originalMemberId: 'string',    // 原始購買人
  gymId: 'string',               // 販售場館
  issuedAt: 'string',            // YYYY-MM-DD 發放日
  expiresAt: 'string',           // YYYY-MM-DD 到期日（發放+1年，轉移繼承）
  status: 'active|used|expired|cancelled',
  transferHistory: [{
    fromMemberId: 'string',
    toMemberId: 'string',
    transferredAt: 'Timestamp',
  }],
  usedAt: 'Timestamp|null',
  usedCheckInId: 'string|null',
  soldByStaffId: 'string',
  paymentId: 'string|null',
  notes: 'string',
  createdAt: 'Timestamp',
  updatedAt: 'Timestamp',
};

// ── 待確認入場（會員端 QR code → 櫃檯掃描確認）────────────────
const pendingCheckInSchema = {
  qrToken: 'string',             // UUID，QR code 內容
  memberId: 'string',
  gymId: 'string',
  entryType: 'pass|course_access|discount_card|black_card|single_entry_ticket|single_ticket|vip',
  passId: 'string|null',
  discountCardId: 'string|null',
  blackCardId: 'string|null',
  singleEntryTicketId: 'string|null',
  paymentMethod: 'cash|linepay|jkopay|taiwanpay|null',
  amount: 'number',
  originalAmount: 'number',
  isTeamDiscount: 'boolean',
  rentShoes: 'boolean',
  shoesPrice: 'number',
  status: 'pending|confirmed|cancelled',
  createdAt: 'Timestamp',
  expiresAt: 'Timestamp',        // 產生後30分鐘失效
  confirmedAt: 'Timestamp|null',
  confirmedBy: 'string|null',
  cancelledAt: 'Timestamp|null',
  cancelledBy: 'string|null',
  checkInId: 'string|null',
};

module.exports = {
  gymSchema,
  memberSchema,
  waiverSchema,
  fallTestSchema,
  passTypeSchema,
  memberPassSchema,
  checkInSchema,
  staffSchema,
  transactionSchema,
  vipSchema,
  singleEntryTicketSchema,
  pendingCheckInSchema,
};
