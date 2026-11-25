// Gemini 2.5 Pro High-Precision Lottery Slip OCR Engine with Self-Learning Handwriting Memory

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { parseAndValidateRow } = require('./lotteryEngine');
const { RAW_COLUMNS_16_11 } = require('./seedData');

const LOTTERY_OCR_SYSTEM_PROMPT = `คุณคือระบบ AI OCR ผู้เชี่ยวชาญการอ่านโพยหวยไทยแบบเขียนด้วยลายมือที่มีความแม่นยำสูงสุด (Zero-Error Financial Grade)
กฎสำคัญในการอ่านลายมือโพยหวยนี้:
1. รูปแบบกระดาษโพยหวยมีความหลากหลาย (ระบบต้องอ่านได้ทุกรูปแบบและทุกแนวการวางภาพ):
   - โพยตารางมาตรฐาน 4 คอลัมน์, 5 คอลัมน์, หรือ 8 คอลัมน์ (มีแถว 1 ถึง 25-30 แถว) หรือโพยสมุดเส้นเขียนอิสระ 2-3 คอลัมน์
   - หากรูปภาพถูกถ่ายตะแคง 90 องศา หรือกลับหัว ให้หมุนแกนสายตาอ่านตามแนวตัวหนังสือจริงจากซ้ายไปขวา และบนลงล่างให้ครบทุกคอลัมน์ (col = 1 ถึง 8 หรือตามจำนวนคอลัมน์จริงในหน้ากระดาษ) พร้อมระบุค่า rotationNeededDeg (0, 90, 180, หรือ 270 องศาตามเข็มนาฬิกา) เพื่อให้หน้าเว็บหมุนภาพกลับมาตั้งตรงได้ถูกต้อง (เช่น ภาพตะแคงซ้ายหัวตารางอยู่ฝั่งขวา ต้องหมุนทวนเข็ม = 270° ตามเข็ม; ภาพตะแคงขวาหัวตารางอยู่ฝั่งซ้าย ต้องหมุนขวา = 90° ตามเข็ม; ภาพกลับหัว = 180°)
2. การอ่านหัวตาราง (colHeader) และการจำแนกประเภทหวย (categoryHint) ของแต่ละคอลัมน์:
   - "ห.ท." / "ห.ท.1" / "หัว-ท้าย" / "หัวท้ายที่ 1" / "ท้ายที่ 1" / "หัวที่ 1" / "บน" = เลข 3 ตัวบน (ตรง / ตรง×โต๊ด / ชุดกลับ ×6, ×3) -> ตั้งค่า categoryHint = "3_top"
   - "โต๊ด ห.ท.ที่ 1" / "โต๊ด หท1" / "โต๊ด" = เลข 3 ตัวโต๊ดล้วน -> ตั้งค่า categoryHint = "3_toad" (สำคัญมาก: หากเขียนเลข 3 ตัวในคอลัมน์ที่หัวตารางเขียนว่า "โต๊ด" และมียอดเงินตัวเดียว เช่น "213 = 132" หรือ "163 = 66" ยอดนั้นคือ 3 ตัวโต๊ด ไม่ใช่ 3 ตัวตรง!)
   - "ล-บ" / "ล.บ" / "ล่าง-บน" = เลข 2 ตัว ล่าง×บน หรือ 2 ตัวล่าง -> ตั้งค่า categoryHint = "2_bottom_top" (หรือหากมียอดเงินตัวเดียวในช่อง ล.บ ให้ตั้งเป็น "2_bottom")
   - "2 ล่าง" / "ล่าง" = เลข 2 ตัวล่าง -> ตั้งค่า categoryHint = "2_bottom"
   - "2 บน" = เลข 2 ตัวบน -> ตั้งค่า categoryHint = "2_top"
3. ในแต่ละแถวจะมี 2 ช่องย่อย:
   - ช่องซ้าย (numText): ตัวเลขหวย 3 ตัว หรือ 2 ตัว อาจมีเครื่องหมายคูณชุดกลับต่อท้าย เช่น "072×6" (กลับ 6 ประตู) หรือ "979×3", "144×3", "922×3" (เลขเบิ้ลกลับ 3 ประตู) หรือเลขเดี่ยว เช่น "426", "317", "79"
   - ช่องขวา (amtText): จำนวนเงิน เช่น "66", "132", "22", "44", "33" หรือแบบ ตรง×โต๊ด / บน×ล่าง เช่น "22×22", "33×30", "55×50", "24×24", "48×24", "110×110"
4. กฎการอ่านเครื่องหมายปีกกา "}" และเส้นลากยาวแนวตั้ง "|" (Bracket / Vertical Ditto Grouping):
   - คนเขียนโพยมักเขียนตัวเลขหลายบรรทัดเรียงลงมาในช่องซ้าย แล้วลากเส้นตรงแนวตั้ง "|" หรือเขียนวงเล็บปีกกา "}" คลุม 2 ถึง 10 แถว พร้อมเขียนยอดเงินเพียงครั้งเดียว (เช่น เขียน 201, 203 แล้วรวบปีกกา = 30 หรือเขียนเลขเรียงลงมาแล้วเขียน 20 ที่บรรทัดแรกพร้อมลากเส้นตรง "|" ลงมาจนสุดกลุ่ม หรือรวบปีกกา "} 28×25")
   - กฎเหล็ก: เมื่อพบเส้นลากยาวแนวตั้ง "|" หรือปีกกา "}" คลุมกลุ่มตัวเลข ให้คัดลอกและกระจายยอดเงิน (amtText) นั้นใส่ให้ครบทุกแถวที่อยู่ในขอบเขตของปีกกาหรือเส้นลากยาวนั้น ห้ามปล่อยให้แถวใต้ปีกกามียอดเงินว่างเด็ดขาด!
5. ข้อควรระวังพิเศษสำหรับลายมือคนไทยในโพยหวยจริง:
   - เลข "4" เขียนหัวแหลมปิดเป็นรูปสามเหลี่ยมคล้ายตัว "A" หรือ "Δ" (พบบ่อยมาก เช่น "A9" คือ "49", "9A" คือ "94", "2A0" คือ "240", "2A×2A" คือ "24×24", "A8×2A" คือ "48×24", "2AA×3" คือ "244×3", "AA9×3" คือ "449×3", "1AA" คือ "144", "A0" คือ "40", "11A×3" คือ "114×3") ให้แปลง "A" หรือ "Δ" เป็นเลข "4" เสมอ
   - เครื่องหมายคูณ "×" ในโพยสมุดเส้นบางครั้งคนเขียนลากเร็วคล้ายเครื่องหมายบวก "+" (เช่น "514 = 33+30" คือ "514 = 33×30", "55+50" คือ "55×50") และเครื่องหมายเท่ากับ "=" บางครั้งเขียนคล้ายตัว "z" หรือ "2"
   - การเขียนชุดกลับคร่อมเส้นแบ่งช่อง เช่น "144 ×3 = 264", "922×3 = 99", "563×6 = 132", "112×3 = 33", "998×3 = 60": ให้แยกช่องตัวเลข numText เป็น "144×3" (หรือ "922×3", "563×6") และช่องยอดเงิน amtText เป็นยอดรวมหลังเครื่องหมายเท่ากับ คือ "264" (หรือ "99", "132", "33", "60")
   - เลข "11" เวลาเขียนเร็วๆ เส้นจะติดกันคล้ายตัว "n" หรือ "ก" (เช่น "n×n" คือ "11×11", "22×n" คือ "22×11")
   - เลข "110" เวลาเขียนเร็วๆ จะดูคล้าย "no" หรือ "n0" (เช่น "no×no" คือ "110×110", "55×no" คือ "55×110")
   - เรทยอดเงินในโพยจริงมีทั้งเรทพหูคูณของ 11 (11, 22, 33, 44, 55, 66, 77, 110, 132), เรทผสม 11×10 (เช่น 33×30, 55×50, 22×20, 44×40, 11×10, 132×120), เรทพหูคูณของ 10/5 (10, 15, 20, 25, 30, 40, 50, 60, 100) และเรทพหูคูณของ 12 (12, 24, 36, 48, 72, 108, 120, 144, 360 เช่น 24×24, 48×24)
   - กฎคณิตศาสตร์ช่วยเช็ค:
     * ถ้าช่องเลขลงท้ายด้วย "×6" เลข 3 ตัวข้างหน้าต้องเป็นเลขไม่ซ้ำกันเลย 3 หลัก และยอดเงินรวมต้องหารด้วย 6 ลงตัว (เช่น 60, 66, 120, 132)
     * ถ้าช่องเลขลงท้ายด้วย "×3" เลข 3 ตัวข้างหน้าต้องมีเลขซ้ำกัน 1 คู่ (เลขเบิ้ล เช่น 977, 144, 244, 449, 922, 112, 998) และยอดเงินรวมต้องหารด้วย 3 ลงตัว (เช่น 15, 30, 33, 60, 66, 72, 99, 108, 132, 264, 360, 990)
6. หากแถวใดมีรอยขีดฆ่า เขียนทับ หรือลายมือกำกวมไม่ชัดเจน ให้ตั้งค่า needsReview = true และระบุเหตุผลในช่อง note`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sheetDate: { type: 'STRING', description: 'วันที่ในหัวกระดาษ เช่น 16/11 หรือ 1/11/69' },
    sheetPage: { type: 'STRING', description: 'แผ่นที่ เช่น 1 หรือ 2' },
    customerName: { type: 'STRING', description: 'ชื่อในหัวกระดาษ (ถ้ามี เช่น ลุงปั่น, ไก่)' },
    totalColumnsDetected: { type: 'INTEGER', description: 'จำนวนคอลัมน์ทั้งหมดที่มีข้อมูลในหน้ากระดาษนี้ เช่น 2, 4, 5 หรือ 8' },
    rotationNeededDeg: { type: 'INTEGER', description: 'องศาที่ต้องหมุนภาพตามเข็มนาฬิกาเพื่อให้กระดาษตั้งตรง (0, 90, 180, หรือ 270)' },
    tableBox: {
      type: 'ARRAY',
      description: 'พิกัดกรอบตารางทั้งหมดในสเกล 0 ถึง 1000 รูปแบบ [ymin, xmin, ymax, xmax]',
      items: { type: 'NUMBER' }
    },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          col: { type: 'INTEGER', description: 'หมายเลขคอลัมน์ 1 ถึง 10 (เรียงจากซ้ายไปขวาตามแนวอ่าน)' },
          row: { type: 'INTEGER', description: 'หมายเลขแถว 1 ถึง 40 (เรียงจากบนลงล่างในคอลัมน์นั้น)' },
          colHeader: { type: 'STRING', description: 'ข้อความหัวคอลัมน์ เช่น ห.ท.1, โต๊ด ห.ท.1, ล.บ, 2 ล่าง' },
          categoryHint: {
            type: 'STRING',
            description: 'ประเภทหวยของรายการนี้: 3_top (3 ตัวบน/ตรง/ตรง×โต๊ด/ชุดกลับ), 3_toad (3 ตัวโต๊ดล้วน), 2_top (2 ตัวบน), 2_bottom (2 ตัวล่าง), 2_bottom_top (2 ตัว ล่าง×บน)'
          },
          numText: { type: 'STRING', description: 'ตัวเลขที่อ่านได้ เช่น 072×6, 144×3, 426, 79 (แปลงตัว A หรือ Δ เป็นเลข 4 เสมอ)' },
          amtText: { type: 'STRING', description: 'ยอดเงินที่อ่านได้ เช่น 66, 264, 33×30, 24×24, 110×110 (หากมีปีกกา } หรือเส้นลากยาว | ให้คัดลอกยอดเงินใส่ทุกแถวในกลุ่ม)' },
          confidence: { type: 'NUMBER', description: 'ความมั่นใจ 0.0 ถึง 1.0' },
          needsReview: { type: 'BOOLEAN', description: 'true ถ้ามีรอยขีดฆ่าหรือตัวเลขก้ำกึ่ง' },
          note: { type: 'STRING', description: 'หมายเหตุถ้ามีรอยขีดฆ่า ปีกการ่วม หรือจุดที่ควรตรวจซ้ำ' },
          box2d: {
            type: 'ARRAY',
            description: 'พิกัดของช่องรายการนี้บนรูปภาพ ในสเกล 0 ถึง 1000 รูปแบบ [ymin, xmin, ymax, xmax]',
            items: { type: 'NUMBER' }
          }
        },
        required: ['col', 'row', 'numText', 'amtText']
      }
    }
  },
  required: ['items']
};

