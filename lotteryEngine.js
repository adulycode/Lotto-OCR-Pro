// Core Lottery Parsing, 4-Layer Mathematical Validation, Permutation Expansion & Aggregation Engine

function normalizeHandwritingAmount(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Common handwriting OCR fix: "n" -> "11", "no" / "n0" -> "110"
  s = s.replace(/no|n0|ก0/gi, '110');
  s = s.replace(/n|ก/gi, '11');
  s = s.replace(/[xX\*]/g, '×');
  s = s.replace(/\s+/g, '');
  return s;
}

function normalizeHandwritingNumber(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/[xX\*]/g, '×');
  s = s.replace(/no|n0/gi, '110');
  s = s.replace(/n/gi, '11');
  s = s.replace(/[lI|]/g, '1');
  s = s.replace(/[oO]/g, '0');
  s = s.replace(/\s+/g, '');
  return s;
}

function getUniquePermutations3(numStr) {
  if (!numStr || numStr.length !== 3) return [numStr];
  const chars = numStr.split('');
  const set = new Set();
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        if (i !== j && j !== k && i !== k) {
          set.add(chars[i] + chars[j] + chars[k]);
        }
      }
    }
  }
  return Array.from(set);
}

function getUniquePermutations2(numStr) {
  if (!numStr || numStr.length !== 2) return [numStr];
  const a = numStr[0];
  const b = numStr[1];
  return a === b ? [numStr] : [a + b, b + a];
}

/**
 * Parses a single row (numText, amtText, columnHeader) into structured bet components
 * and runs 4-Layer Mathematical Cross-Checks.
 */
