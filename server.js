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

function getNextRoundForCustomer(slips, drawId, customerName) {
  const existing = (slips || []).filter(
    s => (s.drawId || 'DRAW-2026-11-16') === drawId && s.customerName === customerName
  );
  return existing.length + 1;
}

function buildInitialDb() {
  const defaultSettings = {
    geminiModel: 'gemini-2.5-pro',
    geminiApiKey: '',
    permutationMode: 'expand',
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
        status: 'verified',
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
        status: 'verified',
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
        status: 'verified',
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
        status: 'verified',
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
        status: 'verified',
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
        itemCount: 4,
        sentItemCount: 3,
        keptItemCount: 2,
        totalLayoffMoney: 494,
        totalKeptMoney: 320,
        formattedText:
          '📋 ใบตัดยอดส่ง: เจ้ามือสายใหญ่ #1 (รอบที่ 1)\n' +
          '📅 งวดวันที่ 16 พ.ย. 2569\n' +
          '-------------------------\n' +
          '583 = 252 บ. (เก็บไว้ที่เรา 100 บ.)\n' +
          '287 = 220 บ. (ส่งเจ้ามือทั้งหมด)\n' +
          '21 = 22 บ. (ส่งเจ้ามือทั้งหมด)\n' +
          '486 = 0 บ. (เก็บไว้ที่เราทั้งหมด 220 บ.)\n' +
          '-------------------------\n' +
          'รวมส่งเจ้ามือรอบที่ 1 = 494 บาท | เก็บไว้ที่เรา = 320 บาท',
        items: [
          { number: '583', sendTotal: 252, keepTotal: 100, typeDesc: '3 ตัวบน+โต๊ด' },
          { number: '287', sendTotal: 220, keepTotal: 0, typeDesc: '110×110' },
          { number: '21', sendTotal: 22, keepTotal: 0, typeDesc: '2 ตัวบน' },
          { number: '486', sendTotal: 0, keepTotal: 220, typeDesc: 'เก็บไว้ที่เรา' }
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

        return {
          ...s,
          roundNumber,
          full100Money,
          half50Money,
          restrictedHits: Array.from(new Set(restrictedHits))
        };
      });

      const drawLayoffs = (db.layoffs || []).filter(l => (l.drawId || currentDraw.id) === currentDraw.id);
      const aggregated = aggregateSlips(drawSlips, db.settings, currentDraw.restrictedNumbers, drawLayoffs);
      const totalGrandMoney = drawSlips.reduce((sum, s) => sum + (s.totalMoney || 0), 0);
      const totalFull100Money = aggregated.reduce((sum, a) => sum + (a.fullPayout100Amt || 0), 0);
      const totalHalf50Money = aggregated.reduce((sum, a) => sum + (a.halfPayout50Amt || 0), 0);
      const totalSentToDealerMoney = aggregated.reduce((sum, a) => sum + (a.alreadySentAmt || 0), 0);
      const totalKeptByUsMoney = aggregated.reduce((sum, a) => sum + (a.alreadyKeptAmt || 0), 0);
      const totalNewPendingMoney = aggregated.reduce((sum, a) => sum + (a.newPendingAmt || 0), 0);
      const pendingNumbersCount = aggregated.filter(a => a.hasNewPending).length;

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
          reviewCount: s.reviewCount,
          source: s.source
        });
      }

      return sendJson(res, 200, {
        currentDrawId: currentDraw.id,
        currentDraw,
        draws: db.draws,
        settings: db.settings,
        learnedRules: db.learnedRules || [],
        slips: drawSlips,
        trainingSlips: db.slips.filter(s => s.isTrainingOnly),
        customersInDraw: Array.from(customerMap.values()),
        aggregated,
        layoffs: drawLayoffs,
        lineChats: (db.lineChats || []).filter(m => (m.drawId || currentDraw.id) === currentDraw.id),
        summary: {
          totalSlips: drawSlips.length,
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
          pendingReviewSlips: drawSlips.filter(s => s.reviewCount > 0 && s.status !== 'verified').length
        }
      });
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
      saveDb(db);
      return sendJson(res, 200, { ok: true, draw: newDraw });
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
      const nextRound = getNextRoundForCustomer(db.slips, currentDraw.id, customerName);
      const title = (body.title || `รอบที่ ${nextRound} — โพยกระดาษ (${customerName})`).trim();
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
        settings: db.settings,
        learnedRules: db.learnedRules || [],
        customerName
      });

      const items = ocrResult.items || [];
      const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
      const reviewCount = items.filter(i => i.needsReview).length;
      const isTrainingOnly = Boolean(body.isTrainingOnly);

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

      db.slips.push(newSlip);
      saveDb(db);

      return sendJson(res, 200, {
        ok: true,
        slip: newSlip,
        ocrResult
      });
    }

    // API: Update / Verify a Slip & Auto-Learn Handwriting Corrections!
    if (req.method === 'PUT' && pathname.startsWith('/api/slips/')) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', ''));
      const body = await parseJsonBody(req);
      const db = loadDb();
      db.learnedRules = db.learnedRules || [];

      const slip = db.slips.find(s => s.id === slipId);
      if (!slip) return sendJson(res, 404, { error: 'ไม่พบบิลนี้ในระบบ' });

      if (body.customerName !== undefined) slip.customerName = body.customerName;
      if (body.title !== undefined) slip.title = body.title;
      if (body.createdAt !== undefined) slip.createdAt = new Date(body.createdAt).toISOString();

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
            ocrOriginalNumText: newNum,
            ocrOriginalAmtText: newAmt
          };
        });
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
      return sendJson(res, 200, {
        ok: true,
        slip,
        newlyLearnedCount: newlyLearned.length,
        newlyLearned
      });
    }

    // API: Delete a Slip
    if (req.method === 'DELETE' && pathname.startsWith('/api/slips/')) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', ''));
      const db = loadDb();
      db.slips = db.slips.filter(s => s.id !== slipId);
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    // API: LINE Simulator (Automatically increments Round Number for the runner & reports cumulative total!)
    if (req.method === 'POST' && pathname === '/api/line/simulate') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const currentDraw = db.draws.find(d => d.id === (body.drawId || db.currentDrawId)) || db.draws[0];
      const customerName = (body.customerName || 'ลูกค้า LINE').trim();
      const text = (body.text || '').trim();
      const useSamplePhoto = Boolean(body.useSamplePhoto);
      const base64Image = body.base64Image || '';
      const submittedAt = body.submittedAt ? new Date(body.submittedAt).toISOString() : new Date().toISOString();

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
          settings: db.settings
        });

        const items = ocrResult.items || [];
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
          isGrid4x30: items.length > 30,
          status: reviewCount > 0 ? 'needs_review' : 'verified',
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
          status: reviewCount > 0 ? 'needs_review' : 'verified',
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
          const customerName = `เด็กโพย LINE (${userId.slice(0, 6)})`;
          const nextRound = getNextRoundForCustomer(db.slips, currentDraw.id, customerName);
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
                roundNumber: nextRound,
                title: `รอบที่ ${nextRound} — โพยรูป LINE`,
                sheetDate: ocrResult.sheetDate || '16/11',
                sheetPage: String(nextRound),
                customerName,
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
              db.slips.push(newSlip);
              const cumTotal = db.slips
                .filter(s => s.drawId === currentDraw.id && s.customerName === customerName)
                .reduce((sum, s) => sum + (s.totalMoney || 0), 0);
              replyText = `✅ รับโพย ${customerName} รอบที่ ${nextRound} (${newSlip.totalItems} รายการ = ${totalMoney.toLocaleString()} บาท)\n📊 ยอดสะสมรวม ${nextRound} รอบ = ${cumTotal.toLocaleString()} บาท`;
            }
          } else if (ev.message.type === 'text') {
            const items = parseFreeTextMessage(ev.message.text, db.settings);
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
                status: 'verified',
                modelUsed: 'ระบบอ่านข้อความ',
                totalItems: items.length,
                totalMoney,
                reviewCount: 0,
                createdAt: nowIso,
                items
              };
              db.slips.push(newSlip);
              const cumTotal = db.slips
                .filter(s => s.drawId === currentDraw.id && s.customerName === customerName)
                .reduce((sum, s) => sum + (s.totalMoney || 0), 0);
              replyText = `✅ บันทึกรอบที่ ${nextRound} (${items.length} รายการ = ${totalMoney.toLocaleString()} บาท)\n📊 ยอดสะสมรวม ${nextRound} รอบ = ${cumTotal.toLocaleString()} บาท`;
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

    // API: Save Dealer Layoff Bill (ทยอยส่งเจ้ามือเป็นรอบๆ + บันทึกยอดส่งและยอดเก็บไว้ที่เราเพื่อไม่ให้ส่งซ้ำ)
    if (req.method === 'POST' && pathname === '/api/layoffs') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const drawId = body.drawId || db.currentDrawId;
      const existingInDraw = (db.layoffs || []).filter(l => (l.drawId || drawId) === drawId);
      const roundNumber = existingInDraw.length + 1;

      const dealerName = (body.dealerName || 'เจ้ามือสายใหญ่ #1').trim();
      const items = (body.items || []).map(it => ({
        number: String(it.number || '').trim(),
        sendTotal: Math.max(0, Number(it.sendTotal) || 0),
        keepTotal: Math.max(0, Number(it.keepTotal) || 0),
        typeDesc: it.typeDesc || ''
      }));

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
      saveDb(db);
      return sendJson(res, 200, { ok: true, layoff: newLayoff });
    }

    // API: Delete / Undo a Layoff Round
    if (req.method === 'DELETE' && pathname.startsWith('/api/layoffs/')) {
      const layoffId = decodeURIComponent(pathname.replace('/api/layoffs/', ''));
      const db = loadDb();
      db.layoffs = (db.layoffs || []).filter(l => l.id !== layoffId);
      saveDb(db);
      return sendJson(res, 200, { ok: true });
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