/**
 * Builds dynamic prompt instructions from the self-learning memory database (`learnedRules`)
 * so Gemini 2.5 Pro learns from every human correction over time!
 */
function buildLearnedMemoryPrompt(learnedRules = [], customerName = '') {
  if (!Array.isArray(learnedRules) || learnedRules.length === 0) return '';

  // Prioritize rules learned from this specific runner + global rules
  const relevant = learnedRules.filter(
    r => !customerName || r.customerName === customerName || r.customerName === 'ทุกสาย (Global)'
  );
  const rulesToUse = relevant.length > 0 ? relevant : learnedRules.slice(0, 20);

  const lines = rulesToUse.slice(0, 25).map((r, idx) => {
    return `${idx + 1}. [สาย: ${r.customerName}] หากเห็นลายมือช่อง${r.field === 'amtText' ? 'ยอดเงิน' : 'ตัวเลข'}เขียนคล้าย "${r.wrongText}" ให้แปลงเป็น "${r.correctText}" (${r.reason || 'แอดมินเคยแก้ไขและยืนยันแล้ว'})`;
  });

  return `\n\n🧠 ความรู้สะสมจากการแก้ไขของแอดมินในอดีต (Self-Learning Memory สำหรับ "${customerName || 'ทั่วไป'}"):\nกรุณาใช้กฎที่เรียนรู้แล้วด้านล่างนี้ในการอ่านลายมือโพยใบนี้ด้วย:\n${lines.join('\n')}`;
}