function parseAndValidateRow({ col = 1, row = 1, numText = '', amtText = '', categoryHint = '3_top', note = '', needsReview = false, confidence = 0.99 }, settings = {}) {
  const cleanNum = normalizeHandwritingNumber(numText);
  const cleanAmt = normalizeHandwritingAmount(amtText);

  const warnings = [];
  if (note) warnings.push(note);

  if (!cleanNum && !cleanAmt) {
    return {
      col,
      row,
      numText: '',
      amtText: '',
      isEmpty: true,
      baseNumber: '',
      patternType: 'empty',
      patternLabel: '-',
      straightAmt: 0,
      toadAmt: 0,
      bottomAmt: 0,
      permCount: 1,
      permTotalAmt: 0,
      rowTotalMoney: 0,
      permutations: [],
      isValid: true,
      needsReview: false,
      confidence: 1,
      warnings: []
    };
  }

  let baseNumber = '';
  let permMult = null; // 6, 3, 2, or null

  // Match number e.g. "072×6", "979×3", "426", "21"
  const numMatch = cleanNum.match(/^(\d{2,3})(?:×(\d+))?$/);
  if (numMatch) {
    baseNumber = numMatch[1];
    if (numMatch[2]) {
      permMult = parseInt(numMatch[2], 10);
    }
  } else {
    baseNumber = cleanNum.replace(/[^\d]/g, '').slice(0, 3);
    warnings.push(`รูปแบบตัวเลข "${numText}" ไม่ชัดเจน กรุณาตรวจสอบ`);
  }

  const isThreeDigit = baseNumber.length === 3;
  const isTwoDigit = baseNumber.length === 2;

  let straightAmt = 0;
  let toadAmt = 0;
  let bottomAmt = 0;
  let permTotalAmt = 0;
  let patternType = '';
  let patternLabel = '';
  let rowTotalMoney = 0;

  // Parse amount: either "66", "132" or "22×22", "55×110", "22×11"
  const amtMatch = cleanAmt.match(/^(\d+)(?:×(\d+))?$/);
  const amt1 = amtMatch ? parseInt(amtMatch[1], 10) : 0;
  const amt2 = amtMatch && amtMatch[2] !== undefined ? parseInt(amtMatch[2], 10) : null;

  if (!amtMatch) {
    warnings.push(`รูปแบบยอดเงิน "${amtText}" อ่านไม่ชัดเจน`);
  }

  if (isThreeDigit) {
    const perms = getUniquePermutations3(baseNumber);
    if (permMult !== null) {
      // Pattern: 072×6 = 66 or 979×3 = 66
      patternType = `3_perm_${permMult}`;
      patternLabel = `3 ตัวชุดกลับ (×${permMult})`;
      permTotalAmt = amt1;
      rowTotalMoney = amt1;

      // Mathematical Cross-Check 1: Does permutation count match the digits?
      if (perms.length !== permMult) {
        warnings.push(
          `กติกาคณิตศาสตร์: เลข ${baseNumber} สลับได้ ${perms.length} ประตู แต่ในโพยเขียน ×${permMult} (อาจอ่านเลขผิด เช่น เลขเบิ้ล/ไม่เบิ้ล)`
        );
      }
      // Mathematical Cross-Check 2: Is total amount divisible by permMult?
      if (permMult > 0 && permTotalAmt % permMult !== 0) {
        warnings.push(
          `กติกาหารลงตัว: ยอดเงิน ${permTotalAmt} บาท หารด้วย ${permMult} ประตูไม่ลงตัว (${(permTotalAmt / permMult).toFixed(2)} บ./ประตู)`
        );
      }
      if (amt2 !== null) {
        warnings.push(`พบเครื่องหมาย × ซ้ำในช่องจำนวนเงิน (${cleanAmt}) ของเลขชุดกลับ ×${permMult}`);
      }
    } else if (amt2 !== null) {
      // Pattern: 426 = 22×22 (3 ตัวตรง × โต๊ด)
      patternType = '3_straight_toad';
      patternLabel = '3 ตัว (ตรง×โต๊ด)';
      straightAmt = amt1;
      toadAmt = amt2;
      rowTotalMoney = amt1 + amt2;
    } else {
      // Pattern: 932 = 22 (3 ตัวบน/ตรง อย่างเดียว)
      patternType = '3_straight';
      patternLabel = '3 ตัวบน (ตรง)';
      straightAmt = amt1;
      rowTotalMoney = amt1;
    }
  } else if (isTwoDigit) {
    const perms = getUniquePermutations2(baseNumber);
    if (permMult === 2) {
      patternType = '2_perm_2';
      patternLabel = '2 ตัวชุดกลับ (×2)';
      permTotalAmt = amt1;
      rowTotalMoney = amt1;
      if (perms.length !== 2) {
        warnings.push(`เลขเบิ้ล ${baseNumber} ไม่สามารถกลับ ×2 ได้`);
      }
      if (permTotalAmt % 2 !== 0) {
        warnings.push(`ยอดเงิน ${permTotalAmt} บาท หาร 2 ประตูไม่ลงตัว`);
      }
    } else if (amt2 !== null) {
      patternType = '2_top_bottom';
      patternLabel = '2 ตัว (บน×ล่าง)';
      straightAmt = amt1; // 2 ตัวบน
      bottomAmt = amt2;   // 2 ตัวล่าง
      rowTotalMoney = amt1 + amt2;
    } else if (categoryHint === '2_bottom') {
      patternType = '2_bottom';
      patternLabel = '2 ตัวล่าง';
      bottomAmt = amt1;
      rowTotalMoney = amt1;
    } else {
      patternType = '2_top';
      patternLabel = '2 ตัวบน';
      straightAmt = amt1;
      rowTotalMoney = amt1;
    }
  } else {
    patternType = 'invalid';
    patternLabel = 'รูปแบบไม่ถูกต้อง';
    warnings.push(`ตัวเลข "${cleanNum}" ต้องเป็นเลข 2 หลัก หรือ 3 หลัก`);
  }

  // Mathematical Cross-Check 3: Base Multiple Check (e.g. multiples of 11 or 5 or 10)
  const enforceEleven = settings.checkMultiplesOf11 !== false;
  if (enforceEleven && rowTotalMoney > 0) {
    const checkUnit = (val, label) => {
      if (val > 0 && val % 11 !== 0 && val % 10 !== 0 && val % 5 !== 0) {
        warnings.push(`ยอด ${label} (${val} บาท) ไม่ใช่ทวีคูณของ 11, 10 หรือ 5 บาท กรุณาเช็ครูปต้นฉบับ`);
      }
    };
    if (permMult) {
      const perDoor = permTotalAmt / permMult;
      if (Number.isInteger(perDoor)) checkUnit(perDoor, 'ต่อประตู');
    } else {
      checkUnit(straightAmt, 'เต็ง/บน');
      checkUnit(toadAmt, 'โต๊ด');
      checkUnit(bottomAmt, 'ล่าง');
    }
  }

  const permutations = isThreeDigit
    ? getUniquePermutations3(baseNumber)
    : isTwoDigit
      ? getUniquePermutations2(baseNumber)
      : [baseNumber];

  const hasWarning = warnings.length > 0 || needsReview || confidence < 0.92;

  return {
    col,
    row,
    numText: cleanNum,
    amtText: cleanAmt,
    isEmpty: false,
    baseNumber,
    digitCount: baseNumber.length,
    patternType,
    patternLabel,
    permMult,
    straightAmt,
    toadAmt,
    bottomAmt,
    permTotalAmt,
    perDoorAmt: permMult ? +(permTotalAmt / permMult).toFixed(2) : 0,
    rowTotalMoney,
    permutations,
    isValid: warnings.length === 0,
    needsReview: hasWarning,
    confidence,
    warnings
  };
}

