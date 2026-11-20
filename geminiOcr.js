// Gemini 2.5 Pro High-Precision Lottery Slip OCR Engine with Self-Learning Handwriting Memory

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { parseAndValidateRow } = require('./lotteryEngine');
const { RAW_COLUMNS_16_11 } = require('./seedData');

const LOTTERY_OCR_SYSTEM_PROMPT = `คุณคือระบบ AI OCR ผู้เชี่ยวชาญการอ่านโพยหวยไทยแบบเขียนด้วยลายมือที่มีความแม่นยำสูงสุด (Zero-Error Financial Grade)
กฎสำคัญในการอ่านลายมือโพยหวยนี้:
1. ตารางมาตรฐานจะมี 4 คอลัมน์ (คอลัมน์ละ 30 แถว มีเลขกำกับแถว 1 ถึง 30 ทางซ้าย) หรืออาจเป็นโพยเขียนอิสระ
2. ในแต่ละแถวจะมี 2 ช่องย่อย:
   - ช่องซ้าย (numText): ตัวเลขหวย 3 ตัว หรือ 2 ตัว อาจมีเครื่องหมายคูณชุดกลับต่อท้าย เช่น "072×6" (กลับ 6 ประตู) หรือ "979×3" (เลขเบิ้ลกลับ 3 ประตู) หรือเลขเดี่ยว เช่น "426", "317"
   - ช่องขวา (amtText): จำนวนเงิน เช่น "66", "132", "22", "44", "33" หรือแบบ ตรง×โต๊ด เช่น "22×22", "55×55", "55×110", "22×11", "11×11", "110×110"
3. ข้อควรระวังพิเศษสำหรับลายมือคนไทยในโพยนี้:
   - เลข "11" เวลาเขียนเร็วๆ เส้นจะติดกันคล้ายตัว "n" หรือ "ก" (เช่น "n×n" คือ "11×11", "22×n" คือ "22×11")
   - เลข "110" เวลาเขียนเร็วๆ จะดูคล้าย "no" หรือ "n0" (เช่น "no×no" คือ "110×110", "55×no" คือ "55×110")
   - เลขยอดเงินมักเป็นพหูคูณของ 11 เสมอ (11, 22, 33, 44, 55, 66, 110, 132)
   - กฎคณิตศาสตร์ช่วยเช็ค:
     * ถ้าช่องเลขลงท้ายด้วย "×6" เลข 3 ตัวข้างหน้าต้องเป็นเลขไม่ซ้ำกันเลย 3 หลัก และยอดเงินมักเป็น 66 หรือ 132
     * ถ้าช่องเลขลงท้ายด้วย "×3" เลข 3 ตัวข้างหน้าต้องมีเลขซ้ำกัน 1 คู่ (เลขเบิ้ล เช่น 977, 877, 600, 668, 188, 993) และยอดเงินมักเป็น 33, 66 หรือ 132
4. หากแถวใดมีรอยขีดฆ่า เขียนทับ หรือลายมือกำกวมไม่ชัดเจน ให้ตั้งค่า needsReview = true และระบุเหตุผลในช่อง note`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sheetDate: { type: 'STRING', description: 'วันที่ในหัวกระดาษ เช่น 16/11' },
    sheetPage: { type: 'STRING', description: 'แผ่นที่ เช่น 1' },
    customerName: { type: 'STRING', description: 'ชื่อในหัวกระดาษ (ถ้ามี)' },
    tableBox: {
      type: 'ARRAY',
      description: 'พิกัดกรอบตารางทั้ง 30 แถว (ไม่รวมหัวตารางและแถวรวมด้านล่าง) ในสเกล 0 ถึง 1000 รูปแบบ [ymin, xmin, ymax, xmax]',
      items: { type: 'NUMBER' }
    },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          col: { type: 'INTEGER', description: 'หมายเลขคอลัมน์ 1 ถึง 4' },
          row: { type: 'INTEGER', description: 'หมายเลขแถว 1 ถึง 30' },
          numText: { type: 'STRING', description: 'ตัวเลขที่อ่านได้ เช่น 072×6, 979×3, 426' },
          amtText: { type: 'STRING', description: 'ยอดเงินที่อ่านได้ เช่น 66, 22×22, 110×110, 22×11' },
          confidence: { type: 'NUMBER', description: 'ความมั่นใจ 0.0 ถึง 1.0' },
          needsReview: { type: 'BOOLEAN', description: 'true ถ้ามีรอยขีดฆ่าหรือตัวเลขก้ำกึ่ง' },
          note: { type: 'STRING', description: 'หมายเหตุถ้ามีรอยขีดฆ่าหรือจุดที่ควรตรวจซ้ำ' },
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
              'อ่านข้อมูลโพยหวยในภาพนี้ทุกคอลัมน์และทุกแถว (คอลัมน์ 1 ถึง 4, แถว 1 ถึง 30) อย่างละเอียด ห้ามข้ามแม้แต่แถวเดียว และตรวจสอบความถูกต้องตามกฎ ×6 และ ×3 พร้อมใช้ความรู้สะสมที่แอดมินเคยสอนไว้'
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

async function analyzeSlipImage({ base64Image, columnSlices, mimeType = 'image/jpeg', settings = {}, learnedRules = [], customerName = '' }) {
  const apiKey = (settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  const model = settings.geminiModel || 'gemini-2.5-pro';
  const learnedMemoryPrompt = buildLearnedMemoryPrompt(learnedRules, customerName);

  if (apiKey) {
    let rawItems = [];
    let sheetDate = '16/11';
    let sheetPage = '1';
    let parsedTableBox = [141, 142, 914, 975];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    if (Array.isArray(columnSlices) && columnSlices.length === 4) {
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
      if (Array.isArray(parsed.tableBox) && parsed.tableBox.length === 4) {
        parsedTableBox = parsed.tableBox;
      }
      rawItems = parsed.items || [];
      totalInputTokens = usage.promptTokenCount || 0;
      totalOutputTokens = usage.candidatesTokenCount || 0;
    }

    const validatedItems = rawItems.map(rawIt => {
      const item = applyLearnedCorrectionsToRow(rawIt, learnedRules, customerName);
      const parsedRow = parseAndValidateRow(
        {
          col: item.col || 1,
          row: item.row || 1,
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
      tableBox: parsedTableBox,
      items: validatedItems,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        estimatedCostTHB
      }
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