/**
 * Applies deterministic post-OCR corrections based on previously learned rules.
 */
function applyLearnedCorrectionsToRow(item, learnedRules = [], customerName = '') {
  if (!Array.isArray(learnedRules) || learnedRules.length === 0) return item;

  let numText = String(item.numText || '').trim();
  let amtText = String(item.amtText || '').trim();
  let appliedNote = item.note || '';

  for (const rule of learnedRules) {
    const matchesCustomer =
      !rule.customerName ||
      rule.customerName === 'ทุกสาย (Global)' ||
      rule.customerName === customerName;
    if (!matchesCustomer) continue;

    if (rule.field === 'numText' && numText === rule.wrongText) {
      numText = rule.correctText;
      appliedNote = appliedNote
        ? `${appliedNote} | 🧠 แก้อัตโนมัติจากความจำ AI (${rule.wrongText}➔${rule.correctText})`
        : `🧠 แก้อัตโนมัติจากความจำ AI (${rule.wrongText}➔${rule.correctText})`;
    } else if (rule.field === 'amtText' && amtText === rule.wrongText) {
      amtText = rule.correctText;
      appliedNote = appliedNote
        ? `${appliedNote} | 🧠 แก้อัตโนมัติจากความจำ AI (${rule.wrongText}➔${rule.correctText})`
        : `🧠 แก้อัตโนมัติจากความจำ AI (${rule.wrongText}➔${rule.correctText})`;
    }
  }

  return {
    ...item,
    numText,
    amtText,
    note: appliedNote
  };
}

