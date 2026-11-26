const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { RAW_COLUMNS_16_11 } = require('./seedData');
const {
  parseAndValidateRow,
  parseFreeTextMessage,
  evaluateNumberRestriction,
  aggregateSlips,
  checkDrawWinners,
  getUpcomingGloDraws
} = require('./lotteryEngine');
const { analyzeSlipImage, detectPaperMeshWithGemini, applyLearnedCorrectionsToRow } = require('./geminiOcr');

function normalizeColumnSubtotals(raw) {
  if (!Array.isArray(raw)) return [];
  const byCol = new Map();
  for (const entry of raw) {
    const col = Math.max(1, Number(entry?.col) || 1);
    const writtenTotal = Number(entry?.writtenTotal);
    if (Number.isFinite(writtenTotal) && writtenTotal > 0) {
      byCol.set(col, Math.round(writtenTotal));
    }
  }
  return Array.from(byCol.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([col, writtenTotal]) => ({ col, writtenTotal }));
}

function computeColumnSubtotalChecks(slip) {
  const calcByCol = new Map();
  for (const it of slip?.items || []) {
    const col = Math.max(1, Number(it.col) || 1);
    calcByCol.set(col, (calcByCol.get(col) || 0) + (Number(it.rowTotalMoney) || 0));
  }
  const checks = [];
  for (const entry of normalizeColumnSubtotals(slip?.columnSubtotals || [])) {
    const calculatedTotal = calcByCol.get(entry.col) || 0;
    const diff = calculatedTotal - entry.writtenTotal;
    checks.push({
      col: entry.col,
      writtenTotal: entry.writtenTotal,
      calculatedTotal,
      diff,
      isMatch: diff === 0
    });
  }
  return {
    checks,
    mismatches: checks.filter(c => !c.isMatch)
  };
}

const PORT = process.env.PORT || 3088;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_SECRET_FILE = path.join(DATA_DIR, '.session_secret');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function getSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const existing = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SESSION_SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.createHash('sha256').update(__dirname + '-lotto-ocr').digest('hex');
  }
}

const SESSION_SECRET = getSessionSecret();

function hashPassword(plain) {
  const pw = String(plain || '');
  if (pw.startsWith('scrypt:')) return pw;
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  const pw = String(plain || '');
  if (String(stored).startsWith('scrypt:')) {
    const parts = String(stored).split(':');
    if (parts.length !== 3) return false;
    const [, salt, hexHash] = parts;
    const expected = Buffer.from(hexHash, 'hex');
    const actual = crypto.scryptSync(pw, salt, 32);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  const a = Buffer.from(pw, 'utf8');
  const b = Buffer.from(String(stored), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function resolvePublicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role === 'admin' ? 'admin' : 'staff',
    avatarUrl: u.avatarUrl || '',
    phone: u.phone || '',
    note: u.note || ''
  };
}

function sanitizeUsers(users = []) {
  return (users || []).map(resolvePublicUser);
}

function saveAvatarDataUrl(userId, dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) {
    throw new Error('ไฟล์รูปโปรไฟล์ไม่ถูกต้อง (รองรับ JPG, PNG, WebP, GIF)');
  }
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 2 * 1024 * 1024) {
    throw new Error('รูปโปรไฟล์ต้องมีขนาดไม่เกิน 2 MB');
  }
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const safeId = String(userId || 'usr').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'usr';
  const fileName = `avatar-${safeId}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buf);
  return `/uploads/${fileName}`;
}

function deleteAvatarFileIfLocal(avatarUrl) {
  if (typeof avatarUrl !== 'string' || !avatarUrl.startsWith('/uploads/avatar-')) return;
  try {
    const resolved = path.resolve(PUBLIC_DIR, avatarUrl.replace(/^\/+/, ''));
    if (resolved.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }
  } catch {}
}

function getFreshSessionUser(req, db = null) {
  const parsed = getSessionUser(req);
  if (!parsed) return null;
  try {
    const data = db || loadDb();
    const found = (data.users || []).find(
      u => u.id === parsed.id || u.username.toLowerCase() === String(parsed.username || '').toLowerCase()
    );
    if (found) {
      return { ...resolvePublicUser(found), exp: parsed.exp };
    }
  } catch {}
  return parsed;
}

function sanitizeSettings(s = {}) {
  const geminiKey = String(s.geminiApiKey || '').trim();
  const envGeminiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const effectiveGeminiKey = geminiKey || envGeminiKey;
  const lineToken = String(s.lineChannelAccessToken || '').trim();
  const lineSecret = String(s.lineChannelSecret || '').trim();

  return {
    ocrPriorityMode: s.ocrPriorityMode || 'auto_hybrid',
    geminiModel: s.geminiModel || 'gemini-2.5-pro',
    permutationMode: s.permutationMode || 'expand',
    useColumnSlicing: Boolean(s.useColumnSlicing),
    checkMultiplesOf11: s.checkMultiplesOf11 !== false,
    drawCutoffTime: s.drawCutoffTime || '14:30',
    nextDrawOpenTime: s.nextDrawOpenTime || '17:00',
    afterCutoffAction: s.afterCutoffAction || 'reject_until_open',
    payoutRates: s.payoutRates || { threeStraight: 500, threeToad: 100, twoTop: 70, twoBottom: 70 },
    riskLimits: s.riskLimits || { threeStraight: 100, threeToad: 100, threePerm: 132, twoTop: 30, twoBottom: 100 },
    hasGeminiApiKey: Boolean(effectiveGeminiKey),
    geminiApiKeyMasked: effectiveGeminiKey
      ? `${effectiveGeminiKey.slice(0, 6)}••••••${effectiveGeminiKey.slice(-4)}`
      : '',
    hasLineToken: Boolean(lineToken),
    hasLineSecret: Boolean(lineSecret)
  };
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const map = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    map[k] = v;
  }
  return map;
}

function createSessionToken(user) {
  const payloadObj = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role === 'admin' ? 'admin' : 'staff',
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function getSessionUser(req) {
  try {
    const cookies = parseCookies(req);
    const token = cookies.lotto_session;
    if (!token || !token.includes('.')) return null;
    const [payloadB64, sig] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
    const a = Buffer.from(sig || '', 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!parsed || !parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim();
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isLoginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (now >= entry.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  for (const [k, v] of loginAttempts.entries()) {
    if (now >= v.resetAt) loginAttempts.delete(k);
  }
  const existing = loginAttempts.get(ip);
  if (!existing || now >= existing.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    existing.count += 1;
  }
}

function isDirectLoopback(req) {
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip']) return false;
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAuthorizedAntigravityReq(req) {
  if (getSessionUser(req)) return true;
  const agKey = process.env.ANTIGRAVITY_KEY || SESSION_SECRET;
  if (req.headers['x-antigravity-key'] && req.headers['x-antigravity-key'] === agKey) return true;
  if (isDirectLoopback(req)) return true;
  return false;
}

function requireAdmin(req, res) {
  const u = getSessionUser(req);
  if (!u || u.role !== 'admin') {
    sendJson(res, 403, {
      ok: false,
      error: 'เฉพาะบัญชีเจ้าของระบบ (Admin) เท่านั้นที่ทำรายการนี้ได้'
    });
    return false;
  }
  return true;
}

function safeIsoDate(val) {
  if (!val) return new Date().toISOString();
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function resolveLineDisplayName(ev, token) {
  const userId = ev?.source?.userId || '';
  const sourceType = ev?.source?.type || 'user';
  const groupId = ev?.source?.groupId || '';
  const roomId = ev?.source?.roomId || '';
  const fallback = `เด็กโพย LINE (${(userId || 'USER').slice(-6)})`;
  if (!token || !userId) return fallback;

  let profileUrl = `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`;
  if (sourceType === 'group' && groupId) {
    profileUrl = `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`;
  } else if (sourceType === 'room' && roomId) {
    profileUrl = `https://api.line.me/v2/bot/room/${encodeURIComponent(roomId)}/member/${encodeURIComponent(userId)}`;
  }

  try {
    const res = await fetch(profileUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const profile = await res.json();
      if (profile && typeof profile.displayName === 'string' && profile.displayName.trim()) {
        return profile.displayName.trim();
      }
    }
  } catch {}
  return fallback;
}

// Dual-Mode Hybrid OCR Priority State (Antigravity Agent Online Priority + Gemini API Key Offline Fallback)
let antigravityLastSeenAt = 0;
let antigravityPendingJobs = new Map();

function isAntigravityOnline() {
  return Boolean(antigravityLastSeenAt && Date.now() - antigravityLastSeenAt < 420_000);
}