/**
 * Parses free-text LINE messages like:
 * "21 = 22"
 * "21 = 20x20"
 * "072x6 = 66"
 * "583 = 110x110"
 */
function parseFreeTextMessage(text, settings = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const items = [];
  let rowIdx = 1;

  for (const line of lines) {
    // Support formats:
    // "21 = 22 บาท", "21 = 20x20", "072x6 = 66", "583 110x110", "21 ล่าง 20"
    let categoryHint = '3_top';
    if (/ล่าง/.test(line) && !/บน/.test(line)) {
      categoryHint = '2_bottom';
    }
    const cleaned = line
      .replace(/บาท|บ\.|ตรงโต๊ด|บนล่าง|บน|ล่าง/g, ' ')
      .replace(/=/g, ' ')
      .trim();

    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const numText = parts[0];
      const amtText = parts[1];
      if (/\d{2,3}/.test(numText) && /\d+/.test(amtText)) {
        items.push(
          parseAndValidateRow(
            {
              col: 1,
              row: rowIdx++,
              numText,
              amtText,
              categoryHint
            },
            settings
          )
        );
      }
    }
  }
  return items;
}

/**
 * Aggregates all verified/active slips across all customers into a unified table.
 * Respects `settings.permutationMode`:
 * - 'expand': Expands 072×6 = 66 into 6 separate 3-digit straight entries (072=11, 027=11, 207=11, 270=11, 702=11, 720=11)
 *             and 979×3 = 66 into 3 separate 3-digit straight entries (979=22, 997=22, 799=22).
 * - 'keep_raw': Keeps 072×6 = 66 in a dedicated permAmt column on baseNumber '072' without splitting into 6 rows.
 */
