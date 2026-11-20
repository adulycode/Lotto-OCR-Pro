const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const fs = require('fs');
const path = require('path');

const { RAW_COLUMNS_16_11 } = require('./seedData');
const {
  parseAndValidateRow,
  parseFreeTextMessage,
  evaluateNumberRestriction,
  aggregateSlips
} = require('./lotteryEngine');
const { analyzeSlipImage } = require('./geminiOcr');

const PORT = process.env.PORT || 3088;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function buildInitialDb() {
  const defaultSettings = {
    geminiModel: 'gemini-2.5-pro',
    geminiApiKey: '',
    permutationMode: 'expand', // 'expand' = แยกเลขทุกประตู, 'keep_raw' = คงตามหน้าโพย
    useColumnSlicing: true,
    checkMultiplesOf11: true,
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

  // Timestamps to clearly demonstrate the Before-Cutoff (100%) vs After-Cutoff (50%) rule:
  // 1) เจ๊หมวย & เฮียพงษ์ sent on 14 พ.ย. (2 days before draw -> BEFORE dealer announced 50% cutoff) => Gets 100%!
  // 2) Dealer announced 5 restricted numbers (21, 583, 154, 072, 860) on 15 พ.ย. 14:00 น. (1 day before draw) => After this time gets 50%!
  // 3) ป้านิด sent on 15 พ.ย. 16:30 น. (AFTER dealer announcement) => Numbers 21 and 860 in her bill get 50%!
  const timeBeforeCutoff1 = '2026-11-14T10:15:00.000Z';
  const timeBeforeCutoff2 = '2026-11-14T15:30:00.000Z';
  const timeDealerCutoffAnnouncement = '2026-11-15T07:00:00.000Z'; // 14:00 น. เวลาไทย (ก่อนหวยออก 1 วัน)
  const timeAfterCutoff3 = '2026-11-15T09:45:00.000Z';             // 16:45 น. เวลาไทย (ส่งหลังประกาศอั้น -> ได้ 50%)

  const draws = [
    {
      id: 'DRAW-2026-11-16',
      title: 'งวดวันที่ 16 พ.ย. 2569',
      drawDate: '2026-11-16',
      status: 'open', // 'open' = เปิดรับแทง, 'closed' = ปิดงวดแล้ว
      // เลขอั้น 5 ชุดที่เจ้ามือแจ้งก่อนวันหวยออก 1 วัน (แทงก่อนเวลาประกาศได้ 100% / แทงหลังเวลาประกาศได้ 50%)
      restrictedNumbers: [
        { number: '21', payoutPercent: 50, announcedAt: timeDealerCutoffAnnouncement, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' },
        { number: '583', payoutPercent: 50, announcedAt: timeDealerCutoffAnnouncement, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' },
        { number: '154', payoutPercent: 50, announcedAt: timeDealerCutoffAnnouncement, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' },
        { number: '072', payoutPercent: 50, announcedAt: timeDealerCutoffAnnouncement, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' },
        { number: '860', payoutPercent: 50, announcedAt: timeDealerCutoffAnnouncement, note: 'เจ้ามือแจ้งอั้นจ่ายครึ่ง 50%' }
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

  // Slip 1: โพยกระดาษ 16/11 แผ่นที่ 1 (120 รายการ) - ส่งเมื่อ 14 พ.ย. (ก่อนอั้น -> ได้ 100% ทั้งใบ)
  const slip1Items = [];
  for (const colNum of [1, 2, 3, 4]) {
    for (const r of RAW_COLUMNS_16_11[colNum]) {
      slip1Items.push(
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
  const slip1Total = slip1Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  // Slip 2: เฮียพงษ์ ส่งเมื่อ 14 พ.ย. (ก่อนเวลาเจ้ามือประกาศอั้น -> เลข 21 = 22 บาท และ 583 ได้เต็ม 100%!)
  const slip2Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '21', amtText: '22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 2, numText: '583', amtText: '55×55', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 3, numText: '154', amtText: '22×22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 4, numText: '072', amtText: '33', confidence: 0.99 }, defaultSettings)
  ];
  const slip2Total = slip2Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  // Slip 3: ป้านิด ส่งเมื่อ 15 พ.ย. 16:45 น. (หลังเวลาเจ้ามือประกาศอั้น -> เลข 21 = 20 บาท และ 860 ได้จ่ายครึ่ง 50%!)
  const slip3Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '21', amtText: '20', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 2, numText: '860', amtText: '22×22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 3, numText: '289', amtText: '22×11', confidence: 0.99 }, defaultSettings)
  ];
  const slip3Total = slip3Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  return {
    currentDrawId: 'DRAW-2026-11-16',
    draws,
    settings: defaultSettings,
    slips: [
      {
        id: 'SLIP-1611-001',
        drawId: 'DRAW-2026-11-16',
        title: 'โพยกระดาษ แผ่นที่ 1 (120 แถว)',
        sheetDate: '16/11',
        sheetPage: '1',
        customerName: 'เจ๊หมวย (สาย A)',
        customerLineId: 'U_muay_line_01',
        source: 'LINE รูปโพยกระดาษ',
        imageUrl: '/uploads/slip-16-11-page1.jpg',
        isGrid4x30: true,
        status: 'needs_review',
        modelUsed: 'gemini-2.5-pro',
        totalItems: slip1Items.filter(i => !i.isEmpty).length,
        totalMoney: slip1Total,
        reviewCount: slip1Items.filter(i => i.needsReview).length,
        createdAt: timeBeforeCutoff1,
        items: slip1Items
      },
      {
        id: 'SLIP-1611-002',
        drawId: 'DRAW-2026-11-16',
        title: 'บิล LINE #2 (ส่งก่อนอั้น — จ่าย 100%)',
        sheetDate: '16/11',
        sheetPage: '-',
        customerName: 'เฮียพงษ์ (ลูกค้า LINE)',
        customerLineId: 'U_pong_line_02',
        source: 'LINE ข้อความ',
        imageUrl: '',
        isGrid4x30: false,
        status: 'verified',
        modelUsed: 'gemini-2.5-pro',
        totalItems: slip2Items.length,
        totalMoney: slip2Total,
        reviewCount: 0,
        createdAt: timeBeforeCutoff2,
        items: slip2Items
      },
      {
        id: 'SLIP-1611-003',
        drawId: 'DRAW-2026-11-16',
        title: 'บิล LINE #3 (ส่งหลังประกาศอั้น — เลขอั้นจ่าย 50%)',
        sheetDate: '16/11',
        sheetPage: '-',
        customerName: 'ป้านิด (ลูกค้า LINE)',
        customerLineId: 'U_nid_line_03',
        source: 'LINE ข้อความ',
        imageUrl: '',
        isGrid4x30: false,
        status: 'verified',
        modelUsed: 'gemini-2.5-pro',
        totalItems: slip3Items.length,
        totalMoney: slip3Total,
        reviewCount: 0,
        createdAt: timeAfterCutoff3,
        items: slip3Items
      }
    ],
    layoffs: [],
    lineChats: [
      {
        id: 'MSG-1',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'customer',
        type: 'image',
        imageUrl: '/uploads/slip-16-11-page1.jpg',
        text: 'ส่งโพยกระดาษงวด 16/11 แผ่นที่ 1 ค่ะ (ส่งวันที่ 14 พ.ย. ก่อนเลขอั้น)',
        timestamp: timeBeforeCutoff1
      },
      {
        id: 'MSG-2',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'bot',
        type: 'text',
        text: `✅ รับโพย #SLIP-1611-001 (งวดวันที่ 16 พ.ย. 2569)\n👤 ผู้ส่ง: เจ๊หมวย (สาย A)\n🟢 สถานะเรทจ่าย: จ่ายเต็ม 100% ทุกเลข (ส่งก่อนเวลาประกาศเลขอั้น)\n📋 จำนวน: 120 รายการ | ยอดรวม: ${slip1Total.toLocaleString()} บาท`,
        timestamp: timeBeforeCutoff1
      },
      {
        id: 'MSG-3',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เฮียพงษ์ (ลูกค้า LINE)',
        sender: 'customer',
        type: 'text',
        text: '21 = 22 บาท\n583 = 55x55\n154 = 22x22\n072 = 33',
        timestamp: timeBeforeCutoff2
      },
      {
        id: 'MSG-4',
        drawId: 'DRAW-2026-11-16',
        customerName: 'เฮียพงษ์ (ลูกค้า LINE)',
        sender: 'bot',
        type: 'text',
        text: `✅ บันทึกบิล #SLIP-1611-002 (งวดวันที่ 16 พ.ย. 2569)\n👤 ผู้ส่ง: เฮียพงษ์ (ลูกค้า LINE)\n🟢 ส่งก่อนเวลาประกาศอั้น: ได้เรทจ่ายเต็ม 100% ทุกเลข!\n• 21 = 22 บาท (จ่ายเต็ม 100%)\n• 583 = 55×55 (จ่ายเต็ม 100%)\n• 154 = 22×22 (จ่ายเต็ม 100%)\n• 072 = 33 บาท (จ่ายเต็ม 100%)\n💰 รวมยอดบิลนี้: ${slip2Total.toLocaleString()} บาท`,
        timestamp: timeBeforeCutoff2
      },
      {
        id: 'MSG-5',
        drawId: 'DRAW-2026-11-16',
        customerName: 'ป้านิด (ลูกค้า LINE)',
        sender: 'customer',
        type: 'text',
        text: '21 = 20 บาท\n860 = 22x22\n289 = 22x11',
        timestamp: timeAfterCutoff3
      },
      {
        id: 'MSG-6',
        drawId: 'DRAW-2026-11-16',
        customerName: 'ป้านิด (ลูกค้า LINE)',
        sender: 'bot',
        type: 'text',
        text: `✅ บันทึกบิล #SLIP-1611-003 (งวดวันที่ 16 พ.ย. 2569)\n👤 ผู้ส่ง: ป้านิด (ลูกค้า LINE)\n⚠️ หมายเหตุเลขอั้น (ส่งหลังเวลาประกาศอั้น 15 พ.ย. 14:00 น.):\n• 21 = 20 บาท 🔒 [เลขอั้น จ่าย 50%]\n• 860 = 22×22 🔒 [เลขอั้น จ่าย 50%]\n• 289 = 22×11 🟢 [เลขปกติ จ่ายเต็ม 100%]\n💰 รวมยอดบิลนี้: ${slip3Total.toLocaleString()} บาท`,
        timestamp: timeAfterCutoff3
      }
    ]
  };
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = buildInitialDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Auto-migrate if older schema without `draws`
    if (!Array.isArray(db.draws) || db.draws.length === 0) {
      const initial = buildInitialDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    return db;
  } catch (e) {
    const initial = buildInitialDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function recalculateSlipItems(slip, settings) {
  const newItems = (slip.items || []).map(it =>
    parseAndValidateRow(
      {
        col: it.col || 1,
        row: it.row || 1,
        numText: it.numText || '',
        amtText: it.amtText || '',
        categoryHint: it.categoryHint || '3_top',
        note: it.note || '',
        needsReview: Boolean(it.needsReview),
        confidence: it.confidence ?? 0.99
      },
      settings
    )
  );
  slip.items = newItems;
  slip.totalItems = newItems.filter(i => !i.isEmpty).length;
  slip.totalMoney = newItems.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
  slip.reviewCount = newItems.filter(i => i.needsReview).length;
  return slip;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;

function parseJsonBody(req) {
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
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
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
        service: 'efl-lotto-ocr',
        uptime: Math.round(process.uptime())
      });
    }

    // API: Get State for the selected Draw Period (งวดหวย)
    if (req.method === 'GET' && pathname === '/api/state') {
      const db = loadDb();
      const requestedDrawId = parsedUrl.searchParams.get('drawId') || db.currentDrawId || db.draws[0].id;
      const currentDraw = db.draws.find(d => d.id === requestedDrawId) || db.draws[0];
      db.currentDrawId = currentDraw.id;

      const drawSlips = db.slips
        .filter(s => (s.drawId || 'DRAW-2026-11-16') === currentDraw.id)
        .map(s => {
          // Annotate each slip with how many items fall into 100% vs 50% payout
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

          return {
            ...s,
            full100Money,
            half50Money,
            restrictedHits: Array.from(new Set(restrictedHits))
          };
        });

      const aggregated = aggregateSlips(drawSlips, db.settings, currentDraw.restrictedNumbers);
      const totalGrandMoney = drawSlips.reduce((sum, s) => sum + (s.totalMoney || 0), 0);
      const totalFull100Money = aggregated.reduce((sum, a) => sum + (a.fullPayout100Amt || 0), 0);
      const totalHalf50Money = aggregated.reduce((sum, a) => sum + (a.halfPayout50Amt || 0), 0);

      // Group customer summary for "งวดนี้ใครส่งอะไรมาบ้าง"
      const customerMap = new Map();
      for (const s of drawSlips) {
        if (!customerMap.has(s.customerName)) {
          customerMap.set(s.customerName, {
            customerName: s.customerName,
            slipCount: 0,
            totalItems: 0,
            totalMoney: 0,
            full100Money: 0,
            half50Money: 0,
            slips: []
          });
        }
        const c = customerMap.get(s.customerName);
        c.slipCount += 1;
        c.totalItems += s.totalItems || 0;
        c.totalMoney += s.totalMoney || 0;
        c.full100Money += s.full100Money || 0;
        c.half50Money += s.half50Money || 0;
        c.slips.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          totalItems: s.totalItems,
          totalMoney: s.totalMoney,
          full100Money: s.full100Money,
          half50Money: s.half50Money,
          restrictedHits: s.restrictedHits,
          reviewCount: s.reviewCount,
          source: s.source
        });
      }

      return sendJson(res, 200, {
        currentDrawId: currentDraw.id,
        currentDraw,
        draws: db.draws,
        settings: db.settings,
        slips: drawSlips,
        customersInDraw: Array.from(customerMap.values()),
        aggregated,
        layoffs: (db.layoffs || []).filter(l => (l.drawId || currentDraw.id) === currentDraw.id),
        lineChats: (db.lineChats || []).filter(m => (m.drawId || currentDraw.id) === currentDraw.id),
        summary: {
          totalSlips: drawSlips.length,
          totalCustomers: customerMap.size,
          totalGrandMoney,
          totalFull100Money,
          totalHalf50Money,
          totalUniqueNumbers: aggregated.length,
          restrictedCount: (currentDraw.restrictedNumbers || []).length,
          overLimitCount: aggregated.filter(a => a.isOverLimit).length,
          pendingReviewSlips: drawSlips.filter(s => s.reviewCount > 0 && s.status !== 'verified').length
        }
      });
    }

    // API: Create or Switch Draw Period (สร้างงวดใหม่ / สลับงวด)
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
      saveDb(db);
      return sendJson(res, 200, { ok: true, draw: newDraw });
    }

    // API: Manage Restricted Numbers (เลขอั้น 50% ประจำงวด พร้อมเวลาประกาศ)
    if (req.method === 'POST' && pathname === '/api/draws/restrictions') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const draw = db.draws.find(d => d.id === (body.drawId || db.currentDrawId)) || db.draws[0];

      if (body.action === 'add_batch') {
        // Accepts comma/space/newline separated numbers e.g. "21, 583, 154, 072, 860"
        const rawNums = String(body.numbersText || '')
          .split(/[\s,،\r\n]+/)
          .map(s => s.replace(/[^\d]/g, '').trim())
          .filter(s => s.length === 2 || s.length === 3);

        const announcedAt = body.announcedAt
          ? new Date(body.announcedAt).toISOString()
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
      } else if (body.action === 'remove' && body.number) {
        draw.restrictedNumbers = (draw.restrictedNumbers || []).filter(r => r.number !== body.number);
      } else if (body.action === 'clear_all') {
        draw.restrictedNumbers = [];
      }

      saveDb(db);
      return sendJson(res, 200, { ok: true, draw });
    }

    // API: Reset Demo Database
    if (req.method === 'POST' && pathname === '/api/reset') {
      const initial = buildInitialDb();
      saveDb(initial);
      return sendJson(res, 200, { ok: true, message: 'รีเซ็ตข้อมูลตัวอย่างเริ่มต้นเรียบร้อยแล้ว' });
    }

    // API: Update Settings
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      db.settings = {
        ...db.settings,
        ...body,
        riskLimits: {
          ...db.settings.riskLimits,
          ...(body.riskLimits || {})
        }
      };
      db.slips.forEach(s => recalculateSlipItems(s, db.settings));
      saveDb(db);
      return sendJson(res, 200, { ok: true, settings: db.settings });
    }

    // API: Upload & Run OCR on Paper Slip Image
    if (req.method === 'POST' && pathname === '/api/slips/ocr') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const drawId = body.drawId || db.currentDrawId || db.draws[0].id;
      const currentDraw = db.draws.find(d => d.id === drawId) || db.draws[0];

      const customerName = (body.customerName || 'ลูกค้าทั่วไป (LINE)').trim();
      const title = (body.title || `โพยกระดาษ - ${customerName}`).trim();
      const base64Image = body.base64Image || '';
      const columnSlices = body.columnSlices || null;
      const submittedAt = body.submittedAt ? new Date(body.submittedAt).toISOString() : new Date().toISOString();

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

      const ocrResult = await analyzeSlipImage({
        base64Image: base64Image || fs.readFileSync(path.join(UPLOADS_DIR, 'slip-16-11-page1.jpg')).toString('base64'),
        columnSlices,
        settings: db.settings
      });

      const items = ocrResult.items || [];
      const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
      const reviewCount = items.filter(i => i.needsReview).length;

      const newSlip = {
        id: `SLIP-${Date.now().toString().slice(-6)}`,
        drawId: currentDraw.id,
        title,
        sheetDate: ocrResult.sheetDate || '16/11',
        sheetPage: ocrResult.sheetPage || '1',
        customerName,
        customerLineId: body.customerLineId || `U_${Date.now().toString().slice(-5)}`,
        source: body.source || 'อัปโหลดรูปโพย (OCR)',
        imageUrl: savedImageUrl,
        isGrid4x30: items.length > 30,
        status: reviewCount > 0 ? 'needs_review' : 'verified',
        modelUsed: ocrResult.modelUsed,
        ocrMode: ocrResult.mode,
        usage: ocrResult.usage,
        totalItems: items.filter(i => !i.isEmpty).length,
        totalMoney,
        reviewCount,
        createdAt: submittedAt,
        items
      };

      db.slips.unshift(newSlip);
      saveDb(db);

      return sendJson(res, 200, {
        ok: true,
        slip: newSlip,
        ocrResult
      });
    }

    // API: Update / Verify a Slip
    if (req.method === 'PUT' && pathname.startsWith('/api/slips/')) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', ''));
      const body = await parseJsonBody(req);
      const db = loadDb();

      const slip = db.slips.find(s => s.id === slipId);
      if (!slip) return sendJson(res, 404, { error: 'ไม่พบบิลนี้ในระบบ' });

      if (body.customerName !== undefined) slip.customerName = body.customerName;
      if (body.title !== undefined) slip.title = body.title;
      if (body.createdAt !== undefined) slip.createdAt = new Date(body.createdAt).toISOString();

      if (Array.isArray(body.items)) {
        slip.items = body.items.map(it =>
          parseAndValidateRow(
            {
              col: it.col || 1,
              row: it.row || 1,
              numText: it.numText || '',
              amtText: it.amtText || '',
              note: it.clearedNote ? '' : (it.note || ''),
              needsReview: false,
              confidence: 1.0
            },
            db.settings
          )
        );
      }

      slip.totalItems = slip.items.filter(i => !i.isEmpty).length;
      slip.totalMoney = slip.items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
      slip.reviewCount = slip.items.filter(i => i.needsReview).length;

      if (body.markVerified) {
        slip.items.forEach(i => {
          i.needsReview = false;
        });
        slip.reviewCount = 0;
        slip.status = 'verified';
      } else {
        slip.status = slip.reviewCount > 0 ? 'needs_review' : 'verified';
      }

      saveDb(db);
      return sendJson(res, 200, { ok: true, slip });
    }

    // API: Delete a Slip
    if (req.method === 'DELETE' && pathname.startsWith('/api/slips/')) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', ''));
      const db = loadDb();
      db.slips = db.slips.filter(s => s.id !== slipId);
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    // API: LINE Simulator (Supports testing sending BEFORE vs AFTER dealer 50% restriction cutoff!)
    if (req.method === 'POST' && pathname === '/api/line/simulate') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const currentDraw = db.draws.find(d => d.id === (body.drawId || db.currentDrawId)) || db.draws[0];
      const customerName = (body.customerName || 'ลูกค้า LINE').trim();
      const text = (body.text || '').trim();
      const useSamplePhoto = Boolean(body.useSamplePhoto);
      const base64Image = body.base64Image || '';
      const submittedAt = body.submittedAt ? new Date(body.submittedAt).toISOString() : new Date().toISOString();

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
          text: text || 'ส่งรูปโพยหวยผ่าน LINE',
          timestamp: submittedAt
        });

        const ocrResult = await analyzeSlipImage({
          base64Image: base64Image || fs.readFileSync(path.join(UPLOADS_DIR, 'slip-16-11-page1.jpg')).toString('base64'),
          settings: db.settings
        });

        const items = ocrResult.items || [];
        const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
        const reviewCount = items.filter(i => i.needsReview).length;

        const newSlip = {
          id: `SLIP-${Date.now().toString().slice(-6)}`,
          drawId: currentDraw.id,
          title: `โพยรูป LINE - ${customerName}`,
          sheetDate: ocrResult.sheetDate || '16/11',
          sheetPage: ocrResult.sheetPage || '1',
          customerName,
          customerLineId: `U_${customerName}`,
          source: 'LINE รูปโพยกระดาษ',
          imageUrl: savedImageUrl,
          isGrid4x30: items.length > 30,
          status: reviewCount > 0 ? 'needs_review' : 'verified',
          modelUsed: ocrResult.modelUsed,
          totalItems: items.filter(i => !i.isEmpty).length,
          totalMoney,
          reviewCount,
          createdAt: submittedAt,
          items
        };

        db.slips.unshift(newSlip);

        // Check how many items hit 50% restriction
        const restrictedHits = [];
        for (const it of items) {
          const ev = evaluateNumberRestriction(it.baseNumber, submittedAt, currentDraw.restrictedNumbers);
          if (ev.isRestrictedNumber && !ev.isBeforeCutoff) {
            restrictedHits.push(`${it.baseNumber} (จ่าย ${ev.payoutPercentForThisSlip}%)`);
          }
        }
        const uniqueHits = Array.from(new Set(restrictedHits));

        const botReply =
          `✅ รับรูปโพย #${newSlip.id} (${currentDraw.title})\n` +
          `👤 ผู้ส่ง: ${customerName}\n` +
          `📋 อ่านได้ทั้งหมด: ${newSlip.totalItems} รายการ | รวม ${totalMoney.toLocaleString()} บาท\n` +
          (uniqueHits.length > 0
            ? `🔒 มีเลขอั้นในโพยนี้ (ส่งหลังเวลาประกาศอั้น): ${uniqueHits.join(', ')}\n`
            : `🟢 เรทจ่าย: จ่ายเต็ม 100% ทุกรายการ\n`) +
          (reviewCount > 0
            ? `⚠️ มี ${reviewCount} จุดที่ส่งให้แอดมินตรวจทานซ้ำ`
            : `✨ ตรวจสอบกฎคณิตศาสตร์ผ่าน 100%`);

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
          title: `บิลข้อความ LINE - ${customerName}`,
          sheetDate: '16/11',
          sheetPage: '-',
          customerName,
          customerLineId: `U_${customerName}`,
          source: 'LINE ข้อความ',
          imageUrl: '',
          isGrid4x30: false,
          status: reviewCount > 0 ? 'needs_review' : 'verified',
          modelUsed: 'ระบบอ่านข้อความอัตโนมัติ',
          totalItems: items.length,
          totalMoney,
          reviewCount,
          createdAt: submittedAt,
          items
        };

        db.slips.unshift(newSlip);

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
          `✅ บันทึกบิล #${newSlip.id} (${currentDraw.title})\n` +
          `👤 ผู้ส่ง: ${customerName}\n` +
          linesSummary.join('\n') +
          `\n💰 รวมยอดบิลนี้: ${totalMoney.toLocaleString()} บาท`;

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

    // API: Real LINE Messaging API Webhook
    if (req.method === 'POST' && pathname === '/api/line/webhook') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const currentDraw = db.draws.find(d => d.id === db.currentDrawId) || db.draws[0];
      const events = body.events || [];
      const token = db.settings.lineChannelAccessToken || process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

      for (const ev of events) {
        if (ev.type === 'message' && ev.message) {
          const replyToken = ev.replyToken;
          const userId = ev.source?.userId || 'LINE_USER';
          let replyText = '';
          const nowIso = new Date().toISOString();

          if (ev.message.type === 'image' && token) {
            const imgRes = await fetch(`https://api-data.line.me/v2/bot/message/${ev.message.id}/content`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            if (imgRes.ok) {
              const arrayBuf = await imgRes.arrayBuffer();
              const buf = Buffer.from(arrayBuf);
              const fileName = `line-webhook-${Date.now()}.jpg`;
              fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buf);

              const ocrResult = await analyzeSlipImage({
                base64Image: buf.toString('base64'),
                settings: db.settings
              });
              const items = ocrResult.items || [];
              const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
              const reviewCount = items.filter(i => i.needsReview).length;

              const newSlip = {
                id: `SLIP-${Date.now().toString().slice(-6)}`,
                drawId: currentDraw.id,
                title: `โพย LINE OA (${userId.slice(0, 6)})`,
                sheetDate: ocrResult.sheetDate || '16/11',
                sheetPage: ocrResult.sheetPage || '1',
                customerName: `ลูกค้า LINE (${userId.slice(0, 6)})`,
                customerLineId: userId,
                source: 'LINE รูปโพยกระดาษ',
                imageUrl: `/uploads/${fileName}`,
                isGrid4x30: items.length > 30,
                status: reviewCount > 0 ? 'needs_review' : 'verified',
                modelUsed: ocrResult.modelUsed,
                totalItems: items.filter(i => !i.isEmpty).length,
                totalMoney,
                reviewCount,
                createdAt: nowIso,
                items
              };
              db.slips.unshift(newSlip);
              replyText = `✅ รับโพย #${newSlip.id} (${currentDraw.title}) จำนวน ${newSlip.totalItems} รายการ รวม ${totalMoney.toLocaleString()} บาท`;
            }
          } else if (ev.message.type === 'text') {
            const items = parseFreeTextMessage(ev.message.text, db.settings);
            if (items.length > 0) {
              const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
              const newSlip = {
                id: `SLIP-${Date.now().toString().slice(-6)}`,
                drawId: currentDraw.id,
                title: `ข้อความ LINE OA (${userId.slice(0, 6)})`,
                sheetDate: '16/11',
                sheetPage: '-',
                customerName: `ลูกค้า LINE (${userId.slice(0, 6)})`,
                customerLineId: userId,
                source: 'LINE ข้อความ',
                imageUrl: '',
                isGrid4x30: false,
                status: 'verified',
                modelUsed: 'ระบบอ่านข้อความ',
                totalItems: items.length,
                totalMoney,
                reviewCount: 0,
                createdAt: nowIso,
                items
              };
              db.slips.unshift(newSlip);

              const linesSummary = items.map(it => {
                const evRes = evaluateNumberRestriction(it.baseNumber, nowIso, currentDraw.restrictedNumbers);
                const tag = evRes.isRestrictedNumber && !evRes.isBeforeCutoff ? ` 🔒(อั้นจ่าย ${evRes.payoutPercentForThisSlip}%)` : ` 🟢(จ่าย 100%)`;
                return `• ${it.numText} = ${it.rowTotalMoney}฿${tag}`;
              });
              replyText = `✅ บันทึกบิล #${newSlip.id} (${currentDraw.title})\n${linesSummary.join('\n')}\n💰 รวม ${totalMoney.toLocaleString()} บาท`;
            }
          }

          if (replyText && replyToken && token) {
            await fetch('https://api.line.me/v2/bot/message/reply', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
              },
              body: JSON.stringify({
                replyToken,
                messages: [{ type: 'text', text: replyText }]
              })
            });
          }
        }
      }

      saveDb(db);
      return sendJson(res, 200, { status: 'ok' });
    }

    // API: Save Dealer Layoff Bill
    if (req.method === 'POST' && pathname === '/api/layoffs') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const dealerName = (body.dealerName || 'เจ้ามือสายใหญ่ #1').trim();
      const items = body.items || [];
      const totalLayoffMoney = items.reduce((s, i) => s + (Number(i.sendTotal) || 0), 0);

      const newLayoff = {
        id: `LAYOFF-${Date.now().toString().slice(-6)}`,
        drawId: body.drawId || db.currentDrawId,
        dealerName,
        itemCount: items.length,
        totalLayoffMoney,
        formattedText: body.formattedText || '',
        items,
        createdAt: new Date().toISOString()
      };

      db.layoffs = db.layoffs || [];
      db.layoffs.unshift(newLayoff);
      saveDb(db);
      return sendJson(res, 200, { ok: true, layoff: newLayoff });
    }

    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
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