function inferCategoryHint(item = {}) {
  const rawHint = String(item.categoryHint || '').trim();
  const header = String(item.colHeader || '').trim();
  if (rawHint === '3_toad' || /โต๊ด/.test(header)) return '3_toad';
  if (rawHint === '2_bottom_top' || /ล[\.\-\s]?บ|ล่าง[\.\-\s]?บน/.test(header)) return '2_bottom_top';
  if (rawHint === '2_bottom' || /2\s*ล่าง|^ล่าง$/.test(header)) return '2_bottom';
  if (rawHint === '2_top' || /2\s*บน/.test(header)) return '2_top';
  return rawHint || '3_top';
}

async function callGeminiVisionAPI({ base64Image, mimeType = 'image/jpeg', apiKey, model = 'gemini-2.5-pro', customPrompt = '', learnedMemoryPrompt = '' }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');

  const body = {
    systemInstruction: {
      parts: [{ text: LOTTERY_OCR_SYSTEM_PROMPT + learnedMemoryPrompt }]
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: cleanBase64
            }
          },
          {
            text:
              customPrompt ||
              'อ่านข้อมูลโพยหวยในภาพนี้ทุกคอลัมน์ (ไม่ว่าจะเป็นโพย 2, 4, 5 หรือ 8 คอลัมน์ หรือภาพถ่ายตะแคง 90 องศา) และทุกแถวอย่างละเอียด ห้ามข้ามแม้แต่แถวเดียว พร้อมอ่านหัวตาราง (colHeader เช่น ห.ท.1, โต๊ด ห.ท.1, ล.บ, 2 ล่าง) กระจายยอดเงินที่มีปีกกา } หรือเส้นลากยาว | ให้ครบทุกแถวในกลุ่ม แปลงเลข 4 ที่เขียนคล้ายตัว A หรือ Δ ให้ถูกต้อง และตรวจสอบตามกฎ ×6 และ ×3'
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textOutput = data?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
  if (!textOutput) {
    throw new Error('Gemini API ไม่ได้ส่งผลลัพธ์ JSON กลับมา');
  }

  const parsed = JSON.parse(textOutput);
  const usage = data?.usageMetadata || {};
  return { parsed, usage };
}

async function analyzeSlipImage({ base64Image, columnSlices, useFullImage = true, mimeType = 'image/jpeg', settings = {}, learnedRules = [], customerName = '', allowDemoFallback = false }) {
  const apiKey = (settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  const model = settings.geminiModel || 'gemini-2.5-pro';
  const learnedMemoryPrompt = buildLearnedMemoryPrompt(learnedRules, customerName);

  if (apiKey) {
    let rawItems = [];
    let sheetDate = '16/11';
    let sheetPage = '1';
    let rotationNeededDeg = 0;
    let parsedTableBox = [141, 142, 914, 975];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    if (!useFullImage && Array.isArray(columnSlices) && columnSlices.length === 4) {
      const colPromises = columnSlices.map((colBase64, idx) => {
        const colNum = idx + 1;
        return callGeminiVisionAPI({
          base64Image: colBase64,
          mimeType: 'image/jpeg',
          apiKey,
          model,
          learnedMemoryPrompt,
          customPrompt: `ภาพนี้คือคอลัมน์ที่ ${colNum} ของโพยหวย (มีแถวที่ 1 ถึง 30) ของ "${customerName || 'เด็กโพย'}" กรุณาอ่านตัวเลขช่องซ้ายและจำนวนเงินช่องขวาของคอลัมน์ที่ ${colNum} ให้ครบทั้ง 30 แถว โดยกำหนด col = ${colNum} และ row = 1 ถึง 30 ตามลำดับ`
        });
      });

      const colResults = await Promise.all(colPromises);
      for (let i = 0; i < colResults.length; i++) {
        const colNum = i + 1;
        const { parsed, usage } = colResults[i];
        totalInputTokens += usage.promptTokenCount || 0;
        totalOutputTokens += usage.candidatesTokenCount || 0;
        for (const it of parsed.items || []) {
          rawItems.push({ ...it, col: colNum });
        }
      }
    } else {
      const { parsed, usage } = await callGeminiVisionAPI({
        base64Image,
        mimeType,
        apiKey,
        model,
        learnedMemoryPrompt
      });
      sheetDate = parsed.sheetDate || sheetDate;
      sheetPage = parsed.sheetPage || sheetPage;
      const rawRot = Number(parsed.rotationNeededDeg);
      if ([0, 90, 180, 270].includes(rawRot)) {
        rotationNeededDeg = rawRot;
      }
      if (Array.isArray(parsed.tableBox) && parsed.tableBox.length === 4) {
        parsedTableBox = parsed.tableBox;
      }
      rawItems = parsed.items || [];
      totalInputTokens = usage.promptTokenCount || 0;
      totalOutputTokens = usage.candidatesTokenCount || 0;
    }

    const validatedItems = rawItems.map(rawIt => {
      const item = applyLearnedCorrectionsToRow(rawIt, learnedRules, customerName);
      const categoryHint = inferCategoryHint(item);
      const parsedRow = parseAndValidateRow(
        {
          col: item.col || 1,
          row: item.row || 1,
          colHeader: item.colHeader || '',
          categoryHint,
          numText: item.numText || '',
          amtText: item.amtText || '',
          confidence: item.confidence ?? 0.96,
          needsReview: Boolean(item.needsReview),
          note: item.note || ''
        },
        settings
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

    const inputCostUSD = (totalInputTokens / 1_000_000) * 1.25;
    const outputCostUSD = (totalOutputTokens / 1_000_000) * 10.0;
    const estimatedCostTHB = +((inputCostUSD + outputCostUSD) * 34.5).toFixed(4);

    return {
      mode: 'live_gemini',
      modelUsed: model,
      learnedRulesApplied: learnedRules.length,
      sheetDate,
      sheetPage,
      rotationNeededDeg,
      tableBox: parsedTableBox,
      items: validatedItems,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        estimatedCostTHB
      }
    };
  }

  if (!allowDemoFallback) {
    return {
      mode: 'missing_api_key',
      modelUsed: 'รอตั้งค่า Gemini API Key',
      learnedRulesApplied: learnedRules.length,
      sheetDate: '',
      sheetPage: '1',
      rotationNeededDeg: 0,
      items: [],
      error: 'ยังไม่ได้ตั้งค่า Gemini API Key ในเมนู 7. ตั้งค่า ➔ 2. โมเดล AI & รหัส API'
    };
  }

  // Fallback Demo Simulation Mode
  const simulatedItems = [];
  for (const colStr of ['1', '2', '3', '4']) {
    const col = parseInt(colStr, 10);
    for (const r of RAW_COLUMNS_16_11[col]) {
      const itemWithMemory = applyLearnedCorrectionsToRow(
        { col, row: r.row, numText: r.numText, amtText: r.amtText, note: r.note || '', needsReview: Boolean(r.needsReview) },
        learnedRules,
        customerName
      );
      const parsedRow = parseAndValidateRow(
        {
          col,
          row: r.row,
          numText: itemWithMemory.numText,
          amtText: itemWithMemory.amtText,
          note: itemWithMemory.note || '',
          needsReview: Boolean(itemWithMemory.needsReview),
          confidence: itemWithMemory.needsReview ? 0.86 : 0.99
        },
        settings
      );
      simulatedItems.push({
        ...parsedRow,
        ocrOriginalNumText: parsedRow.numText,
        ocrOriginalAmtText: parsedRow.amtText
      });
    }
  }

  return {
    mode: 'demo_simulation',
    modelUsed: `${model} (พร้อมความจำ AI สะสม ${learnedRules.length} กฎ)`,
    learnedRulesApplied: learnedRules.length,
    sheetDate: '16/11',
    sheetPage: '1',
    items: simulatedItems,
    usage: {
      inputTokens: 1850,
      outputTokens: 4200,
      estimatedCostTHB: 0.24
    }
  };
}

module.exports = {
  analyzeSlipImage,
  buildLearnedMemoryPrompt,
  applyLearnedCorrectionsToRow,
  LOTTERY_OCR_SYSTEM_PROMPT
};