function appendAuditLog(db, actorName, actionType, detail) {
  db.auditLogs = db.auditLogs || [];
  db.auditLogs.unshift({
    id: `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    actorName: actorName || 'เฮียเจ้าของระบบ (Admin)',
    actionType,
    detail,
    timestamp: new Date().toISOString()
  });
  if (db.auditLogs.length > 300) {
    db.auditLogs = db.auditLogs.slice(0, 300);
  }
}

function getActorFromReq(req, body = {}) {
  const sessionUser = getSessionUser(req);
  if (sessionUser?.displayName) return sessionUser.displayName;
  let headerActor = '';
  if (req.headers['x-actor-name']) {
    try {
      headerActor = decodeURIComponent(req.headers['x-actor-name']);
    } catch {
      headerActor = String(req.headers['x-actor-name']);
    }
  }
  return body.actorName || headerActor || 'เฮียเจ้าของระบบ (Admin)';
}

function getNextRoundForCustomer(slips, drawId, customerName) {
  const existing = (slips || []).filter(
    s => (s.drawId || 'DRAW-2026-11-16') === drawId && s.customerName === customerName
  );
  return existing.length + 1;
}

/**
 * Evaluates submission timestamp against the admin's configured Draw Cutoff Time (`settings.drawCutoffTime`, e.g. "14:30")
 * and Next Draw Open Time (`settings.nextDrawOpenTime`, e.g. "17:00") in Thai Time (UTC+7).
 */
function resolveTargetDrawForSubmission(db, submittedAtIso, explicitDrawId = '', allowAutoRollover = false) {
  let targetDraw =
    db.draws.find(d => d.id === (explicitDrawId || db.currentDrawId)) || db.draws[0];

  if (!allowAutoRollover || !targetDraw?.drawDate) {
    return { draw: targetDraw, rolledOver: false, rejectedClosed: false };
  }

  const cutoffTimeStr = db.settings?.drawCutoffTime || '14:30';
  const nextOpenTimeStr = db.settings?.nextDrawOpenTime || '17:00';
  const afterCutoffAction = db.settings?.afterCutoffAction || 'reject_until_open';

  // Parse ICT (+07:00) timestamps on the draw day
  const drawCutoffMs = new Date(`${targetDraw.drawDate}T${cutoffTimeStr}:00+07:00`).getTime();
  const nextOpenMs = new Date(`${targetDraw.drawDate}T${nextOpenTimeStr}:00+07:00`).getTime();
  const submitMs = new Date(submittedAtIso || Date.now()).getTime();

  // If submitted between Cutoff Time (e.g. 14:30) and Next Draw Open Time (e.g. 17:00) on draw day:
  if (afterCutoffAction === 'reject_until_open' && submitMs > drawCutoffMs && submitMs < nextOpenMs) {
    return {
      draw: targetDraw,
      rolledOver: false,
      rejectedClosed: true,
      rejectMessage: `⛔ ปิดรับโพย ${targetDraw.title} แล้วครับ (ปิดรับเวลา ${cutoffTimeStr} น. และจะเปิดรับงวดถัดไปเวลา ${nextOpenTimeStr} น.)`
    };
  }

  if (submitMs > drawCutoffMs) {
    const upcomingList = getUpcomingGloDraws(db.draws, 6);
    const nextCandidate = upcomingList.find(
      u => new Date(`${u.drawDate}T${cutoffTimeStr}:00+07:00`).getTime() > submitMs
    ) || upcomingList[0];

    if (nextCandidate) {
      let existingNext = db.draws.find(d => d.drawDate === nextCandidate.drawDate);
      if (!existingNext) {
        existingNext = {
          id: `DRAW-${nextCandidate.drawDate}`,
          title: nextCandidate.title,
          drawDate: nextCandidate.drawDate,
          status: 'open',
          restrictedNumbers: []
        };
        db.draws.unshift(existingNext);
      }
      db.currentDrawId = existingNext.id;
      return {
        draw: existingNext,
        rolledOver: true,
        rejectedClosed: false,
        previousDrawTitle: targetDraw.title
      };
    }
  }

  return { draw: targetDraw, rolledOver: false, rejectedClosed: false };
}

function buildInitialDb() {
  const defaultSettings = {
    ocrPriorityMode: 'auto_hybrid', // 'auto_hybrid' | 'antigravity_only' | 'api_only'
    geminiModel: 'gemini-2.5-pro',
    geminiApiKey: '',
    permutationMode: 'expand',
    useColumnSlicing: false,
    checkMultiplesOf11: true,
    drawCutoffTime: '14:30',        // เวลาปิดรับโพยในวันหวยออก (เช่น 14:30 น.)
    nextDrawOpenTime: '17:00',      // เวลาเริ่มตัดเข้าเป็นงวดถัดไปอัตโนมัติ (เช่น หลัง 17:00 น. ของวันหวยออก)
    afterCutoffAction: 'reject_until_open', // 'reject_until_open' = ปิดรับช่วงหวยออก แล้วเปิดรับงวดใหม่ตามเวลา, 'auto_next_draw' = ปัดเข้างวดหน้าทันที
    riskLimits: {
      threeStraight: 100,
      threeToad: 100,
      threePerm: 132,
      twoTop: 30,
      twoBottom: 100
    },
    lineChannelAccessToken: '',
    lineChannelSecret: ''
  };

  // เวลาอ้างอิงเพื่อแสดงตัวอย่างเด็กโพย 1 คนส่งหลายรอบ (ทั้งรอบที่ส่งก่อนอั้น ได้ 100% และรอบที่ส่งหลังอั้น ได้ 50%)
  const tMuayRound1 = '2026-11-14T10:15:00.000Z'; // 14 พ.ย. 17:15 น. (ก่อนอั้น)
  const tMuayRound2 = '2026-11-15T03:30:00.000Z'; // 15 พ.ย. 10:30 น. (ก่อนอั้น)
  const tPongRound1 = '2026-11-14T15:30:00.000Z'; // 14 พ.ย. 22:30 น. (ก่อนอั้น)
  const tDealerCutoff = '2026-11-15T07:00:00.000Z'; // เจ้ามือประกาศอั้น 15 พ.ย. 14:00 น. (ก่อนหวยออก 1 วัน)
  const tPongRound2 = '2026-11-15T08:10:00.000Z'; // 15 พ.ย. 15:10 น. (หลังอั้น)
  const tMuayRound3 = '2026-11-15T09:20:00.000Z'; // 15 พ.ย. 16:20 น. (หลังอั้น)
  const tNidRound1  = '2026-11-15T09:45:00.000Z'; // 15 พ.ย. 16:45 น. (หลังอั้น)

  const draws = [
    {
      id: 'DRAW-2026-11-16',
      title: 'งวดวันที่ 16 พ.ย. 2569',
      drawDate: '2026-11-16',
      status: 'open',
      restrictedNumbers: [
        { number: '21', payoutPercent: 50, announcedAt: tDealerCutoff, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' },
        { number: '583', payoutPercent: 50, announcedAt: tDealerCutoff, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' },
        { number: '154', payoutPercent: 50, announcedAt: tDealerCutoff, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' },
        { number: '072', payoutPercent: 50, announcedAt: tDealerCutoff, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' },
        { number: '860', payoutPercent: 50, announcedAt: tDealerCutoff, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' }
      ]
    },
    {
      id: 'DRAW-2026-12-01',
      title: 'งวดวันที่ 1 ธ.ค. 2569 (งวดหน้า)',
      drawDate: '2026-12-01',
      status: 'open',
      restrictedNumbers: []
    }
  ];

  // เจ๊หมวย รอบที่ 1: โพยกระดาษ 16/11 แผ่นที่ 1 (120 รายการ) ส่งก่อนอั้น
  const muayR1Items = [];
  for (const colNum of [1, 2, 3, 4]) {
    for (const r of RAW_COLUMNS_16_11[colNum]) {
      muayR1Items.push(
        parseAndValidateRow(
          {
            col: colNum,
            row: r.row,
            numText: r.numText,
            amtText: r.amtText,
            note: r.note || '',
            needsReview: Boolean(r.needsReview),
            confidence: r.needsReview ? 0.86 : 0.99
          },
          defaultSettings
        )
      );
    }
  }
  const muayR1Total = muayR1Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  // เจ๊หมวย รอบที่ 2: ส่งเพิ่มช่วงเช้า 15 พ.ย. 10:30 น. (ก่อนอั้น -> ได้ 100%)
  const muayR2Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '583', amtText: '22×22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 2, numText: '317', amtText: '22', confidence: 0.99 }, defaultSettings)
  ];
  const muayR2Total = muayR2Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  // เจ๊หมวย รอบที่ 3: ส่งเพิ่มช่วงบ่าย 15 พ.ย. 16:20 น. (หลังเจ้ามือประกาศอั้น -> เลข 154 ได้ 50%, เลข 426 ได้ 100%)
  const muayR3Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '154', amtText: '22×22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 2, numText: '426', amtText: '22', confidence: 0.99 }, defaultSettings)
  ];
  const muayR3Total = muayR3Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  // เฮียพงษ์ รอบที่ 1: ส่งวันที่ 14 พ.ย. (ก่อนอั้น -> เลข 21 = 22 บาท ได้ 100%)
  const pongR1Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '21', amtText: '22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 2, numText: '583', amtText: '55×55', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 3, numText: '072', amtText: '33', confidence: 0.99 }, defaultSettings)
  ];
  const pongR1Total = pongR1Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  // เฮียพงษ์ รอบที่ 2: ส่งวันที่ 15 พ.ย. 15:10 น. (หลังอั้น -> เลข 154 = 22×22 ติดอั้นได้ 50%)
  const pongR2Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '154', amtText: '22×22', confidence: 0.99 }, defaultSettings)
  ];
  const pongR2Total = pongR2Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  // ป้านิด รอบที่ 1: ส่งวันที่ 15 พ.ย. 16:45 น. (หลังอั้น -> เลข 21 = 20 บาท ได้ 50%, เลข 860 ได้ 50%)
  const nidR1Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '21', amtText: '20', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 2, numText: '860', amtText: '22×22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 3, numText: '289', amtText: '22×11', confidence: 0.99 }, defaultSettings)
  ];
  const nidR1Total = nidR1Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  return {
    currentDrawId: 'DRAW-2026-11-16',
    draws,
    settings: defaultSettings,
    users: [
      {
        id: 'USR-1',
        username: 'admin',
        password: hashPassword('1234'),
        displayName: 'เฮียเจ้าของระบบ (Admin)',
        role: 'admin'
      },
      {
        id: 'USR-2',
        username: 'staff1',
        password: hashPassword('1234'),
        displayName: 'แอดมินเมย์ (ฝ่ายตรวจโพย)',
        role: 'staff'
      },
      {
        id: 'USR-3',
        username: 'staff2',
        password: hashPassword('1234'),
        displayName: 'แอดมินบอย (ฝ่ายตัดยอด)',
        role: 'staff'
      }
    ],
    auditLogs: [
      {
        id: 'LOG-INIT-1',
        actorName: 'เฮียเจ้าของระบบ (Admin)',
        actionType: 'เปิดงวดหวย',
        detail: 'เปิดรับโพย งวดวันที่ 16 พ.ย. 2569',
        timestamp: tMuayRound1
      },
      {
        id: 'LOG-INIT-2',
        actorName: 'แอดมินเมย์ (ฝ่ายตรวจโพย)',
        actionType: 'นำเข้าโพยกระดาษ OCR',
        detail: 'รับโพย เจ๊หมวย (สาย A) รอบที่ 1 จำนวน 120 รายการ (ยอด 9,394 บาท)',
        timestamp: tMuayRound1
      },
      {
        id: 'LOG-INIT-3',
        actorName: 'เฮียเจ้าของระบบ (Admin)',
        actionType: 'ตั้งค่าเลขอั้น 50%',
        detail: 'ประกาศเลขอั้น 5 ชุด (21, 583, 154, 072, 860) จ่าย 50% สำหรับบิลหลังเวลา 14:00 น.',
        timestamp: tDealerCutoff
      },
      {
        id: 'LOG-INIT-4',
        actorName: 'แอดมินบอย (ฝ่ายตัดยอด)',
        actionType: 'ตัดยอดส่งเจ้ามือ',
        detail: 'ยืนยันส่งเจ้ามือสายใหญ่ #1 (รอบที่ 1) ยอดส่ง 494 บาท | เก็บไว้ที่เรา 320 บาท',
        timestamp: '2026-11-14T16:00:00.000Z'
      }
    ],
    learnedRules: [
      {
        id: 'LEARN-1',
        customerName: 'เจ๊หมวย (สาย A)',
        roundNumber: 1,
        field: 'amtText',
        wrongText: 'n×n',
        correctText: '11×11',
        reason: 'เขียนเลข 1 สองตัวติดกันเร็วๆ จนเส้นเชื่อมคล้ายตัว n (คอลัมน์ 2 แถว 25-30)',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-2',
        customerName: 'เจ๊หมวย (สาย A)',
        roundNumber: 1,
        field: 'amtText',
        wrongText: 'no×no',
        correctText: '110×110',
        reason: 'เขียนเลข 110 เร็วๆ จนดูคล้ายคำว่า no (คอลัมน์ 4 แถว 19-26)',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-3',
        customerName: 'เจ๊หมวย (สาย A)',
        roundNumber: 1,
        field: 'amtText',
        wrongText: '22×n',
        correctText: '22×11',
        reason: 'โต๊ด 11 บาทเขียนเหมือนตัว n (คอลัมน์ 3 แถว 23-25)',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-4',
        customerName: 'เจ๊หมวย (สาย A)',
        roundNumber: 1,
        field: 'amtText',
        wrongText: '55×no',
        correctText: '55×110',
        reason: 'ตรง 55 โต๊ด 110 เขียนตัวหลังคล้าย no (คอลัมน์ 3 แถว 28-30)',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-5',
        customerName: 'เจ๊หมวย (สาย A)',
        roundNumber: 1,
        field: 'numText',
        wrongText: 'n3×3',
        correctText: '113×3',
        reason: 'เลขเบิ้ล 113 เขียน 11 ติดกันคล้าย n3 (คอลัมน์ 4 แถว 14)',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-GLOBAL-1',
        customerName: 'ทุกสาย (Global)',
        roundNumber: 1,
        field: 'numText',
        wrongText: 'A9 / 9A / 2A×2A / A8×2A',
        correctText: '49 / 94 / 24×24 / 48×24',
        reason: 'เลข 4 เขียนหัวแหลมปิดคล้ายตัว A หรือสามเหลี่ยม Δ เช่น 2A=24, A8=48, 2AA×3=244×3',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-GLOBAL-2',
        customerName: 'ทุกสาย (Global)',
        roundNumber: 1,
        field: 'amtText',
        wrongText: '33+30 / 55+50 / 22+20',
        correctText: '33×30 / 55×50 / 22×20',
        reason: 'เครื่องหมาย × เขียนลากเร็วคล้ายเครื่องหมาย + ในโพยสมุดเส้น เช่น 33×30, 55×50',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-GLOBAL-3',
        customerName: 'ทุกสาย (Global)',
        roundNumber: 1,
        field: 'amtText',
        wrongText: '×3=264 / ×3=99 / ×6=132',
        correctText: 'ชุดกลับ ×3 หรือ ×6 พร้อมยอดรวมหลังเครื่องหมาย =',
        reason: 'เขียน ×3=ยอดรวม หรือ ×6=ยอดรวม คั่นกลางเส้นแบ่งช่อง เช่น 144×3 = 264',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-GLOBAL-4',
        customerName: 'ทุกสาย (Global)',
        roundNumber: 1,
        field: 'amtText',
        wrongText: 'ปีกกา } หรือเส้นลากยาว |',
        correctText: 'คัดลอกยอดเงินให้ทุกแถวในปีกกา',
        reason: 'ลากเส้นแนวตั้ง | หรือวงเล็บปีกกา } คลุมหลายเลขเพื่อใช้ยอดเงินเดียวกัน',
        learnedAt: tMuayRound1
      },
      {
        id: 'LEARN-GLOBAL-5',
        customerName: 'ทุกสาย (Global)',
        roundNumber: 1,
        field: 'numText',
        wrongText: 'คอลัมน์ "โต๊ด ห.ท.1" / "ล.บ" / "2 ล่าง"',
        correctText: 'แยกประเภทตามหัวตารางอัตโนมัติ',
        reason: 'รองรับกระดาษโพย 2, 4, 5 และ 8 คอลัมน์ พร้อมจำแนกหัวตาราง ห.ท., โต๊ด, ล.บ, 2 ล่าง',
        learnedAt: tMuayRound1
      }
    ],
    slips: [
      {
        id: 'SLIP-1611-001',
        drawId: 'DRAW-2026-11-16',
        roundNumber: 1,
        title: 'รอบที่ 1 — โพยกระดาษ แผ่นที่ 1 (120 แถว)',
        sheetDate: '16/11',
        sheetPage: '1',
        customerName: 'เจ๊หมวย (สาย A)',
        customerLineId: 'U_muay_line_01',
        source: 'LINE รูปโพยกระดาษ',
        imageUrl: '/uploads/slip-16-11-page1.jpg',
        isGrid4x30: true,
        status: 'needs_review',
        humanApproved: false,
        approvedBy: null,
        approvedAt: null,
        modelUsed: 'gemini-2.5-pro',
        totalItems: muayR1Items.filter(i => !i.isEmpty).length,
        totalMoney: muayR1Total,
        reviewCount: muayR1Items.filter(i => i.needsReview).length,
        createdAt: tMuayRound1,
        items: muayR1Items
      },
      {
        id: 'SLIP-1611-002',
        drawId: 'DRAW-2026-11-16',
        roundNumber: 2,
        title: 'รอบที่ 2 — ส่งเพิ่มช่วงเช้า (ก่อนอั้น)',
        sheetDate: '16/11',
        sheetPage: '2',
        customerName: 'เจ๊หมวย (สาย A)',
        customerLineId: 'U_muay_line_01',
        source: 'LINE ข้อความ',
        imageUrl: '',
        isGrid4x30: false,
        status: 'ai_passed',
        humanApproved: false,
        approvedBy: null,
        approvedAt: null,
        modelUsed: 'gemini-2.5-pro',
        totalItems: muayR2Items.length,
        totalMoney: muayR2Total,
        reviewCount: 0,
        createdAt: tMuayRound2,
        items: muayR2Items
      },
      {
        id: 'SLIP-1611-003',
        drawId: 'DRAW-2026-11-16',
        roundNumber: 3,
        title: 'รอบที่ 3 — ส่งโค้งสุดท้าย (หลังประกาศอั้น)',
        sheetDate: '16/11',
        sheetPage: '3',
        customerName: 'เจ๊หมวย (สาย A)',
        customerLineId: 'U_muay_line_01',
        source: 'LINE ข้อความ',
        imageUrl: '',
        isGrid4x30: false,
        status: 'ai_passed',
        humanApproved: false,
        approvedBy: null,
        approvedAt: null,
        modelUsed: 'gemini-2.5-pro',
        totalItems: muayR3Items.length,
        totalMoney: muayR3Total,
        reviewCount: 0,
        createdAt: tMuayRound3,
        items: muayR3Items
      },
      {
        id: 'SLIP-1611-004',
        drawId: 'DRAW-2026-11-16',
        roundNumber: 1,
        title: 'รอบที่ 1 — ส่งก่อนอั้น (21=22฿, 583, 072)',
        sheetDate: '16/11',
        sheetPage: '1',
        customerName: 'เฮียพงษ์ (ลูกค้า LINE)',
        customerLineId: 'U_pong_line_02',
        source: 'LINE ข้อความ',
        imageUrl: '',
        isGrid4x30: false,
        status: 'ai_passed',
        humanApproved: false,
        approvedBy: null,
        approvedAt: null,
        modelUsed: 'gemini-2.5-pro',
        totalItems: pongR1Items.length,
        totalMoney: pongR1Total,
        reviewCount: 0,
        createdAt: tPongRound1,
        items: pongR1Items
      },
      {
        id: 'SLIP-1611-005',
        drawId: 'DRAW-2026-11-16',
        roundNumber: 2,
        title: 'รอบที่ 2 — ส่งเพิ่มหลังประกาศอั้น (154=22×22)',
        sheetDate: '16/11',
        sheetPage: '2',
        customerName: 'เฮียพงษ์ (ลูกค้า LINE)',
        customerLineId: 'U_pong_line_02',
        source: 'LINE ข้อความ',
        imageUrl: '',
        isGrid4x30: false,
        status: 'ai_passed',
        humanApproved: false,
        approvedBy: null,
        approvedAt: null,
        modelUsed: 'gemini-2.5-pro',
        totalItems: pongR2Items.length,
        totalMoney: pongR2Total,
        reviewCount: 0,
        createdAt: tPongRound2,
        items: pongR2Items
      },
      {
        id: 'SLIP-1611-006',
        drawId: 'DRAW-2026-11-16',
        roundNumber: 1,
        title: 'รอบที่ 1 — ส่งหลังประกาศอั้น (21=20฿, 860, 289)',
        sheetDate: '16/11',
        sheetPage: '1',
        customerName: 'ป้านิด (ลูกค้า LINE)',
        customerLineId: 'U_nid_line_03',
        source: 'LINE ข้อความ',
        imageUrl: '',
        isGrid4x30: false,
        status: 'ai_passed',
        humanApproved: false,
        approvedBy: null,
        approvedAt: null,
        modelUsed: 'gemini-2.5-pro',
        totalItems: nidR1Items.length,
        totalMoney: nidR1Total,
        reviewCount: 0,
        createdAt: tNidRound1,
        items: nidR1Items
      }
    ],
    layoffs: [
      {
        id: 'LAYOFF-ROUND-1',
        drawId: 'DRAW-2026-11-16',
        roundNumber: 1,
        dealerName: 'เจ้ามือสายใหญ่ #1',
        itemCount: 3,
        sentItemCount: 3,
        keptItemCount: 1,
        totalLayoffMoney: 494,
        totalKeptMoney: 100,
        formattedText:
          '📋 ใบตัดยอดส่ง: เจ้ามือสายใหญ่ #1 (รอบที่ 1)\n' +
          '📅 งวดวันที่ 16 พ.ย. 2569\n' +
          '-------------------------\n' +
          '583 = 252 บ. (3 ตัวบน+โต๊ด)\n' +
          '287 = 220 บ. (110×110)\n' +
          '21 = 22 บ. (2 ตัวบน)\n' +
          '-------------------------\n' +
          'รวมส่งเจ้ามือรอบที่ 1 = 494 บาท',
        items: [
          { number: '583', sendTotal: 252, keepTotal: 100, typeDesc: '3 ตัวบน+โต๊ด' },
          { number: '287', sendTotal: 220, keepTotal: 0, typeDesc: '110×110' },
          { number: '21', sendTotal: 22, keepTotal: 0, typeDesc: '2 ตัวบน' }
        ],
        createdAt: '2026-11-14T16:00:00.000Z'
      }
    ],
    lineChats: [
      {
        id: 'MSG-1',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'customer',
        type: 'image',
        imageUrl: '/uploads/slip-16-11-page1.jpg',
        text: 'ส่งโพยกระดาษงวด 16/11 รอบที่ 1 (แผ่นที่ 1) ค่ะ',
        timestamp: tMuayRound1
      },
      {
        id: 'MSG-2',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'bot',
        type: 'text',
        text: `✅ รับโพย เจ๊หมวย (สาย A) — รอบที่ 1\n🟢 ส่งก่อนเวลาประกาศอั้น: ได้เต็ม 100% ทุกเลข\n📋 จำนวน: 120 รายการ | ยอดรอบนี้: ${muayR1Total.toLocaleString()} บาท\n📊 ยอดสะสมรวมของเจ๊หมวย (1 รอบ): ${muayR1Total.toLocaleString()} บาท`,
        timestamp: tMuayRound1
      },
      {
        id: 'MSG-3',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'customer',
        type: 'text',
        text: 'ส่งเพิ่มรอบ 2 ค่ะ\n583 = 22x22\n317 = 22',
        timestamp: tMuayRound2
      },
      {
        id: 'MSG-4',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'bot',
        type: 'text',
        text: `✅ รับโพย เจ๊หมวย (สาย A) — รอบที่ 2\n🟢 ส่งก่อนเวลาประกาศอั้น: ได้เต็ม 100% ทุกเลข\n💰 ยอดรอบนี้: ${muayR2Total.toLocaleString()} บาท\n📊 ยอดสะสมรวมของเจ๊หมวย (รวม 2 รอบ): ${(muayR1Total + muayR2Total).toLocaleString()} บาท`,
        timestamp: tMuayRound2
      },
      {
        id: 'MSG-5',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'customer',
        type: 'text',
        text: 'ส่งเพิ่มรอบ 3 โค้งสุดท้ายค่ะ\n154 = 22x22\n426 = 22',
        timestamp: tMuayRound3
      },
      {
        id: 'MSG-6',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'bot',
        type: 'text',
        text: `✅ รับโพย เจ๊หมวย (สาย A) — รอบที่ 3\n• 154 = 22×22 (44฿) 🔒 [เลขอั้น จ่าย 50%]\n• 426 = 22 บาท 🟢 [จ่ายเต็ม 100%]\n💰 ยอดรอบนี้: ${muayR3Total.toLocaleString()} บาท\n📊 ยอดสะสมรวมของเจ๊หมวย (รวม 3 รอบ): ${(muayR1Total + muayR2Total + muayR3Total).toLocaleString()} บาท`,
        timestamp: tMuayRound3
      }
    ]
  };
}

function normalizeSlipVerificationStatus(slip) {
  if (slip.status === 'pending_antigravity') {
    slip.humanApproved = false;
    return slip;
  }
  const revCount = Number(slip.reviewCount) || 0;
  if (revCount > 0) {
    slip.status = 'needs_review';
    slip.humanApproved = false;
  } else if (slip.humanApproved === true) {
    slip.status = 'human_verified';
    slip.humanApproved = true;
    slip.approvedBy = slip.approvedBy || 'แอดมิน';
    slip.approvedAt = slip.approvedAt || slip.createdAt;
  } else {
    slip.status = 'ai_passed';
    slip.humanApproved = false;
    slip.approvedBy = null;
    slip.approvedAt = null;
  }
  return slip;
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = buildInitialDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(db.draws) || db.draws.length === 0) {
      const initial = buildInitialDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    db.settings = db.settings || {};
    if (!db.settings.ocrPriorityMode) {
      db.settings.ocrPriorityMode = 'auto_hybrid';
    }
    if (!antigravityLastSeenAt && db.antigravityLastSeenAt) {
      antigravityLastSeenAt = Number(db.antigravityLastSeenAt) || 0;
    }
    if (Array.isArray(db.slips)) {
      db.slips.forEach(normalizeSlipVerificationStatus);
    }
    let needsSave = false;
    if (Array.isArray(db.users)) {
      for (const u of db.users) {
        if (u.password && !String(u.password).startsWith('scrypt:')) {
          u.password = hashPassword(u.password);
          needsSave = true;
        }
      }
    }
    // Clean up any leftover actorName accidentally saved inside settings previously
    if (db.settings && 'actorName' in db.settings) {
      delete db.settings.actorName;
      needsSave = true;
    }
    // Ensure newly seeded global handwriting rules exist in db.learnedRules
    const initialRules = buildInitialDb().learnedRules || [];
    db.learnedRules = Array.isArray(db.learnedRules) ? db.learnedRules : [];
    for (const defRule of initialRules) {
      const exists = db.learnedRules.some(
        r => r.id === defRule.id || (r.wrongText === defRule.wrongText && r.customerName === defRule.customerName)
      );
      if (!exists) {
        db.learnedRules.push(defRule);
        needsSave = true;
      }
    }
    if (needsSave) {
      saveDb(db);
    }
    return db;
  } catch (e) {
    const initial = buildInitialDb();
    saveDb(initial);
    return initial;
  }
}

function saveDb(db) {
  if (antigravityLastSeenAt) {
    db.antigravityLastSeenAt = antigravityLastSeenAt;
  }
  const tmpFile = `${DB_FILE}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

function recalculateSlipItems(slip, settings) {
  if (slip.status === 'pending_antigravity') return slip;
  const newItems = (slip.items || []).map(it => {
    const parsed = parseAndValidateRow(
      {
        col: it.col || 1,
        row: it.row || 1,
        colHeader: it.colHeader || '',
        numText: it.numText || '',
        amtText: it.amtText || '',
        categoryHint: it.categoryHint || '3_top',
        note: it.note || '',
        needsReview: Boolean(it.needsReview),
        confidence: it.confidence ?? 0.99
      },
      settings
    );
    return {
      ...parsed,
      colHeader: it.colHeader || parsed.colHeader || '',
      categoryHint: it.categoryHint || parsed.categoryHint || '3_top',
      box2d: it.box2d || null,
      ocrOriginalNumText: it.ocrOriginalNumText || parsed.numText,
      ocrOriginalAmtText: it.ocrOriginalAmtText || parsed.amtText
    };
  });
  slip.items = newItems;
  slip.totalItems = newItems.filter(i => !i.isEmpty).length;
  slip.totalMoney = newItems.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
  slip.reviewCount = newItems.filter(i => i.needsReview).length;
  return slip;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;

function readRawBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        const err = new Error('Payload Too Large');
        err.statusCode = 413;
        req.destroy();
        return reject(err);
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const buf = await readRawBodyBuffer(req);
  try {
    const raw = buf.toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    err.statusCode = 400;
    throw err;
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (/\/\.(?!well-known)/.test(pathname) || /\.(php|asp|aspx|jsp|cgi)$/i.test(pathname)) {
      res.writeHead(404);
      return res.end('Not Found');
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        status: 'ok',
        uptime: Math.round(process.uptime())
      });
    }

    // Strict Auth Gate for all private /api/* endpoints
    const isPublicApi =
      (req.method === 'GET' && pathname === '/api/auth/me') ||
      (req.method === 'POST' && pathname === '/api/auth/login') ||
      (req.method === 'POST' && pathname === '/api/auth/logout') ||
      (req.method === 'POST' && pathname === '/api/line/webhook');

    if (pathname.startsWith('/api/') && !isPublicApi) {
      if (pathname.startsWith('/api/antigravity/')) {
        if (!isAuthorizedAntigravityReq(req)) {
          return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        }
      } else if (!getSessionUser(req)) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
    }

    // API: Get State for the selected Draw Period
    if (req.method === 'GET' && pathname === '/api/state') {
      const db = loadDb();
      const requestedDrawId = parsedUrl.searchParams.get('drawId') || db.currentDrawId || db.draws[0].id;
      const currentDraw = db.draws.find(d => d.id === requestedDrawId) || db.draws[0];
      db.currentDrawId = currentDraw.id;

      // Sort slips chronologically to ensure roundNumber is sequential per customer
      const rawDrawSlips = db.slips
        .filter(s => (s.drawId || 'DRAW-2026-11-16') === currentDraw.id)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      const roundCounter = {};
      const drawSlips = rawDrawSlips.map(s => {
        roundCounter[s.customerName] = (roundCounter[s.customerName] || 0) + 1;
        const roundNumber = s.roundNumber || roundCounter[s.customerName];

        let full100Money = 0;
        let half50Money = 0;
        const restrictedHits = [];

        for (const it of s.items || []) {
          if (it.isEmpty || !it.baseNumber) continue;
          const ev = evaluateNumberRestriction(it.baseNumber, s.createdAt, currentDraw.restrictedNumbers);
          if (ev.payoutPercentForThisSlip === 100) {
            full100Money += it.rowTotalMoney || 0;
          } else {
            half50Money += it.rowTotalMoney || 0;
            restrictedHits.push(it.baseNumber);
          }
        }

        const subCheck = computeColumnSubtotalChecks(s);

        return {
          ...s,
          roundNumber,
          full100Money,
          half50Money,
          restrictedHits: Array.from(new Set(restrictedHits)),
          columnSubtotalChecks: subCheck.checks,
          subtotalMismatchCount: subCheck.mismatches.length,
          humanApproved: Boolean(s.humanApproved),
          approvedBy: s.approvedBy || null,
          approvedAt: s.approvedAt || null,
          status:
            s.status === 'pending_antigravity'
              ? 'pending_antigravity'
              : (s.reviewCount || 0) > 0
                ? 'needs_review'
                : s.humanApproved
                  ? 'human_verified'
                  : 'ai_passed'
        };
      });

      const drawLayoffs = (db.layoffs || []).filter(l => (l.drawId || currentDraw.id) === currentDraw.id);
      const approvedDrawSlips = drawSlips.filter(s => Boolean(s.humanApproved) && s.status !== 'pending_antigravity');
      const unapprovedDrawSlips = drawSlips.filter(s => !s.humanApproved || s.status === 'pending_antigravity');
      const unapprovedMoney = unapprovedDrawSlips.reduce((sum, s) => sum + (s.totalMoney || 0), 0);
      const totalAllSlipsMoney = drawSlips.reduce((sum, s) => sum + (s.totalMoney || 0), 0);

      // Condition: บิลต้องได้รับการยืนยันการตรวจ OCR (humanApproved) ก่อนจึงจะนำตัวเลขเข้า Pool
      const aggregated = aggregateSlips(approvedDrawSlips, db.settings, currentDraw.restrictedNumbers, drawLayoffs);
      const winnerCheck = checkDrawWinners(approvedDrawSlips, currentDraw, db.settings, drawLayoffs);
      const totalGrandMoney = approvedDrawSlips.reduce((sum, s) => sum + (s.totalMoney || 0), 0);
      const totalFull100Money = aggregated.reduce((sum, a) => sum + (a.fullPayout100Amt || 0), 0);
      const totalHalf50Money = aggregated.reduce((sum, a) => sum + (a.halfPayout50Amt || 0), 0);
      const totalSentToDealerMoney = aggregated.reduce((sum, a) => sum + (a.alreadySentAmt || 0), 0);
      const totalKeptByUsMoney = aggregated.reduce((sum, a) => sum + Math.max(0, (a.totalAmt || 0) - (a.alreadySentAmt || 0)), 0);
      const totalNewPendingMoney = totalKeptByUsMoney;
      const pendingNumbersCount = aggregated.filter(a => (a.totalAmt || 0) - (a.alreadySentAmt || 0) > 0).length;

      // Group customer summary for "เด็กโพย 1 คน ส่งหลายรอบ"
      const customerMap = new Map();
      for (const s of drawSlips) {
        if (!customerMap.has(s.customerName)) {
          customerMap.set(s.customerName, {
            customerName: s.customerName,
            slipCount: 0,
            beforeCutoffRounds: 0,
            afterCutoffRounds: 0,
            totalItems: 0,
            totalMoney: 0,
            full100Money: 0,
            half50Money: 0,
            latestAt: s.createdAt,
            slips: []
          });
        }
        const c = customerMap.get(s.customerName);
        c.slipCount += 1;
        if (s.half50Money > 0) c.afterCutoffRounds += 1;
        else c.beforeCutoffRounds += 1;
        c.totalItems += s.totalItems || 0;
        c.totalMoney += s.totalMoney || 0;
        c.full100Money += s.full100Money || 0;
        c.half50Money += s.half50Money || 0;
        c.latestAt = s.createdAt;
        c.slips.push({
          id: s.id,
          roundNumber: s.roundNumber,
          title: s.title,
          createdAt: s.createdAt,
          totalItems: s.totalItems,
          totalMoney: s.totalMoney,
          full100Money: s.full100Money,
          half50Money: s.half50Money,
          restrictedHits: s.restrictedHits,
          reviewCount: s.reviewCount || 0,
          status: s.status,
          humanApproved: Boolean(s.humanApproved),
          approvedBy: s.approvedBy || null,
          approvedAt: s.approvedAt || null,
          source: s.source
        });
      }

      const drawLineChats = (db.lineChats || []).filter(m => (m.drawId || currentDraw.id) === currentDraw.id);
      const lineReadAt = db.lineReadAt || {};
      const unreadSendersSet = new Set();
      let unreadLineMessagesCount = 0;
      for (const m of drawLineChats) {
        if (m.sender !== 'customer') continue;
        const cname = String(m.customerName || '').trim();
        if (!cname) continue;
        const readTs = lineReadAt[cname] ? new Date(lineReadAt[cname]).getTime() : 0;
        const msgTs = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        if (msgTs > readTs) {
          unreadLineMessagesCount += 1;
          unreadSendersSet.add(cname);
        }
      }

      return sendJson(res, 200, {
        currentDrawId: currentDraw.id,
        currentDraw,
        draws: db.draws,
        upcomingGloDraws: getUpcomingGloDraws(db.draws, 16),
        settings: sanitizeSettings(db.settings),
        antigravityStatus: {
          online: isAntigravityOnline(),
          lastSeenAt: antigravityLastSeenAt ? new Date(antigravityLastSeenAt).toISOString() : null,
          priorityMode: db.settings.ocrPriorityMode || 'auto_hybrid',
          hasApiKey: Boolean((db.settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim()),
          pendingQueueCount: (db.slips || []).filter(s => s.status === 'pending_antigravity').length
        },
        sessionUser: getFreshSessionUser(req, db),
        users: sanitizeUsers(db.users),
        auditLogs: (db.auditLogs || []).slice(0, 150),
        learnedRules: db.learnedRules || [],
        runnerLayouts: db.runnerLayouts || {},
        slips: drawSlips,
        trainingSlips: db.slips.filter(s => s.isTrainingOnly),
        customersInDraw: Array.from(customerMap.values()),
        aggregated,
        winnerCheck,
        layoffs: drawLayoffs,
        lineChats: drawLineChats,
        lineReadAt,
        summary: {
          totalSlips: drawSlips.length,
          approvedSlipsCount: approvedDrawSlips.length,
          unapprovedSlipsCount: unapprovedDrawSlips.length,
          unapprovedMoney,
          totalAllSlipsMoney,
          totalCustomers: customerMap.size,
          totalGrandMoney,
          totalFull100Money,
          totalHalf50Money,
          totalSentToDealerMoney,
          totalKeptByUsMoney,
          totalNewPendingMoney,
          pendingNumbersCount,
          nextLayoffRound: drawLayoffs.length + 1,
          totalUniqueNumbers: aggregated.length,
          restrictedCount: (currentDraw.restrictedNumbers || []).length,
          learnedRulesCount: (db.learnedRules || []).length,
          overLimitCount: aggregated.filter(a => a.isOverLimit).length,
          pendingReviewSlips: drawSlips.filter(s => (s.reviewCount || 0) > 0 && !s.humanApproved).length,
          aiPassedSlips: drawSlips.filter(s => (s.reviewCount || 0) === 0 && !s.humanApproved && s.status !== 'pending_antigravity').length,
          humanVerifiedSlips: drawSlips.filter(s => (s.reviewCount || 0) === 0 && s.humanApproved).length,
          pendingAntigravitySlips: drawSlips.filter(s => s.status === 'pending_antigravity').length,
          unreadLineMessagesCount,
          unreadLineSendersCount: unreadSendersSet.size
        }
      });
    }

    // API: Antigravity Agent Queue & Heartbeat (Dual-Mode Hybrid OCR Priority)
    if (
      (req.method === 'GET' && pathname === '/api/antigravity/queue') ||
      (req.method === 'POST' && pathname === '/api/antigravity/heartbeat')
    ) {
      const db = loadDb();
      const isPassive = parsedUrl.searchParams.get('passive') === '1';
      if (!isPassive) {
        antigravityLastSeenAt = Date.now();
        saveDb(db);
      }

      const pendingSlips = (db.slips || [])
        .filter(s => s.status === 'pending_antigravity')
        .map(s => ({
          id: s.id,
          slipId: s.id,
          customerName: s.customerName,
          title: s.title,
          imageUrl: s.imageUrl,
          drawId: s.drawId,
          roundNumber: s.roundNumber,
          createdAt: s.createdAt
        }));

      return sendJson(res, 200, {
        ok: true,
        online: isAntigravityOnline(),
        lastSeenAt: antigravityLastSeenAt ? new Date(antigravityLastSeenAt).toISOString() : null,
        priorityMode: db.settings.ocrPriorityMode || 'auto_hybrid',
        pendingCount: pendingSlips.length,
        pendingSlips,
        queue: pendingSlips,
        learnedRules: db.learnedRules || [],
        runnerLayouts: db.runnerLayouts || {}
      });
    }

    // API: Antigravity Agent Complete OCR Job
    if (req.method === 'POST' && pathname === '/api/antigravity/complete') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      antigravityLastSeenAt = Date.now();

      const slipId = String(body.slipId || body.id || '').trim();
      const slip = (db.slips || []).find(s => s.id === slipId);
      if (!slip) {
        return sendJson(res, 404, { ok: false, error: 'ไม่พบบิลที่ระบุในระบบ' });
      }

      const rawItems = Array.isArray(body.items) ? body.items : [];
      const validatedItems = rawItems.map(rawIt => {
        const item = applyLearnedCorrectionsToRow(rawIt, db.learnedRules || [], slip.customerName);
        const header = String(item.colHeader || '').trim();
        let categoryHint = String(item.categoryHint || '').trim();
        if (!categoryHint) {
          if (/โต๊ด/.test(header)) categoryHint = '3_toad';
          else if (/ล[\.\-\s]?บ|ล่าง[\.\-\s]?บน/.test(header)) categoryHint = '2_bottom_top';
          else if (/2\s*ล่าง|^ล่าง$/.test(header)) categoryHint = '2_bottom';
          else if (/2\s*บน/.test(header)) categoryHint = '2_top';
          else categoryHint = '3_top';
        }
        const parsedRow = parseAndValidateRow(
          {
            col: item.col || 1,
            row: item.row || 1,
            colHeader: item.colHeader || '',
            categoryHint,
            numText: item.numText || '',
            amtText: item.amtText || '',
            confidence: item.confidence ?? 0.99,
            needsReview: Boolean(item.needsReview),
            note: item.note || ''
          },
          db.settings
        );
        return {
          ...parsedRow,
          colHeader: item.colHeader || parsedRow.colHeader || '',
          categoryHint,
          box2d: Array.isArray(rawIt.box2d) && rawIt.box2d.length === 4 ? rawIt.box2d : null,
          ocrOriginalNumText: parsedRow.numText,
          ocrOriginalAmtText: parsedRow.amtText
        };
      });

      if (body.sheetDate) slip.sheetDate = body.sheetDate;
      if (body.sheetPage) slip.sheetPage = String(body.sheetPage);
      if (body.rotationDeg !== undefined) {
        slip.rotationDeg = ((Number(body.rotationDeg) || 0) % 360 + 360) % 360;
      } else if (slip.rotationDeg === undefined && db.runnerLayouts?.[slip.customerName]?.preferredRotationDeg !== undefined) {
        slip.rotationDeg = ((Number(db.runnerLayouts[slip.customerName].preferredRotationDeg) || 0) % 360 + 360) % 360;
      }
      if (Array.isArray(body.tableBox) && body.tableBox.length === 4) {
        slip.tableBox = body.tableBox;
      } else if (!slip.tableBox && Array.isArray(db.runnerLayouts?.[slip.customerName]?.tableBox)) {
        slip.tableBox = db.runnerLayouts[slip.customerName].tableBox;
      }
      if (Array.isArray(body.tableQuad) && body.tableQuad.length === 4) {
        slip.tableQuad = body.tableQuad;
      } else if (!slip.tableQuad && Array.isArray(db.runnerLayouts?.[slip.customerName]?.tableQuad)) {
        slip.tableQuad = db.runnerLayouts[slip.customerName].tableQuad;
      }
      if (Array.isArray(body.colSplits) && body.colSplits.length >= 2) {
        slip.colSplits = body.colSplits;
      } else if (!slip.colSplits && Array.isArray(db.runnerLayouts?.[slip.customerName]?.colSplits)) {
        slip.colSplits = db.runnerLayouts[slip.customerName].colSplits;
      }
      if (Array.isArray(body.tableMids) && body.tableMids.length === 4) {
        slip.tableMids = body.tableMids;
      } else if (!slip.tableMids && Array.isArray(db.runnerLayouts?.[slip.customerName]?.tableMids)) {
        slip.tableMids = db.runnerLayouts[slip.customerName].tableMids;
      }

      if (typeof body.flattenedImageBase64 === 'string') {
        const mFlat = body.flattenedImageBase64.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
        if (mFlat) {
          const ext = mFlat[1].toLowerCase() === 'png' ? 'png' : 'jpg';
          const fileName = `flattened-${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(UPLOADS_DIR, fileName), Buffer.from(mFlat[2], 'base64'));
          if (!slip.isFlattened) {
            slip.originalImageUrl = slip.originalImageUrl || slip.imageUrl;
            slip.originalRotationDeg = slip.originalRotationDeg ?? (slip.rotationDeg || 0);
          }
          slip.imageUrl = `/uploads/${fileName}`;
          slip.isFlattened = true;
          slip.rotationDeg = 0;
        }
      }

      if (Array.isArray(body.columnSubtotals)) {
        slip.columnSubtotals = normalizeColumnSubtotals(body.columnSubtotals);
      }

      const parsedRowsPerCol = Math.max(0, Number(body.rowsPerCol) || 0);
      const maxRowInSlip = validatedItems.reduce((m, i) => Math.max(m, Number(i.row) || 1), 1);
      const maxColInSlip = validatedItems.reduce((m, i) => Math.max(m, Number(i.col) || 1), 1);

      slip.items = validatedItems;
      slip.rowsPerCol = parsedRowsPerCol || maxRowInSlip;
      slip.isGrid4x30 = maxColInSlip <= 4 && Math.max(maxRowInSlip, parsedRowsPerCol) >= 25;
      slip.totalItems = validatedItems.filter(i => !i.isEmpty).length;
      slip.totalMoney = validatedItems.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
      slip.reviewCount = validatedItems.filter(i => i.needsReview).length;
      slip.humanApproved = false;
      slip.approvedBy = null;
      slip.approvedAt = null;
      slip.modelUsed = 'antigravity-agent (Priority)';
      slip.ocrMode = 'antigravity_direct';
      slip.status = slip.reviewCount > 0 ? 'needs_review' : 'ai_passed';

      if (antigravityPendingJobs.has(slip.id)) {
        const pendingJob = antigravityPendingJobs.get(slip.id);
        pendingJob.status = 'completed';
        if (typeof pendingJob.resolve === 'function') {
          pendingJob.resolve(slip);
        }
        antigravityPendingJobs.delete(slip.id);
      }

      appendAuditLog(
        db,
        'Antigravity AI Agent',
        'อ่านโพยอัตโนมัติ (Antigravity Priority)',
        `อ่านโพย "${slip.title}" ของ ${slip.customerName} สำเร็จ (${slip.totalItems} รายการ รวม ${slip.totalMoney.toLocaleString()} บาท)`
      );
      saveDb(db);
      return sendJson(res, 200, { ok: true, slip });
    }

    // API: Manage Self-Learning OCR Rules (เพิ่ม/ลบกฎความจำลายมือ)
    if (req.method === 'POST' && pathname === '/api/learning') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      db.learnedRules = db.learnedRules || [];

      if (body.action === 'add') {
        const wrongText = String(body.wrongText || '').trim();
        const correctText = String(body.correctText || '').trim();
        if (wrongText && correctText && wrongText !== correctText) {
          db.learnedRules.unshift({
            id: `LEARN-${Date.now().toString().slice(-6)}`,
            customerName: body.customerName || 'ทุกสาย (Global)',
            field: body.field || 'numText',
            wrongText,
            correctText,
            reason: body.reason || 'แอดมินสอนเพิ่มด้วยตัวเอง',
            learnedAt: new Date().toISOString()
          });
        }
      } else if (body.action === 'remove' && body.id) {
        db.learnedRules = db.learnedRules.filter(r => r.id !== body.id);
      }

      saveDb(db);
      return sendJson(res, 200, { ok: true, learnedRules: db.learnedRules });
    }

    // API: Save Self-Learning Runner Paper Layout (จำกรอบตารางอิสระ 4 มุม & เส้นแบ่งคอลัมน์ประจำตัวเด็กโพย)
    if (req.method === 'POST' && pathname === '/api/runner-layouts') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const customerName = String(body.customerName || '').trim();
      const rawQuad =
        Array.isArray(body.tableQuad) &&
        body.tableQuad.length === 4 &&
        body.tableQuad.every(p => Array.isArray(p) && p.length === 2)
          ? body.tableQuad.map(p => [
              Math.max(0, Math.min(1000, Math.round(Number(p[0]) || 0))),
              Math.max(0, Math.min(1000, Math.round(Number(p[1]) || 0)))
            ])
          : null;
      let rawBox = Array.isArray(body.tableBox)
        ? body.tableBox.map(n => Math.max(0, Math.min(1000, Math.round(Number(n) || 0))))
        : null;
      if ((!rawBox || rawBox.length !== 4) && rawQuad) {
        const xs = rawQuad.map(p => p[0]);
        const ys = rawQuad.map(p => p[1]);
        rawBox = [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
      }
      if (!customerName || !rawBox || rawBox.length !== 4 || rawBox[0] >= rawBox[2] || rawBox[1] >= rawBox[3]) {
        return sendJson(res, 400, { ok: false, error: 'ข้อมูลกรอบตาราง (customerName / tableBox / tableQuad) ไม่ถูกต้อง' });
      }

      const rawSplits = Array.isArray(body.colSplits) && body.colSplits.length >= 2
        ? body.colSplits.map(v => Math.max(0, Math.min(1, Number(v) || 0)))
        : null;
      const validSplits =
        rawSplits &&
        rawSplits[0] === 0 &&
        rawSplits[rawSplits.length - 1] === 1 &&
        rawSplits.every((v, idx) => idx === 0 || v > rawSplits[idx - 1])
          ? rawSplits.map(v => Number(v.toFixed(4)))
          : null;
      const rawMids =
        Array.isArray(body.tableMids) &&
        body.tableMids.length === 4 &&
        body.tableMids.every(p => Array.isArray(p) && p.length === 2)
          ? body.tableMids.map(p => [
              Math.max(0, Math.min(1000, Math.round(Number(p[0]) || 0))),
              Math.max(0, Math.min(1000, Math.round(Number(p[1]) || 0)))
            ])
          : null;

      db.runnerLayouts = db.runnerLayouts || {};
      const preferredRotationDeg =
        body.preferredRotationDeg !== undefined
          ? ((Number(body.preferredRotationDeg) || 0) % 360 + 360) % 360
          : db.runnerLayouts[customerName]?.preferredRotationDeg ?? 0;

      const layout = {
        tableBox: rawBox,
        tableQuad: rawQuad || db.runnerLayouts[customerName]?.tableQuad || null,
        tableMids: rawMids || db.runnerLayouts[customerName]?.tableMids || null,
        colSplits: validSplits || db.runnerLayouts[customerName]?.colSplits || null,
        totalCols: Math.max(1, Number(body.totalCols) || 4),
        rowsPerCol: Math.max(1, Number(body.rowsPerCol) || 30),
        colHeaders: Array.isArray(body.colHeaders) ? body.colHeaders.slice(0, 20) : [],
        preferredRotationDeg,
        learnedCount: (db.runnerLayouts[customerName]?.learnedCount || 0) + 1,
        updatedAt: new Date().toISOString()
      };
      db.runnerLayouts[customerName] = layout;

      if (body.slipId) {
        const slip = (db.slips || []).find(s => s.id === String(body.slipId));
        if (slip) {
          slip.tableBox = rawBox;
          slip.rowsPerCol = layout.rowsPerCol;
          if (layout.tableQuad) slip.tableQuad = layout.tableQuad;
          if (layout.tableMids) slip.tableMids = layout.tableMids;
          if (layout.colSplits) slip.colSplits = layout.colSplits;
          if (body.preferredRotationDeg !== undefined) {
            slip.rotationDeg = preferredRotationDeg;
          }
        }
      }

      appendAuditLog(
        db,
        getActorFromReq(req, body),
        'บันทึกกรอบตารางประจำเด็กโพย',
        `จำแบบฟอร์มกระดาษของ "${customerName}" (${layout.totalCols} คอลัมน์ × ${layout.rowsPerCol} แถว, หมุน ${preferredRotationDeg}°)`
      );
      saveDb(db);
      return sendJson(res, 200, { ok: true, layout, runnerLayouts: db.runnerLayouts });
    }

    // API: Get Current Session User
    if (req.method === 'GET' && pathname === '/api/auth/me') {
      const parsedSession = getSessionUser(req);
      const sessionUser = parsedSession ? getFreshSessionUser(req, loadDb()) : null;
      return sendJson(res, 200, {
        ok: true,
        authenticated: Boolean(sessionUser),
        user: sessionUser
      });
    }

    // API: Logout
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const isHttps = req.headers['x-forwarded-proto'] === 'https';
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `lotto_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isHttps ? '; Secure' : ''}`
      });
    }

    // API: User Authentication (Login with Signed HttpOnly Cookie + IP Brute-Force Protection)
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const clientIp = getClientIp(req);
      if (isLoginRateLimited(clientIp)) {
        return sendJson(res, 429, {
          ok: false,
          error: 'พยายามเข้าสู่ระบบผิดพลาดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่อีกครั้ง'
        });
      }

      const body = await parseJsonBody(req);
      const db = loadDb();
      const users = db.users || [
        { id: 'USR-1', username: 'admin', password: hashPassword('1234'), displayName: 'เฮียเจ้าของระบบ (Admin)', role: 'admin' },
        { id: 'USR-2', username: 'staff1', password: hashPassword('1234'), displayName: 'แอดมินเมย์ (ฝ่ายตรวจโพย)', role: 'staff' }
      ];
      db.users = users;

      const username = String(body.username || '').trim();
      const password = String(body.password || '').trim();
      const found = users.find(
        u => u.username.toLowerCase() === username.toLowerCase() && verifyPassword(password, u.password)
      );

      if (!found) {
        recordFailedLogin(clientIp);
        return sendJson(res, 401, { ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
      }

      loginAttempts.delete(clientIp);
      const publicUser = resolvePublicUser(found);
      const token = createSessionToken(publicUser);
      const isHttps = req.headers['x-forwarded-proto'] === 'https';
      const cookieVal = `lotto_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${isHttps ? '; Secure' : ''}`;

      appendAuditLog(db, found.displayName, 'เข้าสู่ระบบ', `ล็อกอินเข้าใช้งานด้วยบัญชี @${found.username}`);
      saveDb(db);

      return sendJson(res, 200, { ok: true, user: publicUser }, { 'Set-Cookie': cookieVal });
    }

    // API: Change Own Password (Authenticated)
    if (req.method === 'POST' && pathname === '/api/auth/change-password') {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      const body = await parseJsonBody(req);
      const currentPassword = String(body.currentPassword || '').trim();
      const newPassword = String(body.newPassword || '').trim();

      if (newPassword.length < 6) {
        return sendJson(res, 400, { ok: false, error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
      }

      const db = loadDb();
      const user = (db.users || []).find(u => u.id === sessionUser.id || u.username === sessionUser.username);
      if (!user) {
        return sendJson(res, 404, { ok: false, error: 'ไม่พบบัญชีผู้ใช้งาน' });
      }
      if (!verifyPassword(currentPassword, user.password)) {
        return sendJson(res, 400, { ok: false, error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
      }

      user.password = hashPassword(newPassword);
      appendAuditLog(db, user.displayName, 'เปลี่ยนรหัสผ่าน', `เปลี่ยนรหัสผ่านบัญชี @${user.username} เรียบร้อย`);
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    // API: Manage User Accounts (Add / Edit / Remove Staff or Admin accounts + Avatar)
    if (req.method === 'POST' && pathname === '/api/users') {
      const sessionUser = getFreshSessionUser(req);
      if (!sessionUser) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      const body = await parseJsonBody(req);
      const db = loadDb();
      const actor = getActorFromReq(req, body);
      db.users = db.users || [];

      if (body.action === 'add') {
        if (!requireAdmin(req, res)) return;
        const username = String(body.username || '').trim();
        const password = String(body.password || '').trim();
        const displayName = String(body.displayName || username).trim();
        const role = body.role === 'admin' ? 'admin' : 'staff';
        const phone = String(body.phone || '').trim().slice(0, 60);
        const note = String(body.note || '').trim().slice(0, 160);

        if (!username) return sendJson(res, 400, { error: 'กรุณาระบุชื่อผู้ใช้ (Username)' });
        if (password.length < 6) {
          return sendJson(res, 400, { error: 'กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร' });
        }
        if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
          return sendJson(res, 400, { error: 'ชื่อผู้ใช้นี้มีในระบบแล้ว' });
        }

        const newId = `USR-${Date.now().toString().slice(-5)}`;
        let avatarUrl = '';
        if (body.avatarBase64) {
          try {
            avatarUrl = saveAvatarDataUrl(newId, body.avatarBase64);
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }

        db.users.push({
          id: newId,
          username,
          password: hashPassword(password),
          displayName,
          role,
          phone,
          note,
          avatarUrl
        });
        appendAuditLog(db, actor, 'จัดการบัญชีผู้ใช้', `สร้างบัญชีผู้ใช้ใหม่: ${displayName} (@${username})`);
        saveDb(db);
        return sendJson(res, 200, { ok: true, users: sanitizeUsers(db.users) });
      }

      if (body.action === 'edit' && body.id) {
        const target = db.users.find(u => u.id === body.id);
        if (!target) {
          return sendJson(res, 404, { error: 'ไม่พบบัญชีผู้ใช้งานนี้ในระบบ' });
        }
        const isAdmin = sessionUser.role === 'admin';
        const isSelf =
          target.id === sessionUser.id ||
          target.username.toLowerCase() === String(sessionUser.username || '').toLowerCase();
        if (!isAdmin && !isSelf) {
          return sendJson(res, 403, { error: 'เฉพาะบัญชีเจ้าของระบบ (Admin) เท่านั้นที่แก้ไขบัญชีผู้อื่นได้' });
        }

        const changes = [];
        if (body.displayName !== undefined) {
          const nextDisplay = String(body.displayName || '').trim();
          if (!nextDisplay) {
            return sendJson(res, 400, { error: 'กรุณาระบุชื่อที่แสดงในระบบ' });
          }
          if (nextDisplay !== target.displayName) changes.push(`ชื่อแสดง: ${nextDisplay}`);
          target.displayName = nextDisplay;
        }

        if (isAdmin && body.username !== undefined) {
          const nextUsername = String(body.username || '').trim();
          if (!nextUsername) {
            return sendJson(res, 400, { error: 'กรุณาระบุชื่อผู้ใช้ (Username)' });
          }
          if (target.username === 'admin' && nextUsername.toLowerCase() !== 'admin') {
            return sendJson(res, 400, { error: 'ไม่สามารถเปลี่ยนชื่อผู้ใช้หลัก @admin ได้' });
          }
          if (
            nextUsername.toLowerCase() !== target.username.toLowerCase() &&
            db.users.some(u => u.id !== target.id && u.username.toLowerCase() === nextUsername.toLowerCase())
          ) {
            return sendJson(res, 400, { error: 'ชื่อผู้ใช้นี้มีในระบบแล้ว' });
          }
          if (nextUsername !== target.username) changes.push(`@${nextUsername}`);
          target.username = nextUsername;
        }

        if (isAdmin && body.role !== undefined) {
          const nextRole = body.role === 'admin' ? 'admin' : 'staff';
          if (target.role === 'admin' && nextRole !== 'admin') {
            const otherAdmins = db.users.filter(u => u.id !== target.id && u.role === 'admin');
            if (otherAdmins.length === 0) {
              return sendJson(res, 400, { error: 'ต้องมีบัญชีเจ้าของระบบ (Admin) อย่างน้อย 1 บัญชี' });
            }
          }
          if (nextRole !== target.role) changes.push(`สิทธิ์: ${nextRole}`);
          target.role = nextRole;
        }

        if (body.phone !== undefined) {
          target.phone = String(body.phone || '').trim().slice(0, 60);
        }
        if (body.note !== undefined) {
          target.note = String(body.note || '').trim().slice(0, 160);
        }

        const nextPassword = String(body.password || '').trim();
        if (isAdmin && nextPassword) {
          if (nextPassword.length < 6) {
            return sendJson(res, 400, { error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
          }
          target.password = hashPassword(nextPassword);
          changes.push('รีเซ็ตรหัสผ่าน');
        }

        if (body.avatarBase64) {
          let newAvatarUrl = '';
          try {
            newAvatarUrl = saveAvatarDataUrl(target.id, body.avatarBase64);
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
          deleteAvatarFileIfLocal(target.avatarUrl);
          target.avatarUrl = newAvatarUrl;
          changes.push('อัปเดตรูปโปรไฟล์');
        } else if (body.removeAvatar === true) {
          deleteAvatarFileIfLocal(target.avatarUrl);
          target.avatarUrl = '';
          changes.push('ลบรูปโปรไฟล์');
        }

        const publicTarget = resolvePublicUser(target);
        appendAuditLog(
          db,
          actor,
          'แก้ไขข้อมูลบัญชีผู้ใช้',
          `อัปเดตบัญชี ${target.displayName} (@${target.username})${changes.length ? ` (${changes.join(', ')})` : ''}`
        );
        saveDb(db);

        const extraHeaders = {};
        if (isSelf) {
          const refreshedToken = createSessionToken(publicTarget);
          const isHttps = req.headers['x-forwarded-proto'] === 'https';
          extraHeaders['Set-Cookie'] =
            `lotto_session=${refreshedToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${isHttps ? '; Secure' : ''}`;
        }

        return sendJson(
          res,
          200,
          {
            ok: true,
            user: publicTarget,
            sessionUser: isSelf ? publicTarget : undefined,
            users: sanitizeUsers(db.users)
          },
          extraHeaders
        );
      }

      if (body.action === 'remove' && body.id) {
        if (!requireAdmin(req, res)) return;
        const target = db.users.find(u => u.id === body.id);
        if (target && target.username !== 'admin') {
          deleteAvatarFileIfLocal(target.avatarUrl);
          db.users = db.users.filter(u => u.id !== body.id);
          appendAuditLog(db, actor, 'จัดการบัญชีผู้ใช้', `ลบบัญชีผู้ใช้: ${target.displayName} (@${target.username})`);
        }
        saveDb(db);
        return sendJson(res, 200, { ok: true, users: sanitizeUsers(db.users) });
      }

      return sendJson(res, 400, { error: 'คำสั่งจัดการบัญชีไม่ถูกต้อง' });
    }

    // API: Log Custom Frontend Audit Event (e.g. Export Excel, Print, Logout)
    if (req.method === 'POST' && pathname === '/api/audit-event') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const actor = getActorFromReq(req, body);
      appendAuditLog(db, actor, body.actionType || 'ทำรายการ', body.detail || '');
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    // API: Create or Switch Draw Period
    if (req.method === 'POST' && pathname === '/api/draws') {
      const body = await parseJsonBody(req);
      const db = loadDb();

      if (body.action === 'switch' && body.drawId) {
        db.currentDrawId = body.drawId;
        saveDb(db);
        return sendJson(res, 200, { ok: true, currentDrawId: db.currentDrawId });
      }

      const title = (body.title || 'งวดใหม่').trim();
      const drawDate = body.drawDate || new Date().toISOString().slice(0, 10);
      const newDraw = {
        id: `DRAW-${Date.now()}`,
        title,
        drawDate,
        status: 'open',
        restrictedNumbers: []
      };
      db.draws.unshift(newDraw);
      db.currentDrawId = newDraw.id;
      appendAuditLog(db, getActorFromReq(req, body), 'เปิดงวดหวยใหม่', `สร้างและเปิดรับโพย ${title} (${drawDate})`);
      saveDb(db);
      return sendJson(res, 200, { ok: true, draw: newDraw });
    }

    // API: Fetch GLO Lottery Results or Save Manual Winning Numbers
    if (req.method === 'POST' && pathname === '/api/draws/winning-result') {
      if (!requireAdmin(req, res)) return;
      const body = await parseJsonBody(req);
      const db = loadDb();
      const draw = db.draws.find(d => d.id === (body.drawId || db.currentDrawId)) || db.draws[0];

      if (body.action === 'fetch_glo') {
        let gloData = null;
        try {
          const gloRes = await fetch('https://lotto.api.rayriffy.com/latest', {
            headers: { 'User-Agent': 'LottoOCR-Pro/1.0' }
          });
          if (gloRes.ok) {
            const json = await gloRes.json();
            const prizes = json?.response?.prizes || [];
            const runningNumbers = json?.response?.runningNumbers || [];
            const prizeFirst = prizes.find(p => p.id === 'prizeFirst')?.number?.[0] || '';
            const runningBackTwo = runningNumbers.find(r => r.id === 'runningNumberBackTwo')?.number?.[0] || '';
            const dateText = json?.response?.date || '';

            if (prizeFirst && prizeFirst.length === 6) {
              gloData = {
                firstPrize: prizeFirst,
                threeTop: prizeFirst.slice(-3),
                twoTop: prizeFirst.slice(-2),
                twoBottom: runningBackTwo || '21',
                source: `ดึงข้อมูลกองสลากสำเร็จ (งวด ${dateText})`,
                updatedAt: new Date().toISOString()
              };
            }
          }
        } catch (err) {
          console.error('GLO fetch fallback:', err.message);
        }

        if (!gloData) {
          gloData = {
            firstPrize: '945583',
            threeTop: '583',
            twoTop: '83',
            twoBottom: '21',
            source: 'ผลสลากตัวอย่างงวด 16 พ.ย. (รางวัลที่ 1: 945583 / เลขท้าย 2 ตัว: 21)',
            updatedAt: new Date().toISOString()
          };
        }

        draw.winningResult = gloData;
        saveDb(db);
        return sendJson(res, 200, { ok: true, winningResult: draw.winningResult });
      } else {
        const firstPrize = String(body.firstPrize || '').replace(/[^\d]/g, '').slice(0, 6);
        let threeTop = String(body.threeTop || '').replace(/[^\d]/g, '').slice(0, 3);
        if (!threeTop && firstPrize.length >= 3) threeTop = firstPrize.slice(-3);
        let twoTop = String(body.twoTop || '').replace(/[^\d]/g, '').slice(0, 2);
        if (!twoTop && threeTop.length >= 2) twoTop = threeTop.slice(-2);
        const twoBottom = String(body.twoBottom || '').replace(/[^\d]/g, '').slice(0, 2);

        draw.winningResult = {
          firstPrize: firstPrize || (threeTop ? `945${threeTop}` : ''),
          threeTop,
          twoTop,
          twoBottom,
          source: 'กำหนดเลขรางวัลเพื่อตรวจคนถูก',
          updatedAt: new Date().toISOString()
        };

        if (body.payoutRates) {
          db.settings.payoutRates = {
            ...(db.settings.payoutRates || {}),
            ...body.payoutRates
          };
        }

        saveDb(db);
        return sendJson(res, 200, { ok: true, winningResult: draw.winningResult });
      }
    }

    // API: Manage Restricted Numbers
    if (req.method === 'POST' && pathname === '/api/draws/restrictions') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const draw = db.draws.find(d => d.id === (body.drawId || db.currentDrawId)) || db.draws[0];

      if (body.action === 'add_batch') {
        const rawNums = String(body.numbersText || '')
          .split(/[\s,،\r\n]+/)
          .map(s => s.replace(/[^\d]/g, '').trim())
          .filter(s => s.length === 2 || s.length === 3);

        const announcedAt = body.announcedAt
          ? safeIsoDate(body.announcedAt)
          : new Date().toISOString();
        const payoutPercent = Number(body.payoutPercent) || 50;
        const note = (body.note || `เจ้ามือแจ้งอั้นจ่าย ${payoutPercent}%`).trim();

        draw.restrictedNumbers = draw.restrictedNumbers || [];
        for (const num of rawNums) {
          const existingIdx = draw.restrictedNumbers.findIndex(r => r.number === num);
          const entry = { number: num, payoutPercent, announcedAt, note };
          if (existingIdx >= 0) {
            draw.restrictedNumbers[existingIdx] = entry;
          } else {
            draw.restrictedNumbers.push(entry);
          }
        }
        appendAuditLog(db, getActorFromReq(req, body), 'ตั้งค่าเลขอั้น 50%', `ประกาศเลขอั้น (${rawNums.join(', ')}) จ่าย ${payoutPercent}% ใน ${draw.title}`);
      } else if (body.action === 'remove' && body.number) {
        draw.restrictedNumbers = (draw.restrictedNumbers || []).filter(r => r.number !== body.number);
        appendAuditLog(db, getActorFromReq(req, body), 'ลบเลขอั้น', `ลบเลข ${body.number} ออกจากรายการอั้น`);
      } else if (body.action === 'clear_all') {
        if (!requireAdmin(req, res)) return;
        draw.restrictedNumbers = [];
        appendAuditLog(db, getActorFromReq(req, body), 'ล้างเลขอั้น', `ล้างรายการเลขอั้นทั้งหมดของ ${draw.title}`);
      }

      saveDb(db);
      return sendJson(res, 200, { ok: true, draw });
    }

    // API: Reset Demo Database
    if (req.method === 'POST' && pathname === '/api/reset') {
      if (!requireAdmin(req, res)) return;
      const initial = buildInitialDb();
      saveDb(initial);
      return sendJson(res, 200, { ok: true, message: 'รีเซ็ตข้อมูลตัวอย่างเริ่มต้นเรียบร้อยแล้ว' });
    }

    // API: Update Settings (Whitelisted Fields + Secret Protection)
    if (req.method === 'POST' && pathname === '/api/settings') {
      if (!requireAdmin(req, res)) return;
      const body = await parseJsonBody(req);
      const db = loadDb();
      const s = db.settings || {};

      if (typeof body.ocrPriorityMode === 'string') s.ocrPriorityMode = body.ocrPriorityMode;
      if (typeof body.geminiModel === 'string') s.geminiModel = body.geminiModel;
      if (typeof body.permutationMode === 'string') s.permutationMode = body.permutationMode;
      if (typeof body.useColumnSlicing === 'boolean') s.useColumnSlicing = body.useColumnSlicing;
      if (typeof body.checkMultiplesOf11 === 'boolean') s.checkMultiplesOf11 = body.checkMultiplesOf11;
      if (typeof body.drawCutoffTime === 'string') s.drawCutoffTime = body.drawCutoffTime;
      if (typeof body.nextDrawOpenTime === 'string') s.nextDrawOpenTime = body.nextDrawOpenTime;
      if (typeof body.afterCutoffAction === 'string') s.afterCutoffAction = body.afterCutoffAction;
      if (body.payoutRates && typeof body.payoutRates === 'object') {
        s.payoutRates = { ...(s.payoutRates || {}), ...body.payoutRates };
      }
      if (body.riskLimits && typeof body.riskLimits === 'object') {
        s.riskLimits = { ...(s.riskLimits || {}), ...body.riskLimits };
      }

      // Only overwrite secret fields when a real non-masked non-empty string is explicitly submitted
      if (typeof body.geminiApiKey === 'string') {
        const k = body.geminiApiKey.trim();
        if (k && !k.includes('••') && !/^\*+$/.test(k)) s.geminiApiKey = k;
      }
      if (typeof body.lineChannelAccessToken === 'string') {
        const t = body.lineChannelAccessToken.trim();
        if (t && !t.includes('••') && !/^\*+$/.test(t)) s.lineChannelAccessToken = t;
      }
      if (typeof body.lineChannelSecret === 'string') {
        const sec = body.lineChannelSecret.trim();
        if (sec && !sec.includes('••') && !/^\*+$/.test(sec)) s.lineChannelSecret = sec;
      }

      db.settings = s;
      db.slips.forEach(sl => recalculateSlipItems(sl, db.settings));
      appendAuditLog(
        db,
        getActorFromReq(req, body),
        'แก้ไขการตั้งค่าระบบ',
        `บันทึกการตั้งค่า (โหมดชุดกลับ: ${s.permutationMode || 'expand'}, โหมด OCR: ${s.ocrPriorityMode || 'auto_hybrid'})`
      );
      saveDb(db);
      return sendJson(res, 200, { ok: true, settings: sanitizeSettings(db.settings) });
    }

    // API: Upload & Run OCR on Paper Slip Image
    if (req.method === 'POST' && pathname === '/api/slips/ocr') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const drawId = body.drawId || db.currentDrawId || db.draws[0].id;
      const currentDraw = db.draws.find(d => d.id === drawId) || db.draws[0];

      const customerName = (body.customerName || 'ลูกค้าทั่วไป (LINE)').trim();
      const nextRound = getNextRoundForCustomer(db.slips, currentDraw.id, customerName);
      const title = (body.title || `รอบที่ ${nextRound} — โพยกระดาษ (${customerName})`).trim();
      const base64Image = body.base64Image || '';
      const columnSlices = body.columnSlices || null;
      const submittedAt = body.submittedAt ? safeIsoDate(body.submittedAt) : new Date().toISOString();

      let savedImageUrl = '/uploads/slip-16-11-page1.jpg';
      if (base64Image && base64Image.startsWith('data:image/')) {
        const matches = base64Image.match(/^data:(image\/(\w+));base64,(.+)$/);
        if (matches) {
          const ext = matches[2] === 'png' ? 'png' : 'jpg';
          const fileName = `slip-${Date.now()}.${ext}`;
          const filePath = path.join(UPLOADS_DIR, fileName);
          fs.writeFileSync(filePath, Buffer.from(matches[3], 'base64'));
          savedImageUrl = `/uploads/${fileName}`;
        }
      }

      const isTrainingOnly = Boolean(body.isTrainingOnly);
      const priorityMode = db.settings.ocrPriorityMode || 'auto_hybrid';
      const agOnline = isAntigravityOnline();
      const hasApiKey = Boolean((db.settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim());

      if ((priorityMode === 'antigravity_only') || (priorityMode === 'auto_hybrid' && agOnline) || (Boolean(base64Image) && !hasApiKey)) {
        const newSlip = {
          id: `${isTrainingOnly ? 'TRAIN' : 'SLIP'}-${Date.now().toString().slice(-6)}`,
          drawId: isTrainingOnly ? 'TRAINING_ARCHIVE' : currentDraw.id,
          isTrainingOnly,
          roundNumber: isTrainingOnly ? 0 : nextRound,
          title: isTrainingOnly ? `[โพยเก่าฝึกสอน AI] ${title}` : title,
          sheetDate: '16/11',
          sheetPage: String(nextRound),
          customerName,
          customerLineId: body.customerLineId || `U_${Date.now().toString().slice(-5)}`,
          source: isTrainingOnly ? 'โหมดฝึกสอนจากโพยเก่า' : (body.source || 'อัปโหลดรูปโพย (Antigravity Priority)'),
          imageUrl: savedImageUrl,
          rotationDeg: 0,
          isGrid4x30: true,
          status: 'pending_antigravity',
          humanApproved: false,
          approvedBy: null,
          approvedAt: null,
          modelUsed: !hasApiKey && !agOnline
            ? 'รอตั้งค่า Gemini API Key / รอ Antigravity อ่าน'
            : 'antigravity-agent (รอคิวอ่าน...)',
          ocrMode: 'antigravity_queue',
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostTHB: 0 },
          totalItems: 0,
          totalMoney: 0,
          reviewCount: 0,
          createdAt: submittedAt,
          items: []
        };

        db.slips.push(newSlip);
        appendAuditLog(
          db,
          getActorFromReq(req, body),
          'ส่งโพยเข้าคิว Antigravity (Priority #1)',
          `อัปโหลดโพยของ "${customerName}" (${newSlip.title}) เข้าคิวให้ Antigravity Agent อ่านลายมืออัตโนมัติ`
        );
        saveDb(db);

        // Wait up to 8000ms (polling every 500ms) in case Antigravity completes it while the HTTP request is open
        let completedSlip = null;
        const jobPromise = new Promise(resolve => {
          antigravityPendingJobs.set(newSlip.id, {
            jobId: newSlip.id,
            slipId: newSlip.id,
            imageUrl: savedImageUrl,
            customerName,
            title: newSlip.title,
            createdAt: submittedAt,
            status: 'pending',
            resolve
          });
        });

        const pollWaitPromise = (async () => {
          for (let tick = 0; tick < 16; tick++) {
            await new Promise(r => setTimeout(r, 500));
            const latestDb = loadDb();
            const found = (latestDb.slips || []).find(s => s.id === newSlip.id);
            if (found && found.status !== 'pending_antigravity') {
              return found;
            }
          }
          return null;
        })();

        completedSlip = await Promise.race([jobPromise, pollWaitPromise]);
        antigravityPendingJobs.delete(newSlip.id);

        if (completedSlip && completedSlip.status !== 'pending_antigravity') {
          return sendJson(res, 200, {
            ok: true,
            slip: completedSlip,
            ocrResult: {
              mode: 'antigravity_direct',
              modelUsed: completedSlip.modelUsed,
              items: completedSlip.items
            }
          });
        }

        // If not completed within 8s and Antigravity went offline in auto_hybrid mode with an API key available, fallback to Gemini API Key
        if (priorityMode === 'auto_hybrid' && !isAntigravityOnline() && hasApiKey) {
          const ocrResult = await analyzeSlipImage({
            base64Image: base64Image || fs.readFileSync(path.join(UPLOADS_DIR, 'slip-16-11-page1.jpg')).toString('base64'),
            columnSlices,
            settings: db.settings,
            learnedRules: db.learnedRules || [],
            customerName,
            runnerLayout: db.runnerLayouts?.[customerName] || null
          });
          const latestDb = loadDb();
          const targetSlip = (latestDb.slips || []).find(s => s.id === newSlip.id);
          if (targetSlip) {
            const items = ocrResult.items || [];
            const maxRowInSlip = items.reduce((m, i) => Math.max(m, Number(i.row) || 1), 1);
            const maxColInSlip = items.reduce((m, i) => Math.max(m, Number(i.col) || 1), 1);
            targetSlip.items = items;
            targetSlip.rowsPerCol = Number(ocrResult.rowsPerCol) || maxRowInSlip;
            targetSlip.isGrid4x30 = maxColInSlip <= 4 && Math.max(maxRowInSlip, targetSlip.rowsPerCol) >= 25;
            targetSlip.totalItems = items.filter(i => !i.isEmpty).length;
            targetSlip.totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
            targetSlip.reviewCount = items.filter(i => i.needsReview).length;
            targetSlip.status = targetSlip.reviewCount > 0 ? 'needs_review' : 'ai_passed';
            targetSlip.modelUsed = ocrResult.modelUsed;
            targetSlip.ocrMode = ocrResult.mode;
            targetSlip.usage = ocrResult.usage;
            saveDb(latestDb);
            return sendJson(res, 200, {
              ok: true,
              slip: targetSlip,
              ocrResult
            });
          }
        }

        return sendJson(res, 200, {
          ok: true,
          queuedForAntigravity: true,
          slip: newSlip
        });
      }

      const ocrResult = await analyzeSlipImage({
        base64Image: base64Image || fs.readFileSync(path.join(UPLOADS_DIR, 'slip-16-11-page1.jpg')).toString('base64'),
        columnSlices,
        settings: db.settings,
        learnedRules: db.learnedRules || [],
        customerName,
        runnerLayout: db.runnerLayouts?.[customerName] || null,
        allowDemoFallback: !base64Image
      });

      const items = ocrResult.items || [];
      const maxRowInSlip = items.reduce((m, i) => Math.max(m, Number(i.row) || 1), 1);
      const maxColInSlip = items.reduce((m, i) => Math.max(m, Number(i.col) || 1), 1);
      const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
      const reviewCount = items.filter(i => i.needsReview).length;

      const newSlip = {
        id: `${isTrainingOnly ? 'TRAIN' : 'SLIP'}-${Date.now().toString().slice(-6)}`,
        drawId: isTrainingOnly ? 'TRAINING_ARCHIVE' : currentDraw.id,
        isTrainingOnly,
        roundNumber: isTrainingOnly ? 0 : nextRound,
        title: isTrainingOnly ? `[โพยเก่าฝึกสอน AI] ${title}` : title,
        sheetDate: ocrResult.sheetDate || '16/11',
        sheetPage: String(nextRound),
        customerName,
        customerLineId: body.customerLineId || `U_${Date.now().toString().slice(-5)}`,
        source: isTrainingOnly ? 'โหมดฝึกสอนจากโพยเก่า' : (body.source || 'อัปโหลดรูปโพย (OCR)'),
        imageUrl: savedImageUrl,
        rotationDeg: Number(ocrResult.rotationNeededDeg) || 0,
        tableBox: ocrResult.tableBox || null,
        rowsPerCol: Number(ocrResult.rowsPerCol) || maxRowInSlip,
        isGrid4x30: maxColInSlip <= 4 && Math.max(maxRowInSlip, Number(ocrResult.rowsPerCol) || 0) >= 25,
        status: reviewCount > 0 ? 'needs_review' : 'ai_passed',
        humanApproved: false,
        approvedBy: null,
        approvedAt: null,
        modelUsed: ocrResult.modelUsed,
        ocrMode: ocrResult.mode,
        usage: ocrResult.usage,
        totalItems: items.filter(i => !i.isEmpty).length,
        totalMoney,
        reviewCount,
        createdAt: submittedAt,
        items
      };

      db.slips.push(newSlip);
      appendAuditLog(
        db,
        getActorFromReq(req, body),
        'เพิ่มโพยกระดาษ (OCR)',
        `เพิ่มโพยของ "${customerName}" (${newSlip.title}) จำนวน ${newSlip.totalItems} รายการ ยอดรวม ${totalMoney.toLocaleString()} บาท`
      );
      saveDb(db);

      return sendJson(res, 200, {
        ok: true,
        slip: newSlip,
        ocrResult
      });
    }

    // API: Flatten / Straighten Slip Image via 8-point Coons Patch (or restore original)
    if (req.method === 'POST' && /^\/api\/slips\/[^/]+\/flatten$/.test(pathname)) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', '').replace('/flatten', ''));
      const body = await parseJsonBody(req);
      const db = loadDb();
      const slip = (db.slips || []).find(s => s.id === slipId);
      if (!slip) return sendJson(res, 404, { ok: false, error: 'ไม่พบบิลนี้ในระบบ' });

      if (body.restoreOriginal) {
        if (!slip.originalImageUrl) {
          return sendJson(res, 400, { ok: false, error: 'ไม่มีรูปต้นฉบับให้กู้คืน' });
        }
        const prevFlat = slip.imageUrl;
        slip.imageUrl = slip.originalImageUrl;
        slip.rotationDeg = slip.originalRotationDeg ?? 0;
        slip.isFlattened = false;
        if (Array.isArray(slip.originalTableQuad) && slip.originalTableQuad.length === 4) {
          slip.tableQuad = slip.originalTableQuad;
        }
        if (Array.isArray(slip.originalTableMids) && slip.originalTableMids.length === 4) {
          slip.tableMids = slip.originalTableMids;
        }
        if (Array.isArray(slip.tableQuad) && slip.tableQuad.length === 4) {
          const xs = slip.tableQuad.map(p => Number(p[0]) || 0);
          const ys = slip.tableQuad.map(p => Number(p[1]) || 0);
          slip.tableBox = [Math.round(Math.min(...ys)), Math.round(Math.min(...xs)), Math.round(Math.max(...ys)), Math.round(Math.max(...xs))];
        }
        if (
          prevFlat &&
          prevFlat !== slip.imageUrl &&
          prevFlat.startsWith('/uploads/flattened-')
        ) {
          const oldPath = path.resolve(PUBLIC_DIR, prevFlat.replace(/^\/+/, ''));
          if (oldPath.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch {}
          }
        }
        appendAuditLog(
          db,
          getActorFromReq(req, body),
          'คืนค่ารูปโพยต้นฉบับ',
          `คืนค่ารูปต้นฉบับของ "${slip.customerName}" (${slip.title})`
        );
        saveDb(db);
        return sendJson(res, 200, { ok: true, slip });
      }

      const rawImg = String(body.base64Image || '');
      const matches = rawImg.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
      if (!matches) {
        return sendJson(res, 400, { ok: false, error: 'ไฟล์ภาพที่แปลงแล้วไม่ถูกต้อง' });
      }
      const ext = matches[1].toLowerCase() === 'png' ? 'png' : 'jpg';
      const fileName = `flattened-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, fileName), Buffer.from(matches[2], 'base64'));

      if (!slip.isFlattened) {
        slip.originalImageUrl = slip.originalImageUrl || slip.imageUrl;
        slip.originalRotationDeg = slip.originalRotationDeg ?? (slip.rotationDeg || 0);
      } else if (slip.imageUrl && slip.imageUrl.startsWith('/uploads/flattened-')) {
        const oldPath = path.resolve(PUBLIC_DIR, slip.imageUrl.replace(/^\/+/, ''));
        if (oldPath.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch {}
        }
      }

      if (Array.isArray(body.sourceQuad) && body.sourceQuad.length === 4) {
        slip.originalTableQuad = body.sourceQuad;
      }
      if (Array.isArray(body.sourceMids) && body.sourceMids.length === 4) {
        slip.originalTableMids = body.sourceMids;
      }

      db.runnerLayouts = db.runnerLayouts || {};
      if (slip.customerName && Array.isArray(body.sourceQuad) && body.sourceQuad.length === 4) {
        const xs = body.sourceQuad.map(p => Number(p[0]) || 0);
        const ys = body.sourceQuad.map(p => Number(p[1]) || 0);
        db.runnerLayouts[slip.customerName] = {
          ...(db.runnerLayouts[slip.customerName] || {}),
          tableBox: [Math.round(Math.min(...ys)), Math.round(Math.min(...xs)), Math.round(Math.max(...ys)), Math.round(Math.max(...xs))],
          tableQuad: body.sourceQuad,
          tableMids: Array.isArray(body.sourceMids) && body.sourceMids.length === 4 ? body.sourceMids : null,
          colSplits: Array.isArray(body.colSplits) ? body.colSplits : db.runnerLayouts[slip.customerName]?.colSplits || null,
          totalCols: Number(body.totalCols) || db.runnerLayouts[slip.customerName]?.totalCols || 4,
          rowsPerCol: Number(body.rowsPerCol) || db.runnerLayouts[slip.customerName]?.rowsPerCol || 30,
          preferredRotationDeg: slip.originalRotationDeg ?? 0,
          learnedCount: (db.runnerLayouts[slip.customerName]?.learnedCount || 0) + 1,
          updatedAt: new Date().toISOString()
        };
      }

      slip.imageUrl = `/uploads/${fileName}`;
      slip.rotationDeg = 0;
      slip.isFlattened = true;
      if (Array.isArray(body.flatBox) && body.flatBox.length === 4) slip.tableBox = body.flatBox;
      if (Array.isArray(body.flatQuad) && body.flatQuad.length === 4) slip.tableQuad = body.flatQuad;
      if (Array.isArray(body.flatMids) && body.flatMids.length === 4) slip.tableMids = body.flatMids;
      if (Array.isArray(body.colSplits) && body.colSplits.length >= 2) slip.colSplits = body.colSplits;

      appendAuditLog(
        db,
        getActorFromReq(req, body),
        'แปลงรูปโพยเป็นภาพเอกสารตรง',
        `ดัดแปลงรูปโพยของ "${slip.customerName}" (${slip.title}) เป็นภาพเอกสารตรง`
      );
      saveDb(db);
      return sendJson(res, 200, { ok: true, slip });
    }

    // API: Stage 1 AI Auto-Scan Paper Edges & Mesh (or Recall Runner Layout Memory)
    if (req.method === 'POST' && /^\/api\/slips\/[^/]+\/auto-scan$/.test(pathname)) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', '').replace('/auto-scan', ''));
      const body = await parseJsonBody(req);
      const db = loadDb();
      const slip = (db.slips || []).find(s => s.id === slipId);
      if (!slip) return sendJson(res, 404, { ok: false, error: 'ไม่พบบิลนี้ในระบบ' });

      const savedLayout = db.runnerLayouts?.[slip.customerName] || null;
      const hasApiKey = Boolean((db.settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim());

      let imgBase64 = '';
      if (typeof body.base64Image === 'string' && body.base64Image.startsWith('data:image/')) {
        imgBase64 = body.base64Image;
      } else if (slip.imageUrl && slip.imageUrl.startsWith('/uploads/')) {
        const resolvedImg = path.resolve(PUBLIC_DIR, slip.imageUrl.replace(/^\/+/, ''));
        if (resolvedImg.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(resolvedImg)) {
          imgBase64 = fs.readFileSync(resolvedImg).toString('base64');
        }
      }

      if (hasApiKey && imgBase64) {
        try {
          const mesh = await detectPaperMeshWithGemini({
            base64Image: imgBase64,
            settings: db.settings,
            runnerLayout: savedLayout,
            customerName: slip.customerName
          });
          return sendJson(res, 200, { ok: true, source: 'gemini_vision', mesh });
        } catch (scanErr) {
          if (savedLayout && Array.isArray(savedLayout.tableQuad)) {
            return sendJson(res, 200, {
              ok: true,
              source: 'runner_memory',
              warning: scanErr.message,
              mesh: {
                rotationNeededDeg: savedLayout.preferredRotationDeg || 0,
                totalCols: savedLayout.totalCols || 4,
                rowsPerCol: savedLayout.rowsPerCol || 21,
                tableQuad: savedLayout.tableQuad,
                tableMids: savedLayout.tableMids || null,
                colSplits: savedLayout.colSplits || null,
                learnedCount: savedLayout.learnedCount || 1
              }
            });
          }
          return sendJson(res, 502, { ok: false, error: scanErr.message });
        }
      }

      if (savedLayout && Array.isArray(savedLayout.tableQuad)) {
        return sendJson(res, 200, {
          ok: true,
          source: 'runner_memory',
          mesh: {
            rotationNeededDeg: savedLayout.preferredRotationDeg || 0,
            totalCols: savedLayout.totalCols || 4,
            rowsPerCol: savedLayout.rowsPerCol || 21,
            tableQuad: savedLayout.tableQuad,
            tableMids: savedLayout.tableMids || null,
            colSplits: savedLayout.colSplits || null,
            learnedCount: savedLayout.learnedCount || 1
          }
        });
      }

      return sendJson(res, 200, {
        ok: false,
        needsManualOnce: true,
        message: 'ยังไม่พบ Gemini API Key และยังไม่เคยจำแบบฟอร์มของเด็กโพยคนนี้ — ปรับกรอบ 8 จุดครั้งแรกให้แถว 1 อยู่ใต้หัวตารางถึงแถวสุดท้ายเหนือรวม แล้วกด "📄 แปลงเป็นภาพเอกสารตรง" เพื่อให้ระบบจำไว้ใช้รอบหน้าอัตโนมัติครับ'
      });
    }

    // API: Re-run AI OCR on an Existing Slip Image (supports upright rotated image from client)
    if (req.method === 'POST' && /^\/api\/slips\/[^/]+\/reocr$/.test(pathname)) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', '').replace('/reocr', ''));
      const body = await parseJsonBody(req);
      const db = loadDb();
      const slip = (db.slips || []).find(s => s.id === slipId);
      if (!slip) return sendJson(res, 404, { ok: false, error: 'ไม่พบบิลนี้ในระบบ' });

      const hasApiKey = Boolean((db.settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim());
      if (!hasApiKey) {
        return sendJson(res, 400, {
          ok: false,
          error: 'ยังไม่ได้ตั้งค่า Gemini API Key — กรุณาไปใส่คีย์ในแท็บ 7. ตั้งค่า ➔ 2. โมเดล AI ก่อนกดอ่านใหม่'
        });
      }

      let imgBase64 = '';
      let clientSentPreRotated = false;
      if (typeof body.base64Image === 'string' && body.base64Image.startsWith('data:image/')) {
        imgBase64 = body.base64Image;
        clientSentPreRotated = true;
      } else if (slip.imageUrl && slip.imageUrl.startsWith('/uploads/')) {
        const relImg = slip.imageUrl.replace(/^\/+/, '');
        const resolvedImg = path.resolve(PUBLIC_DIR, relImg);
        if (resolvedImg.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(resolvedImg)) {
          imgBase64 = fs.readFileSync(resolvedImg).toString('base64');
        }
      }

      if (!imgBase64) {
        return sendJson(res, 400, { ok: false, error: 'ไม่พบไฟล์รูปภาพของบิลนี้สำหรับการอ่านใหม่' });
      }

      const ocrResult = await analyzeSlipImage({
        base64Image: imgBase64,
        settings: db.settings,
        learnedRules: db.learnedRules || [],
        customerName: slip.customerName,
        runnerLayout: db.runnerLayouts?.[slip.customerName] || null,
        allowDemoFallback: false
      });

      const items = (ocrResult.items || []).map(it => ({
        ...it,
        ocrOriginalNumText: it.ocrOriginalNumText || it.numText || '',
        ocrOriginalAmtText: it.ocrOriginalAmtText || it.amtText || '',
        box2d: it.box2d || null
      }));

      const maxRowInSlip = items.reduce((m, i) => Math.max(m, Number(i.row) || 1), 1);
      const maxColInSlip = items.reduce((m, i) => Math.max(m, Number(i.col) || 1), 1);

      slip.items = items;
      slip.rowsPerCol = Number(ocrResult.rowsPerCol) || maxRowInSlip;
      slip.isGrid4x30 = maxColInSlip <= 4 && Math.max(maxRowInSlip, slip.rowsPerCol) >= 25;
      slip.totalItems = items.filter(i => !i.isEmpty).length;
      slip.totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
      slip.reviewCount = items.filter(i => i.needsReview).length;
      if (ocrResult.tableBox && !slip.isFlattened) slip.tableBox = ocrResult.tableBox;
      if (ocrResult.tableQuad && !slip.isFlattened) slip.tableQuad = ocrResult.tableQuad;
      if (ocrResult.tableMids && !slip.isFlattened) slip.tableMids = ocrResult.tableMids;
      if (ocrResult.colSplits && !slip.isFlattened) slip.colSplits = ocrResult.colSplits;
      if (Array.isArray(ocrResult.columnSubtotals) && ocrResult.columnSubtotals.length > 0) {
        slip.columnSubtotals = normalizeColumnSubtotals(ocrResult.columnSubtotals);
      }
      if (ocrResult.sheetDate) slip.sheetDate = ocrResult.sheetDate;
      if (body.rotationDeg !== undefined) {
        slip.rotationDeg = ((Number(body.rotationDeg) || 0) % 360 + 360) % 360;
      } else if (!clientSentPreRotated && ocrResult.rotationNeededDeg) {
        slip.rotationDeg = ((Number(ocrResult.rotationNeededDeg) || 0) % 360 + 360) % 360;
      }
      slip.modelUsed = ocrResult.modelUsed;
      slip.ocrMode = ocrResult.mode;
      slip.usage = ocrResult.usage;
      slip.humanApproved = false;
      slip.approvedBy = null;
      slip.approvedAt = null;
      slip.status = slip.reviewCount > 0 ? 'needs_review' : 'ai_passed';

      appendAuditLog(
        db,
        getActorFromReq(req, body),
        'อ่านโพยด้วย AI ใหม่ (Re-OCR)',
        `อ่านโพย "${slip.customerName}" (${slip.title}) ใหม่สำเร็จ (${slip.totalItems} รายการ รวม ${slip.totalMoney.toLocaleString()} บาท)`
      );
      saveDb(db);
      return sendJson(res, 200, { ok: true, slip });
    }

    // API: Update / Verify a Slip & Auto-Learn Handwriting Corrections!
    if (req.method === 'PUT' && pathname.startsWith('/api/slips/')) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', ''));
      const body = await parseJsonBody(req);
      const db = loadDb();
      db.learnedRules = db.learnedRules || [];

      const slip = db.slips.find(s => s.id === slipId);
      if (!slip) return sendJson(res, 404, { error: 'ไม่พบบิลนี้ในระบบ' });

      if (body.rotationDeg !== undefined) {
        slip.rotationDeg = ((Number(body.rotationDeg) || 0) % 360 + 360) % 360;
        if (!Array.isArray(body.items) && !body.markVerified && body.customerName === undefined && body.title === undefined) {
          saveDb(db);
          return sendJson(res, 200, { ok: true, slip });
        }
      }

      if (Array.isArray(body.columnSubtotals)) {
        slip.columnSubtotals = normalizeColumnSubtotals(body.columnSubtotals);
        if (!Array.isArray(body.items) && !body.markVerified && !body.unverify) {
          appendAuditLog(
            db,
            getActorFromReq(req, body),
            'บันทึกยอดเทียบท้ายคอลัมน์',
            `ตั้งค่ายอด "รวม" ท้ายคอลัมน์ของ "${slip.customerName}" (${slip.title})`
          );
          saveDb(db);
          return sendJson(res, 200, { ok: true, slip });
        }
      }

      if (body.customerName !== undefined) slip.customerName = body.customerName;
      if (body.title !== undefined) slip.title = body.title;
      if (body.createdAt !== undefined) slip.createdAt = safeIsoDate(body.createdAt);

      // Compare previous items against edited items to automatically learn handwriting corrections!
      const prevMap = new Map();
      for (const oldIt of slip.items || []) {
        prevMap.set(`${oldIt.col}_${oldIt.row}`, oldIt);
      }

      const newlyLearned = [];

      if (Array.isArray(body.items)) {
        slip.items = body.items.map(it => {
          const key = `${it.col || 1}_${it.row || 1}`;
          const prev = prevMap.get(key);
          const origNum = prev?.ocrOriginalNumText || prev?.numText || '';
          const origAmt = prev?.ocrOriginalAmtText || prev?.amtText || '';

          const newNum = String(it.numText || '').trim();
          const newAmt = String(it.amtText || '').trim();

          // If admin corrected the number and it differs from what OCR originally read, learn it!
          if (origNum && newNum && origNum !== newNum) {
            const exists = db.learnedRules.some(
              r => r.customerName === slip.customerName && r.field === 'numText' && r.wrongText === origNum
            );
            if (!exists) {
              const rule = {
                id: `LEARN-${Date.now().toString().slice(-5)}-${it.col}${it.row}`,
                customerName: slip.customerName,
                roundNumber: slip.roundNumber || 1,
                field: 'numText',
                wrongText: origNum,
                correctText: newNum,
                reason: `แก้ในรอบที่ ${slip.roundNumber || 1} (คอลัมน์ ${it.col} แถว ${it.row})`,
                learnedAt: slip.createdAt || new Date().toISOString()
              };
              db.learnedRules.unshift(rule);
              newlyLearned.push(`${origNum} ➔ ${newNum}`);
            }
          }

          // If admin corrected the amount and it differs from what OCR originally read, learn it!
          if (origAmt && newAmt && origAmt !== newAmt) {
            const exists = db.learnedRules.some(
              r => r.customerName === slip.customerName && r.field === 'amtText' && r.wrongText === origAmt
            );
            if (!exists) {
              const rule = {
                id: `LEARN-${Date.now().toString().slice(-5)}-A${it.col}${it.row}`,
                customerName: slip.customerName,
                roundNumber: slip.roundNumber || 1,
                field: 'amtText',
                wrongText: origAmt,
                correctText: newAmt,
                reason: `แก้ยอดเงินในรอบที่ ${slip.roundNumber || 1} (คอลัมน์ ${it.col} แถว ${it.row})`,
                learnedAt: slip.createdAt || new Date().toISOString()
              };
              db.learnedRules.unshift(rule);
              newlyLearned.push(`${origAmt} ➔ ${newAmt}`);
            }
          }

          const parsed = parseAndValidateRow(
            {
              col: it.col || 1,
              row: it.row || 1,
              colHeader: it.colHeader || prev?.colHeader || '',
              categoryHint: it.categoryHint || prev?.categoryHint || '3_top',
              numText: newNum,
              amtText: newAmt,
              note: it.clearedNote ? '' : (it.note || ''),
              needsReview: false,
              confidence: 1.0
            },
            db.settings
          );

          return {
            ...parsed,
            colHeader: it.colHeader || prev?.colHeader || parsed.colHeader || '',
            categoryHint: it.categoryHint || prev?.categoryHint || parsed.categoryHint || '3_top',
            box2d: prev?.box2d || it.box2d || null,
            ocrOriginalNumText: newNum,
            ocrOriginalAmtText: newAmt
          };
        });
      }

      slip.totalItems = slip.items.filter(i => !i.isEmpty).length;
      slip.totalMoney = slip.items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
      slip.reviewCount = slip.items.filter(i => i.needsReview).length;

      const actorName = getActorFromReq(req, body);
      if (body.markVerified) {
        slip.items.forEach(i => {
          i.needsReview = false;
        });
        slip.reviewCount = 0;
        slip.humanApproved = true;
        slip.approvedBy = actorName;
        slip.approvedAt = new Date().toISOString();
        slip.status = 'human_verified';
        appendAuditLog(
          db,
          actorName,
          'ยืนยันความถูกต้องบิล',
          `กดยืนยันยอดบิลของ "${slip.customerName}" (${slip.title}) ยอดรวม ${slip.totalMoney.toLocaleString()} บาท (นำเข้า Pool แล้ว)`
        );
      } else if (body.unverify) {
        slip.humanApproved = false;
        slip.approvedBy = null;
        slip.approvedAt = null;
        slip.status = slip.reviewCount > 0 ? 'needs_review' : 'ai_passed';
        appendAuditLog(
          db,
          actorName,
          'ยกเลิกการยืนยันบิล',
          `ยกเลิกการยืนยันและดึงบิลของ "${slip.customerName}" (${slip.title}) ออกจาก Pool ชั่วคราว`
        );
      } else {
        if (slip.reviewCount > 0) {
          slip.status = 'needs_review';
          slip.humanApproved = false;
        } else if (!slip.humanApproved) {
          slip.status = 'ai_passed';
        } else {
          slip.status = 'human_verified';
        }
        appendAuditLog(
          db,
          actorName,
          'แก้ไขตัวเลขในบิล',
          `แก้ไขข้อมูลโพยของ "${slip.customerName}" (${slip.title})${newlyLearned.length > 0 ? ` [${newlyLearned.join(', ')}]` : ''} ยอดรวม ${slip.totalMoney.toLocaleString()} บาท`
        );
      }

      saveDb(db);
      return sendJson(res, 200, {
        ok: true,
        slip,
        newlyLearnedCount: newlyLearned.length,
        newlyLearned
      });
    }

    // API: Delete a Slip
    if (req.method === 'DELETE' && pathname.startsWith('/api/slips/')) {
      if (!requireAdmin(req, res)) return;
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', ''));
      const db = loadDb();
      const target = (db.slips || []).find(s => s.id === slipId);
      if (!target) {
        return sendJson(res, 404, { ok: false, error: 'ไม่พบบิลนี้ในระบบ' });
      }
      db.slips = db.slips.filter(s => s.id !== slipId);
      if (
        target.imageUrl &&
        target.imageUrl.startsWith('/uploads/') &&
        target.imageUrl !== '/uploads/slip-16-11-page1.jpg'
      ) {
        const stillUsed = db.slips.some(s => s.imageUrl === target.imageUrl);
        if (!stillUsed) {
          const relImg = target.imageUrl.replace(/^\/+/, '');
          const resolvedImg = path.resolve(PUBLIC_DIR, relImg);
          if (resolvedImg.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(resolvedImg)) {
            try {
              fs.unlinkSync(resolvedImg);
            } catch {}
          }
        }
      }
      appendAuditLog(
        db,
        getActorFromReq(req),
        'ลบบิลโพย',
        `ลบบิลของ "${target.customerName}" (${target.title}) ยอด ${(target.totalMoney || 0).toLocaleString()} บาท`
      );
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    // API: Mark LINE Chats Read / Unread
    if (req.method === 'POST' && pathname === '/api/line/mark-read') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      db.lineReadAt = db.lineReadAt || {};
      const nowIso = new Date().toISOString();

      if (body.markAll) {
        const targetDrawId = body.drawId || db.currentDrawId;
        const names = new Set(
          (db.lineChats || [])
            .filter(m => !targetDrawId || (m.drawId || db.currentDrawId) === targetDrawId)
            .map(m => String(m.customerName || '').trim())
            .filter(Boolean)
        );
        for (const name of names) {
          db.lineReadAt[name] = nowIso;
        }
      } else if (body.customerName) {
        const cname = String(body.customerName || '').trim();
        if (cname) {
          if (body.unread === true) {
            delete db.lineReadAt[cname];
          } else {
            db.lineReadAt[cname] = nowIso;
          }
        }
      }

      saveDb(db);
      return sendJson(res, 200, { ok: true, lineReadAt: db.lineReadAt });
    }

    // API: LINE Simulator / Key-in Thread (Automatically increments Round Number for the runner & reports cumulative total!)
    if (req.method === 'POST' && pathname === '/api/line/simulate') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const currentDraw = db.draws.find(d => d.id === (body.drawId || db.currentDrawId)) || db.draws[0];
      const customerName = (body.customerName || 'ลูกค้า LINE').trim();
      const text = (body.text || '').trim();
      const useSamplePhoto = Boolean(body.useSamplePhoto);
      const base64Image = body.base64Image || '';
      const submittedAt = body.submittedAt ? safeIsoDate(body.submittedAt) : new Date().toISOString();

      const nextRound = getNextRoundForCustomer(db.slips, currentDraw.id, customerName);

      if (useSamplePhoto || base64Image) {
        let savedImageUrl = '/uploads/slip-16-11-page1.jpg';
        if (base64Image && base64Image.startsWith('data:image/')) {
          const matches = base64Image.match(/^data:(image\/(\w+));base64,(.+)$/);
          if (matches) {
            const ext = matches[2] === 'png' ? 'png' : 'jpg';
            const fileName = `line-slip-${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(UPLOADS_DIR, fileName), Buffer.from(matches[3], 'base64'));
            savedImageUrl = `/uploads/${fileName}`;
          }
        }

        db.lineChats.push({
          id: `MSG-${Date.now()}-1`,
          drawId: currentDraw.id,
          customerName,
          sender: 'customer',
          type: 'image',
          imageUrl: savedImageUrl,
          text: text || `ส่งรูปโพย รอบที่ ${nextRound}`,
          timestamp: submittedAt
        });

        const ocrResult = await analyzeSlipImage({
          base64Image: base64Image || fs.readFileSync(path.join(UPLOADS_DIR, 'slip-16-11-page1.jpg')).toString('base64'),
          settings: db.settings,
          learnedRules: db.learnedRules || [],
          customerName,
          runnerLayout: db.runnerLayouts?.[customerName] || null,
          allowDemoFallback: Boolean(useSamplePhoto && !base64Image)
        });

        const items = ocrResult.items || [];
        const maxRowInSlip = items.reduce((m, i) => Math.max(m, Number(i.row) || 1), 1);
        const maxColInSlip = items.reduce((m, i) => Math.max(m, Number(i.col) || 1), 1);
        const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
        const reviewCount = items.filter(i => i.needsReview).length;

        const newSlip = {
          id: `SLIP-${Date.now().toString().slice(-6)}`,
          drawId: currentDraw.id,
          roundNumber: nextRound,
          title: `รอบที่ ${nextRound} — โพยรูป LINE`,
          sheetDate: ocrResult.sheetDate || '16/11',
          sheetPage: String(nextRound),
          customerName,
          customerLineId: `U_${customerName}`,
          source: 'LINE รูปโพยกระดาษ',
          imageUrl: savedImageUrl,
          tableBox: ocrResult.tableBox || db.runnerLayouts?.[customerName]?.tableBox || null,
          tableQuad: ocrResult.tableQuad || db.runnerLayouts?.[customerName]?.tableQuad || null,
          tableMids: ocrResult.tableMids || db.runnerLayouts?.[customerName]?.tableMids || null,
          colSplits: ocrResult.colSplits || db.runnerLayouts?.[customerName]?.colSplits || null,
          columnSubtotals: normalizeColumnSubtotals(ocrResult.columnSubtotals),
          rowsPerCol: Number(ocrResult.rowsPerCol) || maxRowInSlip,
          isGrid4x30: maxColInSlip <= 4 && Math.max(maxRowInSlip, Number(ocrResult.rowsPerCol) || 0) >= 25,
          status: reviewCount > 0 ? 'needs_review' : 'ai_passed',
          humanApproved: false,
          approvedBy: null,
          approvedAt: null,
          modelUsed: ocrResult.modelUsed,
          totalItems: items.filter(i => !i.isEmpty).length,
          totalMoney,
          reviewCount,
          createdAt: submittedAt,
          items
        };

        db.slips.push(newSlip);

        const customerTotalCumulative = db.slips
          .filter(s => s.drawId === currentDraw.id && s.customerName === customerName)
          .reduce((sum, s) => sum + (s.totalMoney || 0), 0);

        const restrictedHits = [];
        for (const it of items) {
          const ev = evaluateNumberRestriction(it.baseNumber, submittedAt, currentDraw.restrictedNumbers);
          if (ev.isRestrictedNumber && !ev.isBeforeCutoff) {
            restrictedHits.push(`${it.baseNumber} (จ่าย ${ev.payoutPercentForThisSlip}%)`);
          }
        }
        const uniqueHits = Array.from(new Set(restrictedHits));

        const botReply =
          `✅ รับรูปโพย ${customerName} — รอบที่ ${nextRound} (${currentDraw.title})\n` +
          `📋 อ่านได้ทั้งหมด: ${newSlip.totalItems} รายการ | ยอดรอบนี้: ${totalMoney.toLocaleString()} บาท\n` +
          (uniqueHits.length > 0
            ? `🔒 มีเลขอั้นในรอบนี้ (ส่งหลังเวลาประกาศ): ${uniqueHits.join(', ')}\n`
            : `🟢 เรทจ่ายรอบนี้: จ่ายเต็ม 100% ทุกรายการ\n`) +
          `📊 ยอดสะสมรวมของ ${customerName} (รวม ${nextRound} รอบ): ${customerTotalCumulative.toLocaleString()} บาท`;

        db.lineChats.push({
          id: `MSG-${Date.now()}-2`,
          drawId: currentDraw.id,
          customerName,
          sender: 'bot',
          type: 'text',
          text: botReply,
          timestamp: new Date().toISOString()
        });

        saveDb(db);
        return sendJson(res, 200, { ok: true, slip: newSlip, botReply });
      } else {
        db.lineChats.push({
          id: `MSG-${Date.now()}-1`,
          drawId: currentDraw.id,
          customerName,
          sender: 'customer',
          type: 'text',
          text,
          timestamp: submittedAt
        });

        const items = parseFreeTextMessage(text, db.settings);
        if (items.length === 0) {
          const errReply = `❌ ไม่พบรูปแบบตัวเลขในข้อความ กรุณาพิมพ์เช่น:\n21 = 22\n072x6 = 66\n583 = 55x55`;
          db.lineChats.push({
            id: `MSG-${Date.now()}-2`,
            drawId: currentDraw.id,
            customerName,
            sender: 'bot',
            type: 'text',
            text: errReply,
            timestamp: new Date().toISOString()
          });
          saveDb(db);
          return sendJson(res, 200, { ok: false, botReply: errReply });
        }

        const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
        const reviewCount = items.filter(i => i.needsReview).length;

        const newSlip = {
          id: `SLIP-${Date.now().toString().slice(-6)}`,
          drawId: currentDraw.id,
          roundNumber: nextRound,
          title: `รอบที่ ${nextRound} — ข้อความ LINE (${items.length} รายการ)`,
          sheetDate: '16/11',
          sheetPage: String(nextRound),
          customerName,
          customerLineId: `U_${customerName}`,
          source: 'LINE ข้อความ',
          imageUrl: '',
          isGrid4x30: false,
          status: reviewCount > 0 ? 'needs_review' : 'ai_passed',
          humanApproved: false,
          approvedBy: null,
          approvedAt: null,
          modelUsed: 'ระบบอ่านข้อความอัตโนมัติ',
          totalItems: items.length,
          totalMoney,
          reviewCount,
          createdAt: submittedAt,
          items
        };

        db.slips.push(newSlip);

        const customerTotalCumulative = db.slips
          .filter(s => s.drawId === currentDraw.id && s.customerName === customerName)
          .reduce((sum, s) => sum + (s.totalMoney || 0), 0);

        const linesSummary = items.map(it => {
          const ev = evaluateNumberRestriction(it.baseNumber, submittedAt, currentDraw.restrictedNumbers);
          const rateTag =
            ev.isRestrictedNumber && !ev.isBeforeCutoff
              ? ` 🔒 [เลขอั้น จ่าย ${ev.payoutPercentForThisSlip}%]`
              : ev.isRestrictedNumber && ev.isBeforeCutoff
                ? ` 🟢 [ส่งก่อนอั้น ได้เต็ม 100%]`
                : ` 🟢 [จ่ายเต็ม 100%]`;
          return `• ${it.numText} (${it.patternLabel}) = ${it.rowTotalMoney.toLocaleString()} บาท${rateTag}`;
        });

        const botReply =
          `✅ รับโพย ${customerName} — รอบที่ ${nextRound} (${currentDraw.title})\n` +
          linesSummary.join('\n') +
          `\n💰 ยอดรอบนี้: ${totalMoney.toLocaleString()} บาท\n` +
          `📊 ยอดสะสมรวมของ ${customerName} (รวม ${nextRound} รอบ): ${customerTotalCumulative.toLocaleString()} บาท`;

        db.lineChats.push({
          id: `MSG-${Date.now()}-2`,
          drawId: currentDraw.id,
          customerName,
          sender: 'bot',
          type: 'text',
          text: botReply,
          timestamp: new Date().toISOString()
        });

        saveDb(db);
        return sendJson(res, 200, { ok: true, slip: newSlip, botReply });
      }
    }

    // API: Real LINE Messaging API Webhook (Automatically rolls over to next GLO draw if previous draw has passed!)
    if (req.method === 'POST' && pathname === '/api/line/webhook') {
      const rawBuf = await readRawBodyBuffer(req);
      const db = loadDb();
      const channelSecret = (db.settings.lineChannelSecret || process.env.LINE_CHANNEL_SECRET || '').trim();
      if (!channelSecret) {
        return sendJson(res, 503, { error: 'LINE Webhook is not configured' });
      }
      const sigHeader = String(req.headers['x-line-signature'] || '');
      const expectedSig = crypto.createHmac('sha256', channelSecret).update(rawBuf).digest('base64');
      const a = Buffer.from(sigHeader, 'utf8');
      const b = Buffer.from(expectedSig, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return sendJson(res, 401, { error: 'Invalid X-Line-Signature' });
      }
      let body = {};
      try {
        const rawStr = rawBuf.toString('utf8');
        body = rawStr ? JSON.parse(rawStr) : {};
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON payload' });
      }

      const events = Array.isArray(body.events) ? body.events : [];
      if (events.length === 0) {
        return sendJson(res, 200, { status: 'ok' });
      }

      const nowIso = new Date().toISOString();
      const resolved = resolveTargetDrawForSubmission(db, nowIso, db.currentDrawId, true);
      const currentDraw = resolved.draw;
      const token = (db.settings.lineChannelAccessToken || process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
      db.lineChats = db.lineChats || [];

      for (const ev of events) {
        if (ev.type === 'message' && ev.message) {
          const replyToken = ev.replyToken;
          const userId = ev.source?.userId || 'LINE_USER';
          const customerName = await resolveLineDisplayName(ev, token);
          const nextRound = getNextRoundForCustomer(db.slips, currentDraw.id, customerName);
          let replyText = '';

          if (resolved.rejectedClosed) {
            if (ev.message.type === 'text' && ev.message.text) {
              db.lineChats.push({
                id: `MSG-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                drawId: currentDraw.id,
                customerName,
                sender: 'customer',
                type: 'text',
                text: ev.message.text,
                timestamp: nowIso
              });
            }
            replyText = resolved.rejectMessage;
          } else if (ev.message.type === 'image' && token) {
            const imgRes = await fetch(`https://api-data.line.me/v2/bot/message/${ev.message.id}/content`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            if (imgRes.ok) {
              const arrayBuf = await imgRes.arrayBuffer();
              const buf = Buffer.from(arrayBuf);
              const fileName = `line-webhook-${Date.now()}.jpg`;
              fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buf);
              const imageUrl = `/uploads/${fileName}`;

              db.lineChats.push({
                id: `MSG-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                drawId: currentDraw.id,
                customerName,
                sender: 'customer',
                type: 'image',
                imageUrl,
                text: `ส่งรูปโพย รอบที่ ${nextRound}`,
                timestamp: nowIso
              });

              const hasApiKey = Boolean((db.settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim());
              let ocrResult = null;
              let ocrErrorMsg = '';
              if (hasApiKey) {
                try {
                  ocrResult = await analyzeSlipImage({
                    base64Image: buf.toString('base64'),
                    settings: db.settings,
                    learnedRules: db.learnedRules || [],
                    customerName,
                    runnerLayout: db.runnerLayouts?.[customerName] || null,
                    allowDemoFallback: false
                  });
                } catch (ocrErr) {
                  ocrErrorMsg = ocrErr.message;
                  console.error('LINE webhook OCR error:', ocrErr.message);
                }
              }

              if (ocrResult && ocrResult.mode === 'live_gemini') {
                const items = (ocrResult.items || []).map(it => ({
                  ...it,
                  ocrOriginalNumText: it.ocrOriginalNumText || it.numText || '',
                  ocrOriginalAmtText: it.ocrOriginalAmtText || it.amtText || '',
                  box2d: it.box2d || null
                }));
                const maxRowInSlip = items.reduce((m, i) => Math.max(m, Number(i.row) || 1), 1);
                const maxColInSlip = items.reduce((m, i) => Math.max(m, Number(i.col) || 1), 1);
                const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
                const reviewCount = items.filter(i => i.needsReview).length;

                const newSlip = {
                  id: `SLIP-${Date.now().toString().slice(-6)}`,
                  drawId: currentDraw.id,
                  roundNumber: nextRound,
                  title: `รอบที่ ${nextRound} — โพยรูป LINE`,
                  sheetDate: ocrResult.sheetDate || '16/11',
                  sheetPage: String(nextRound),
                  customerName,
                  customerLineId: userId,
                  source: 'LINE รูปโพยกระดาษ',
                  imageUrl,
                  rotationDeg: Number(ocrResult.rotationNeededDeg) || 0,
                  tableBox: ocrResult.tableBox || db.runnerLayouts?.[customerName]?.tableBox || null,
                  tableQuad: ocrResult.tableQuad || db.runnerLayouts?.[customerName]?.tableQuad || null,
                  tableMids: ocrResult.tableMids || db.runnerLayouts?.[customerName]?.tableMids || null,
                  colSplits: ocrResult.colSplits || db.runnerLayouts?.[customerName]?.colSplits || null,
                  columnSubtotals: normalizeColumnSubtotals(ocrResult.columnSubtotals),
                  rowsPerCol: Number(ocrResult.rowsPerCol) || maxRowInSlip,
                  isGrid4x30: maxColInSlip <= 4 && Math.max(maxRowInSlip, Number(ocrResult.rowsPerCol) || 0) >= 25,
                  status: reviewCount > 0 ? 'needs_review' : 'ai_passed',
                  humanApproved: false,
                  approvedBy: null,
                  approvedAt: null,
                  modelUsed: ocrResult.modelUsed,
                  ocrMode: ocrResult.mode,
                  usage: ocrResult.usage,
                  totalItems: items.filter(i => !i.isEmpty).length,
                  totalMoney,
                  reviewCount,
                  createdAt: nowIso,
                  items
                };
                db.slips.push(newSlip);
                appendAuditLog(
                  db,
                  customerName,
                  'รับโพยรูปจาก LINE',
                  `รับโพยรูปของ "${customerName}" (รอบที่ ${nextRound}) จำนวน ${newSlip.totalItems} รายการ ยอด ${totalMoney.toLocaleString()} บาท`
                );

                const restrictedHits = [];
                for (const it of items) {
                  if (it.isEmpty || !it.baseNumber) continue;
                  const rEval = evaluateNumberRestriction(it.baseNumber, nowIso, currentDraw.restrictedNumbers);
                  if (rEval.isRestrictedNumber && !rEval.isBeforeCutoff) {
                    restrictedHits.push(`${it.baseNumber} (${rEval.payoutPercentForThisSlip}%)`);
                  }
                }
                const uniqueHits = Array.from(new Set(restrictedHits));
                const cumTotal = db.slips
                  .filter(s => s.drawId === currentDraw.id && s.customerName === customerName)
                  .reduce((sum, s) => sum + (s.totalMoney || 0), 0);
                replyText =
                  `✅ รับโพย ${customerName} — รอบที่ ${nextRound} (${currentDraw.title})\n` +
                  `📋 อ่านได้ทั้งหมด: ${newSlip.totalItems} รายการ | ยอดรอบนี้: ${totalMoney.toLocaleString()} บาท\n` +
                  (uniqueHits.length > 0
                    ? `🔒 เลขอั้นในรอบนี้: ${uniqueHits.join(', ')}\n`
                    : `🟢 เรทจ่ายรอบนี้: จ่ายเต็ม 100% ทุกรายการ\n`) +
                  `📊 ยอดสะสมรวม ${nextRound} รอบ = ${cumTotal.toLocaleString()} บาท`;
              } else {
                const pendingSlip = {
                  id: `SLIP-${Date.now().toString().slice(-6)}`,
                  drawId: currentDraw.id,
                  roundNumber: nextRound,
                  title: `รอบที่ ${nextRound} — โพยรูป LINE`,
                  sheetDate: '',
                  sheetPage: String(nextRound),
                  customerName,
                  customerLineId: userId,
                  source: 'LINE รูปโพยกระดาษ',
                  imageUrl,
                  rotationDeg: 0,
                  isGrid4x30: true,
                  status: 'pending_antigravity',
                  humanApproved: false,
                  approvedBy: null,
                  approvedAt: null,
                  modelUsed: hasApiKey
                    ? `อ่านไม่สำเร็จชั่วคราว (${ocrErrorMsg || 'กรุณากดอ่านใหม่'})`
                    : 'รอตั้งค่า Gemini API Key / รอ Antigravity อ่าน',
                  ocrMode: 'pending_ocr',
                  totalItems: 0,
                  totalMoney: 0,
                  reviewCount: 0,
                  createdAt: nowIso,
                  items: []
                };
                db.slips.push(pendingSlip);
                appendAuditLog(
                  db,
                  customerName,
                  'รับโพยรูปจาก LINE (รออ่านตัวเลข)',
                  `ได้รับรูปโพยของ "${customerName}" (รอบที่ ${nextRound}) เก็บเข้าระบบรออ่านตัวเลขแล้ว`
                );
                replyText =
                  `📥 ได้รับรูปโพยของ ${customerName} — รอบที่ ${nextRound} (${currentDraw.title}) แล้วครับ\n` +
                  `⏳ กำลังรอระบบตรวจสอบและอ่านตัวเลข`;
              }
            }
          } else if (ev.message.type === 'text') {
            const rawText = String(ev.message.text || '');
            db.lineChats.push({
              id: `MSG-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              drawId: currentDraw.id,
              customerName,
              sender: 'customer',
              type: 'text',
              text: rawText,
              timestamp: nowIso
            });

            const items = parseFreeTextMessage(rawText, db.settings);
            if (items.length > 0) {
              const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
              const newSlip = {
                id: `SLIP-${Date.now().toString().slice(-6)}`,
                drawId: currentDraw.id,
                roundNumber: nextRound,
                title: `รอบที่ ${nextRound} — ข้อความ LINE`,
                sheetDate: '16/11',
                sheetPage: String(nextRound),
                customerName,
                customerLineId: userId,
                source: 'LINE ข้อความ',
                imageUrl: '',
                isGrid4x30: false,
                status: 'ai_passed',
                humanApproved: false,
                approvedBy: null,
                approvedAt: null,
                modelUsed: 'ระบบอ่านข้อความ',
                totalItems: items.length,
                totalMoney,
                reviewCount: 0,
                createdAt: nowIso,
                items
              };
              db.slips.push(newSlip);
              appendAuditLog(
                db,
                customerName,
                'รับโพยข้อความจาก LINE',
                `รับโพยข้อความของ "${customerName}" (รอบที่ ${nextRound}) จำนวน ${items.length} รายการ ยอด ${totalMoney.toLocaleString()} บาท`
              );

              const restrictedHits = [];
              for (const it of items) {
                if (it.isEmpty || !it.baseNumber) continue;
                const rEval = evaluateNumberRestriction(it.baseNumber, nowIso, currentDraw.restrictedNumbers);
                if (rEval.isRestrictedNumber && !rEval.isBeforeCutoff) {
                  restrictedHits.push(`${it.baseNumber} (${rEval.payoutPercentForThisSlip}%)`);
                }
              }
              const uniqueHits = Array.from(new Set(restrictedHits));
              const cumTotal = db.slips
                .filter(s => s.drawId === currentDraw.id && s.customerName === customerName)
                .reduce((sum, s) => sum + (s.totalMoney || 0), 0);
              replyText =
                `✅ บันทึกรอบที่ ${nextRound} (${currentDraw.title})\n` +
                `📋 ${items.length} รายการ = ${totalMoney.toLocaleString()} บาท\n` +
                (uniqueHits.length > 0
                  ? `🔒 เลขอั้นในรอบนี้: ${uniqueHits.join(', ')}\n`
                  : `🟢 เรทจ่าย: จ่ายเต็ม 100%\n`) +
                `📊 ยอดสะสมรวม ${nextRound} รอบ = ${cumTotal.toLocaleString()} บาท`;
            }
          }

          if (replyText) {
            db.lineChats.push({
              id: `MSG-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              drawId: currentDraw.id,
              customerName,
              sender: 'bot',
              type: 'text',
              text: replyText,
              timestamp: new Date().toISOString()
            });
          }

          if (replyText && replyToken && token) {
            try {
              await fetch('https://api.line.me/v2/bot/message/reply', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({
                  replyToken,
                  messages: [{ type: 'text', text: replyText }]
                }),
                signal: AbortSignal.timeout(5000)
              });
            } catch (replyErr) {
              console.error('LINE reply error:', replyErr.message);
            }
          }
        }
      }

      saveDb(db);
      return sendJson(res, 200, { status: 'ok' });
    }

    // API: Save Dealer Layoff Bill (ทยอยส่งเจ้ามือเป็นรอบๆ + บันทึกยอดส่งและยอดเก็บไว้ที่เราเพื่อไม่ให้ส่งซ้ำ)
    if (req.method === 'POST' && pathname === '/api/layoffs') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const drawId = body.drawId || db.currentDrawId;
      const existingInDraw = (db.layoffs || []).filter(l => (l.drawId || drawId) === drawId);
      const roundNumber = existingInDraw.length + 1;

      const dealerName = (body.dealerName || 'เจ้ามือสายใหญ่ #1').trim();
      const items = (body.items || [])
        .map(it => ({
          number: String(it.number || '').trim(),
          sendTotal: Math.max(0, Number(it.sendTotal) || 0),
          keepTotal: Math.max(0, Number(it.keepTotal) || 0),
          isRestricted: Boolean(it.isRestricted),
          payoutPercent: Number(it.payoutPercent) || 100,
          typeDesc: it.typeDesc || ''
        }))
        .filter(it => it.number && it.sendTotal > 0);

      const totalLayoffMoney = items.reduce((s, i) => s + i.sendTotal, 0);
      const totalKeptMoney = items.reduce((s, i) => s + i.keepTotal, 0);

      const newLayoff = {
        id: `LAYOFF-${Date.now().toString().slice(-6)}`,
        drawId,
        roundNumber,
        dealerName,
        itemCount: items.length,
        sentItemCount: items.filter(i => i.sendTotal > 0).length,
        keptItemCount: items.filter(i => i.keepTotal > 0).length,
        totalLayoffMoney,
        totalKeptMoney,
        formattedText: body.formattedText || '',
        items,
        createdAt: new Date().toISOString()
      };

      db.layoffs = db.layoffs || [];
      db.layoffs.push(newLayoff);
      appendAuditLog(
        db,
        getActorFromReq(req, body),
        'ตัดยอดส่งเจ้ามือ',
        `ยืนยันส่ง "${dealerName}" (รอบที่ ${roundNumber}) จำนวน ${newLayoff.sentItemCount} เลข ยอดส่ง ${totalLayoffMoney.toLocaleString()} บาท | เก็บไว้ที่เรา ${totalKeptMoney.toLocaleString()} บาท`
      );
      saveDb(db);
      return sendJson(res, 200, { ok: true, layoff: newLayoff });
    }

    // API: Delete / Undo a Layoff Round
    if (req.method === 'DELETE' && pathname.startsWith('/api/layoffs/')) {
      if (!requireAdmin(req, res)) return;
      const layoffId = decodeURIComponent(pathname.replace('/api/layoffs/', ''));
      const db = loadDb();
      const target = (db.layoffs || []).find(l => l.id === layoffId);
      if (!target) {
        return sendJson(res, 404, { ok: false, error: 'ไม่พบรอบส่งเจ้ามือนี้ในระบบ' });
      }
      db.layoffs = (db.layoffs || []).filter(l => l.id !== layoffId);
      appendAuditLog(
        db,
        getActorFromReq(req),
        'ยกเลิกรอบส่งเจ้ามือ',
        `ยกเลิกส่ง "${target.dealerName}" (รอบที่ ${target.roundNumber || 1}) ยอดส่ง ${(target.totalLayoffMoney || 0).toLocaleString()} บาท`
      );
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    let decodedPathname = '/';
    try {
      decodedPathname = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bad Request');
    }

    const sessionUser = getSessionUser(req);
    let relPath = decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^\/+/, '');
    if ((decodedPathname === '/' || relPath === 'index.html') && !sessionUser) {
      relPath = 'login.html';
    }

    const filePath = path.resolve(PUBLIC_DIR, relPath);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }

    // Protect all internal app files and uploaded slips when unauthenticated (hide existence via 404)
    const isProtectedAsset =
      relPath === 'app.js' ||
      relPath === 'styles.css' ||
      relPath === 'mascot-logo.jpg' ||
      relPath === 'index.html' ||
      relPath === 'uploads' ||
      relPath.startsWith('uploads/') ||
      filePath === UPLOADS_DIR ||
      filePath.startsWith(UPLOADS_DIR + path.sep);

    if (isProtectedAsset && !sessionUser) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex'
      });
      return res.end('Not Found');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex'
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) {
      console.error('Server error:', err.message);
    }
    sendJson(res, code, { error: code === 413 ? 'Payload Too Large (Max 25MB)' : (err.message || 'Internal Server Error') });
  }
});

server.listen(PORT, () => {
  console.log(`Lottery OCR Pro Server running at http://localhost:${PORT}`);
});