function aggregateSlips(slips, settings = {}) {
  const permutationMode = settings.permutationMode || 'expand'; // 'expand' or 'keep_raw'
  const limits = settings.riskLimits || {
    threeStraight: 100,
    threeToad: 100,
    threePerm: 132,
    twoTop: 200,
    twoBottom: 200
  };

  // Map key: `${digitCount}_${number}`
  const map = new Map();

  function getOrCreate(number, digitCount) {
    const key = `${digitCount}_${number}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        number,
        digitCount,
        threeStraightAmt: 0, // 3 ตัวบน (ตรง + ที่แตกมาจาก ×6/×3 ถ้าเลือกโหมด expand)
        threeStraightDirectAmt: 0, // เฉพาะที่เขียนตรงๆ
        threeStraightFromPermAmt: 0, // เฉพาะที่แตกประตูมาจาก ×6 / ×3
        threeToadAmt: 0,     // 3 ตัวโต๊ด
        threePermRawAmt: 0,  // ยอดชุดกลับ ×6 / ×3 กรณีเลือกโหมด keep_raw
        twoTopAmt: 0,        // 2 ตัวบน
        twoBottomAmt: 0,     // 2 ตัวล่าง
        totalAmt: 0,
        contributors: []     // รายชื่อลูกค้าที่ส่งเลขนี้มา
      });
    }
    return map.get(key);
  }

  for (const slip of slips) {
    if (slip.status === 'cancelled') continue;

    for (const item of slip.items || []) {
      if (item.isEmpty || !item.baseNumber) continue;

      const dCount = item.baseNumber.length;

      if (dCount === 3) {
        if (item.permMult && item.permTotalAmt > 0) {
          if (permutationMode === 'expand') {
            // Mode 1: แยกเลข / กระจายประตูอัตโนมัติ
            const perms = item.permutations && item.permutations.length > 0
              ? item.permutations
              : getUniquePermutations3(item.baseNumber);
            const eachAmt = +(item.permTotalAmt / perms.length).toFixed(2);

            for (const pNum of perms) {
              const entry = getOrCreate(pNum, 3);
              entry.threeStraightAmt += eachAmt;
              entry.threeStraightFromPermAmt += eachAmt;
              entry.totalAmt += eachAmt;
              entry.contributors.push({
                slipId: slip.id,
                slipTitle: slip.title,
                customerName: slip.customerName,
                customerLineId: slip.customerLineId,
                source: slip.source,
                col: item.col,
                row: item.row,
                originalWrite: `${item.numText} = ${item.amtText}`,
                typeLabel: `แตกจาก ${item.numText} (ประตูละ ${eachAmt}฿)`,
                category: '3 ตัวบน (แตกประตู)',
                amount: eachAmt,
                createdAt: slip.createdAt
              });
            }
          } else {
            // Mode 2: คงตามหน้าโพย (ไม่แยกประตู)
            const entry = getOrCreate(item.baseNumber, 3);
            entry.threePermRawAmt += item.permTotalAmt;
            entry.totalAmt += item.permTotalAmt;
            entry.contributors.push({
              slipId: slip.id,
              slipTitle: slip.title,
              customerName: slip.customerName,
              customerLineId: slip.customerLineId,
              source: slip.source,
              col: item.col,
              row: item.row,
              originalWrite: `${item.numText} = ${item.amtText}`,
              typeLabel: `ชุดกลับ ×${item.permMult}`,
              category: `3 ตัวชุดกลับ ×${item.permMult}`,
              amount: item.permTotalAmt,
              createdAt: slip.createdAt
            });
          }
        } else {
          const entry = getOrCreate(item.baseNumber, 3);
          if (item.straightAmt > 0) {
            entry.threeStraightAmt += item.straightAmt;
            entry.threeStraightDirectAmt += item.straightAmt;
            entry.totalAmt += item.straightAmt;
            entry.contributors.push({
              slipId: slip.id,
              slipTitle: slip.title,
              customerName: slip.customerName,
              customerLineId: slip.customerLineId,
              source: slip.source,
              col: item.col,
              row: item.row,
              originalWrite: `${item.numText} = ${item.amtText}`,
              typeLabel: '3 ตัวบน (ตรง)',
              category: '3 ตัวบน (ตรง)',
              amount: item.straightAmt,
              createdAt: slip.createdAt
            });
          }
          if (item.toadAmt > 0) {
            entry.threeToadAmt += item.toadAmt;
            entry.totalAmt += item.toadAmt;
            entry.contributors.push({
              slipId: slip.id,
              slipTitle: slip.title,
              customerName: slip.customerName,
              customerLineId: slip.customerLineId,
              source: slip.source,
              col: item.col,
              row: item.row,
              originalWrite: `${item.numText} = ${item.amtText}`,
              typeLabel: '3 ตัวโต๊ด',
              category: '3 ตัวโต๊ด',
              amount: item.toadAmt,
              createdAt: slip.createdAt
            });
          }
        }
      } else if (dCount === 2) {
        if (item.permMult === 2 && item.permTotalAmt > 0) {
          if (permutationMode === 'expand') {
            const perms = getUniquePermutations2(item.baseNumber);
            const eachAmt = +(item.permTotalAmt / perms.length).toFixed(2);
            for (const pNum of perms) {
              const entry = getOrCreate(pNum, 2);
              entry.twoTopAmt += eachAmt;
              entry.totalAmt += eachAmt;
              entry.contributors.push({
                slipId: slip.id,
                slipTitle: slip.title,
                customerName: slip.customerName,
                customerLineId: slip.customerLineId,
                source: slip.source,
                col: item.col,
                row: item.row,
                originalWrite: `${item.numText} = ${item.amtText}`,
                typeLabel: `แตกจาก ${item.numText} (${eachAmt}฿)`,
                category: '2 ตัวบน (กลับ)',
                amount: eachAmt,
                createdAt: slip.createdAt
              });
            }
          } else {
            const entry = getOrCreate(item.baseNumber, 2);
            entry.twoTopAmt += item.permTotalAmt;
            entry.totalAmt += item.permTotalAmt;
            entry.contributors.push({
              slipId: slip.id,
              slipTitle: slip.title,
              customerName: slip.customerName,
              customerLineId: slip.customerLineId,
              source: slip.source,
              col: item.col,
              row: item.row,
              originalWrite: `${item.numText} = ${item.amtText}`,
              typeLabel: '2 ตัวชุดกลับ (×2)',
              category: '2 ตัวชุดกลับ',
              amount: item.permTotalAmt,
              createdAt: slip.createdAt
            });
          }
        } else {
          const entry = getOrCreate(item.baseNumber, 2);
          if (item.straightAmt > 0) {
            entry.twoTopAmt += item.straightAmt;
            entry.totalAmt += item.straightAmt;
            entry.contributors.push({
              slipId: slip.id,
              slipTitle: slip.title,
              customerName: slip.customerName,
              customerLineId: slip.customerLineId,
              source: slip.source,
              col: item.col,
              row: item.row,
              originalWrite: `${item.numText} = ${item.amtText}`,
              typeLabel: '2 ตัวบน',
              category: '2 ตัวบน',
              amount: item.straightAmt,
              createdAt: slip.createdAt
            });
          }
          if (item.bottomAmt > 0) {
            entry.twoBottomAmt += item.bottomAmt;
            entry.totalAmt += item.bottomAmt;
            entry.contributors.push({
              slipId: slip.id,
              slipTitle: slip.title,
              customerName: slip.customerName,
              customerLineId: slip.customerLineId,
              source: slip.source,
              col: item.col,
              row: item.row,
              originalWrite: `${item.numText} = ${item.amtText}`,
              typeLabel: '2 ตัวล่าง',
              category: '2 ตัวล่าง',
              amount: item.bottomAmt,
              createdAt: slip.createdAt
            });
          }
        }
      }
    }
  }

  // Compute risk & dealer layoff suggestions per aggregated number
  const results = Array.from(map.values()).map(r => {
    const excessThreeStraight = Math.max(0, r.threeStraightAmt - (limits.threeStraight || 100));
    const excessThreeToad = Math.max(0, r.threeToadAmt - (limits.threeToad || 100));
    const excessThreePerm = Math.max(0, r.threePermRawAmt - (limits.threePerm || 132));
    const excessTwoTop = Math.max(0, r.twoTopAmt - (limits.twoTop || 200));
    const excessTwoBottom = Math.max(0, r.twoBottomAmt - (limits.twoBottom || 200));

    const totalExcess =
      excessThreeStraight + excessThreeToad + excessThreePerm + excessTwoTop + excessTwoBottom;

    // Count distinct customers who bought this number
    const uniqueCustomers = new Set(r.contributors.map(c => c.customerName)).size;

    return {
      ...r,
      uniqueCustomers,
      hitCount: r.contributors.length,
      excessThreeStraight,
      excessThreeToad,
      excessThreePerm,
      excessTwoTop,
      excessTwoBottom,
      totalExcess,
      isOverLimit: totalExcess > 0
    };
  });

  // Sort by total amount descending, then number ascending
  results.sort((a, b) => b.totalAmt - a.totalAmt || a.number.localeCompare(b.number));

  return results;
}

module.exports = {
  normalizeHandwritingAmount,
  normalizeHandwritingNumber,
  getUniquePermutations3,
  getUniquePermutations2,
  parseAndValidateRow,
  parseFreeTextMessage,
  aggregateSlips
};
