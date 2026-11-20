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
    permutationMode: 'expand', // 'expand' = แยกเลข/กระจายประตูอัตโนมัติ (×6, ×3), 'keep_raw' = คงตามหน้าโพย
    useColumnSlicing: true,    // ตัดแบ่ง 4 คอลัมน์อัตโนมัติเพื่อความแม่นยำสูงสุด
    checkMultiplesOf11: true,  // ตรวจสอบกฎพหูคูณ 11 / 10 / 5
    riskLimits: {
      threeStraight: 100, // เพดานรับเอง 3 ตัวบน (บาท/ตัว)
      threeToad: 100,     // เพดานรับเอง 3 ตัวโต๊ด (บาท/ตัว)
      threePerm: 132,     // เพดานรับเอง ชุดกลับ (บาท/ตัว)
      twoTop: 30,         // เพดานรับเอง 2 ตัวบน (ตั้งไว้ 30 เพื่อให้เห็นตัวอย่างเลข 21 = 42 บาท เกินเพดาน 12 บาท)
      twoBottom: 100      // เพดานรับเอง 2 ตัวล่าง
    },
    lineChannelAccessToken: '',
    lineChannelSecret: ''
  };

  // Build Slip 1 from the user's real uploaded photo (16/11 แผ่นที่ 1 - 120 rows)
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

  // Build Slip 2 & Slip 3 to demonstrate the user's exact prompt scenario:
  // "เช่น เลข 21 มีคนกรอก 22 บาท แล้วมีคนส่งเลข 21 = 22 บาท, 21 = 20 บาท ก็ให้แสดงเป็น 21 จำนวน 42 บาท"
  const slip2Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '21', amtText: '22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 2, numText: '583', amtText: '55×55', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 3, numText: '154', amtText: '22×22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 4, numText: '072', amtText: '33', confidence: 0.99 }, defaultSettings)
  ];
  const slip2Total = slip2Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  const slip3Items = [
    parseAndValidateRow({ col: 1, row: 1, numText: '21', amtText: '20', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 2, numText: '860', amtText: '22×22', confidence: 0.99 }, defaultSettings),
    parseAndValidateRow({ col: 1, row: 3, numText: '289', amtText: '22×11', confidence: 0.99 }, defaultSettings)
  ];
  const slip3Total = slip3Items.reduce((sum, i) => sum + (i.rowTotalMoney || 0), 0);

  const now = new Date().toISOString();

  return {
    settings: defaultSettings,
    slips: [
      {
        id: 'SLIP-1611-001',
        title: 'โพยกระดาษ 16/11 แผ่นที่ 1 (4 คอลัมน์ × 30 แถว)',
        sheetDate: '16/11',
        sheetPage: '1',
        customerName: 'เจ๊หมวย (สาย A)',
        customerLineId: 'U_muay_line_01',
        source: 'LINE รูปโพยกระดาษ',
        imageUrl: '/uploads/slip-16-11-page1.jpg',
        isGrid4x30: true,
        status: 'needs_review', // Has 1 row (Col 2 Row 8: 103 = 22x22) flagged for scratch-out confirmation
        modelUsed: 'gemini-2.5-pro',
        totalItems: slip1Items.filter(i => !i.isEmpty).length,
        totalMoney: slip1Total,
        reviewCount: slip1Items.filter(i => i.needsReview).length,
        createdAt: now,
        items: slip1Items
      },
      {
        id: 'SLIP-1611-002',
        title: 'บิล LINE #2 (เฮียพงษ์ ส่งเลข 21 = 22 บ. + 3 ตัว)',
        sheetDate: '16/11',
        sheetPage: '-',
        customerName: 'เฮียพงษ์ (ลูกค้า LINE)',
        customerLineId: 'U_pong_line_02',
        source: 'LINE Messaging',
        imageUrl: '',
        isGrid4x30: false,
        status: 'verified',
        modelUsed: 'gemini-2.5-pro',
        totalItems: slip2Items.length,
        totalMoney: slip2Total,
        reviewCount: 0,
        createdAt: now,
        items: slip2Items
      },
      {
        id: 'SLIP-1611-003',
        title: 'บิล LINE #3 (ป้านิด ส่งเลข 21 = 20 บ. + 3 ตัว)',
        sheetDate: '16/11',
        sheetPage: '-',
        customerName: 'ป้านิด (ลูกค้า LINE)',
        customerLineId: 'U_nid_line_03',
        source: 'LINE Messaging',
        imageUrl: '',
        isGrid4x30: false,
        status: 'verified',
        modelUsed: 'gemini-2.5-pro',
        totalItems: slip3Items.length,
        totalMoney: slip3Total,
        reviewCount: 0,
        createdAt: now,
        items: slip3Items
      }
    ],
    layoffs: [],
    lineChats: [
      {
        id: 'MSG-1',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'customer',
        type: 'image',
        imageUrl: '/uploads/slip-16-11-page1.jpg',
        text: 'ส่งโพยกระดาษงวด 16/11 แผ่นที่ 1 ค่ะ (120 แถว)',
        timestamp: now
      },
      {
        id: 'MSG-2',
        customerName: 'เจ๊หมวย (สาย A)',
        sender: 'bot',
        type: 'text',
        text: `✅ รับโพย #SLIP-1611-001 เรียบร้อยค่ะ\n👤 ผู้ส่ง: เจ๊หมวย (สาย A)\n🤖 อ่านด้วย: gemini-2.5-pro\n📋 จำนวน: 120 รายการ (4 คอลัมน์)\n💰 ยอดรวมทั้งใบ: ${slip1Total.toLocaleString()} บาท\n⚠️ จุดรอแอดมินตรวจซ้ำ: 1 จุด (คอลัมน์ 2 แถว 8 เลข 103 = 22×22 มีรอยขีดทับ)`,
        timestamp: now
      },
      {
        id: 'MSG-3',
        customerName: 'เฮียพงษ์ (ลูกค้า LINE)',
        sender: 'customer',
        type: 'text',
        text: '21 = 22 บาท\n583 = 55x55\n154 = 22x22\n072 = 33',
        timestamp: now
      },
      {
        id: 'MSG-4',
        customerName: 'เฮียพงษ์ (ลูกค้า LINE)',
        sender: 'bot',
        type: 'text',
        text: `✅ บันทึกบิล #SLIP-1611-002 สำเร็จ!\n👤 ผู้ส่ง: เฮียพงษ์ (ลูกค้า LINE)\n• 21 (2 ตัวบน) = 22 บาท\n• 583 (ตรง×โต๊ด) = 55×55 (110 บาท)\n• 154 (ตรง×โต๊ด) = 22×22 (44 บาท)\n• 072 (3 ตัวบน) = 33 บาท\n💰 รวมยอดบิลนี้: ${slip2Total.toLocaleString()} บาท`,
        timestamp: now
      },
      {
        id: 'MSG-5',
        customerName: 'ป้านิด (ลูกค้า LINE)',
        sender: 'customer',
        type: 'text',
        text: '21 = 20 บาท\n860 = 22x22\n289 = 22x11',
        timestamp: now
      },
      {
        id: 'MSG-6',
        customerName: 'ป้านิด (ลูกค้า LINE)',
        sender: 'bot',
        type: 'text',
        text: `✅ บันทึกบิล #SLIP-1611-003 สำเร็จ!\n👤 ผู้ส่ง: ป้านิด (ลูกค้า LINE)\n• 21 (2 ตัวบน) = 20 บาท (รวมยอดเลข 21 ในระบบตอนนี้ = 42 บาท)\n• 860 (ตรง×โต๊ด) = 22×22 (44 บาท)\n• 289 (ตรง×โต๊ด) = 22×11 (33 บาท)\n💰 รวมยอดบิลนี้: ${slip3Total.toLocaleString()} บาท`,
        timestamp: now
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
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
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

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25MB limit for base64 photos

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

    // Security hardening: silence missing favicon & block dotfiles / scanner extensions
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (/\/\.(?!well-known)/.test(pathname) || /\.(php|asp|aspx|jsp|cgi)$/i.test(pathname)) {
      res.writeHead(404);
      return res.end('Not Found');
    }

    // API: Health Check (for Docker healthcheck & EFL-OpsCenter)
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'efl-lotto-ocr',
        uptime: Math.round(process.uptime())
      });
    }

    // API: Get Complete Application State
    if (req.method === 'GET' && pathname === '/api/state') {
      const db = loadDb();
      const aggregated = aggregateSlips(db.slips, db.settings);
      const totalGrandMoney = db.slips
        .filter(s => s.status !== 'cancelled')
        .reduce((sum, s) => sum + (s.totalMoney || 0), 0);

      return sendJson(res, 200, {
        settings: db.settings,
        slips: db.slips,
        aggregated,
        layoffs: db.layoffs || [],
        lineChats: db.lineChats || [],
        summary: {
          totalSlips: db.slips.length,
          totalGrandMoney,
          totalUniqueNumbers: aggregated.length,
          overLimitCount: aggregated.filter(a => a.isOverLimit).length,
          pendingReviewSlips: db.slips.filter(s => s.reviewCount > 0 && s.status !== 'verified').length
        }
      });
    }

    // API: Reset Demo Database back to clean initial state
    if (req.method === 'POST' && pathname === '/api/reset') {
      const initial = buildInitialDb();
      saveDb(initial);
      return sendJson(res, 200, { ok: true, message: 'รีเซ็ตข้อมูลตัวอย่างเริ่มต้นเรียบร้อยแล้ว' });
    }

    // API: Update Settings (Model, Permutation Mode, Risk Limits, API Keys)
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
      // Re-validate slips with updated settings
      db.slips.forEach(s => recalculateSlipItems(s, db.settings));
      saveDb(db);
      return sendJson(res, 200, { ok: true, settings: db.settings });
    }

    // API: Upload & Run OCR on Paper Slip Image
    if (req.method === 'POST' && pathname === '/api/slips/ocr') {
      const body = await parseJsonBody(req);
      const db = loadDb();

      const customerName = (body.customerName || 'ลูกค้าทั่วไป (LINE)').trim();
      const title = (body.title || `โพยกระดาษ - ${customerName}`).trim();
      const base64Image = body.base64Image || '';
      const columnSlices = body.columnSlices || null;

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
        createdAt: new Date().toISOString(),
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

    // API: Update / Verify a Slip (from the Side-by-Side 4x30 Inspector)
    if (req.method === 'PUT' && pathname.startsWith('/api/slips/')) {
      const slipId = decodeURIComponent(pathname.replace('/api/slips/', ''));
      const body = await parseJsonBody(req);
      const db = loadDb();

      const slip = db.slips.find(s => s.id === slipId);
      if (!slip) return sendJson(res, 404, { error: 'ไม่พบบิลนี้ในระบบ' });

      if (body.customerName !== undefined) slip.customerName = body.customerName;
      if (body.title !== undefined) slip.title = body.title;
      if (Array.isArray(body.items)) {
        slip.items = body.items.map(it =>
          parseAndValidateRow(
            {
              col: it.col || 1,
              row: it.row || 1,
              numText: it.numText || '',
              amtText: it.amtText || '',
              note: it. clearedNote ? '' : (it.note || ''),
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
        // Admin explicitly verified all rows against the photo
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

    // API: LINE Simulator (Send Text or Photo as any Customer)
    if (req.method === 'POST' && pathname === '/api/line/simulate') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const customerName = (body.customerName || 'ลูกค้า LINE').trim();
      const text = (body.text || '').trim();
      const useSamplePhoto = Boolean(body.useSamplePhoto);
      const base64Image = body.base64Image || '';
      const now = new Date().toISOString();

      if (useSamplePhoto || base64Image) {
        // Customer sent a photo slip in LINE
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
          customerName,
          sender: 'customer',
          type: 'image',
          imageUrl: savedImageUrl,
          text: text || 'ส่งรูปโพยหวยผ่าน LINE',
          timestamp: now
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
          createdAt: now,
          items
        };

        db.slips.unshift(newSlip);

        const botReply =
          `✅ รับรูปโพย #${newSlip.id} เรียบร้อยครับ!\n` +
          `👤 ผู้ส่ง: ${customerName}\n` +
          `🤖 โมเดล: ${db.settings.geminiModel}\n` +
          `📋 อ่านได้ทั้งหมด: ${newSlip.totalItems} รายการ\n` +
          `💰 ยอดเงินรวม: ${totalMoney.toLocaleString()} บาท\n` +
          (reviewCount > 0
            ? `⚠️ มี ${reviewCount} รายการที่ระบบส่งให้แอดมินตรวจสอบความถูกต้องซ้ำ`
            : `✨ ผ่านการตรวจสอบกฎคณิตศาสตร์ครบ 100%`);

        db.lineChats.push({
          id: `MSG-${Date.now()}-2`,
          customerName,
          sender: 'bot',
          type: 'text',
          text: botReply,
          timestamp: new Date().toISOString()
        });

        saveDb(db);
        return sendJson(res, 200, { ok: true, slip: newSlip, botReply });
      } else {
        // Customer sent text numbers in LINE (e.g. "21 = 22\n583 = 110x110")
        db.lineChats.push({
          id: `MSG-${Date.now()}-1`,
          customerName,
          sender: 'customer',
          type: 'text',
          text,
          timestamp: now
        });

        const items = parseFreeTextMessage(text, db.settings);
        if (items.length === 0) {
          const errReply = `❌ ไม่พบรูปแบบตัวเลขในข้อความ กรุณาพิมพ์เช่น:\n21 = 22\n072x6 = 66\n583 = 55x55\nหรือส่งเป็นรูปถ่ายโพยกระดาษได้เลยครับ`;
          db.lineChats.push({
            id: `MSG-${Date.now()}-2`,
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
          title: `บิลข้อความ LINE - ${customerName}`,
          sheetDate: '16/11',
          sheetPage: '-',
          customerName,
          customerLineId: `U_${customerName}`,
          source: 'LINE ข้อความ',
          imageUrl: '',
          isGrid4x30: false,
          status: reviewCount > 0 ? 'needs_review' : 'verified',
          modelUsed: 'Text Pattern Parser',
          totalItems: items.length,
          totalMoney,
          reviewCount,
          createdAt: now,
          items
        };

        db.slips.unshift(newSlip);

        // Compute new aggregated total for each submitted number to show in LINE reply
        const aggregated = aggregateSlips(db.slips, db.settings);
        const linesSummary = items.map(it => {
          const agg = aggregated.find(a => a.number === it.baseNumber);
          const cumulativeText = agg ? ` (ยอดรวมเลข ${it.baseNumber} ในระบบ = ${agg.totalAmt.toLocaleString()}฿)` : '';
          return `• ${it.numText} (${it.patternLabel}) = ${it.rowTotalMoney.toLocaleString()} บาท${cumulativeText}`;
        });

        const botReply =
          `✅ บันทึกบิล #${newSlip.id} สำเร็จ!\n` +
          `👤 ผู้ส่ง: ${customerName}\n` +
          linesSummary.join('\n') +
          `\n💰 รวมยอดบิลนี้: ${totalMoney.toLocaleString()} บาท`;

        db.lineChats.push({
          id: `MSG-${Date.now()}-2`,
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

    // API: Real LINE Messaging API Webhook (/api/line/webhook)
    if (req.method === 'POST' && pathname === '/api/line/webhook') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const events = body.events || [];
      const token = db.settings.lineChannelAccessToken || process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

      for (const ev of events) {
        if (ev.type === 'message' && ev.message) {
          const replyToken = ev.replyToken;
          const userId = ev.source?.userId || 'LINE_USER';
          let replyText = '';

          if (ev.message.type === 'image' && token) {
            // Download image from LINE Content API
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
                title: `โพย LINE OA (${userId.slice(0, 6)})`,
                sheetDate: ocrResult.sheetDate || '16/11',
                sheetPage: ocrResult.sheetPage || '1',
                customerName: `ลูกค้า LINE (${userId.slice(0, 6)})`,
                customerLineId: userId,
                source: 'LINE Webhook (รูปโพย)',
                imageUrl: `/uploads/${fileName}`,
                isGrid4x30: items.length > 30,
                status: reviewCount > 0 ? 'needs_review' : 'verified',
                modelUsed: ocrResult.modelUsed,
                totalItems: items.filter(i => !i.isEmpty).length,
                totalMoney,
                reviewCount,
                createdAt: new Date().toISOString(),
                items
              };
              db.slips.unshift(newSlip);
              replyText = `✅ รับโพย #${newSlip.id} เรียบร้อย (${newSlip.totalItems} รายการ รวม ${totalMoney.toLocaleString()} บาท)`;
            }
          } else if (ev.message.type === 'text') {
            const items = parseFreeTextMessage(ev.message.text, db.settings);
            if (items.length > 0) {
              const totalMoney = items.reduce((s, i) => s + (i.rowTotalMoney || 0), 0);
              const newSlip = {
                id: `SLIP-${Date.now().toString().slice(-6)}`,
                title: `ข้อความ LINE OA (${userId.slice(0, 6)})`,
                sheetDate: '16/11',
                sheetPage: '-',
                customerName: `ลูกค้า LINE (${userId.slice(0, 6)})`,
                customerLineId: userId,
                source: 'LINE Webhook (ข้อความ)',
                imageUrl: '',
                isGrid4x30: false,
                status: 'verified',
                modelUsed: 'Text Parser',
                totalItems: items.length,
                totalMoney,
                reviewCount: 0,
                createdAt: new Date().toISOString(),
                items
              };
              db.slips.unshift(newSlip);
              replyText = `✅ บันทึกบิล #${newSlip.id} (${items.length} รายการ รวม ${totalMoney.toLocaleString()} บาท)`;
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

    // API: Save Dealer Layoff Bill (ใบตัดยอดส่งเจ้ามือใหญ่)
    if (req.method === 'POST' && pathname === '/api/layoffs') {
      const body = await parseJsonBody(req);
      const db = loadDb();
      const dealerName = (body.dealerName || 'เจ้ามือสายใหญ่ #1').trim();
      const items = body.items || [];
      const totalLayoffMoney = items.reduce((s, i) => s + (Number(i.sendTotal) || 0), 0);

      const newLayoff = {
        id: `LAYOFF-${Date.now().toString().slice(-6)}`,
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

    // Static File Serving
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
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
