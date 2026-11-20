// Core Lottery Parsing, 4-Layer Mathematical Validation, Time-Based Restricted Numbers (100% vs 50%) & Aggregation Engine

function normalizeHandwritingAmount(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
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
  let permMult = null;

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

  const amtMatch = cleanAmt.match(/^(\d+)(?:×(\d+))?$/);
  const amt1 = amtMatch ? parseInt(amtMatch[1], 10) : 0;
  const amt2 = amtMatch && amtMatch[2] !== undefined ? parseInt(amtMatch[2], 10) : null;

  if (!amtMatch) {
    warnings.push(`รูปแบบยอดเงิน "${amtText}" อ่านไม่ชัดเจน`);
  }

  if (isThreeDigit) {
    const perms = getUniquePermutations3(baseNumber);
    if (permMult !== null) {
      patternType = `3_perm_${permMult}`;
      patternLabel = `3 ตัวชุดกลับ (×${permMult})`;
      permTotalAmt = amt1;
      rowTotalMoney = amt1;

      if (perms.length !== permMult) {
        warnings.push(
          `กติกาคณิตศาสตร์: เลข ${baseNumber} สลับได้ ${perms.length} ประตู แต่ในโพยเขียน ×${permMult} (อาจอ่านเลขผิด เช่น เลขเบิ้ล/ไม่เบิ้ล)`
        );
      }
      if (permMult > 0 && permTotalAmt % permMult !== 0) {
        warnings.push(
          `กติกาหารลงตัว: ยอดเงิน ${permTotalAmt} บาท หารด้วย ${permMult} ประตูไม่ลงตัว (${(permTotalAmt / permMult).toFixed(2)} บ./ประตู)`
        );
      }
      if (amt2 !== null) {
        warnings.push(`พบเครื่องหมาย × ซ้ำในช่องจำนวนเงิน (${cleanAmt}) ของเลขชุดกลับ ×${permMult}`);
      }
    } else if (amt2 !== null) {
      patternType = '3_straight_toad';
      patternLabel = '3 ตัว (ตรง×โต๊ด)';
      straightAmt = amt1;
      toadAmt = amt2;
      rowTotalMoney = amt1 + amt2;
    } else {
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
      straightAmt = amt1;
      bottomAmt = amt2;
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

function parseFreeTextMessage(text, settings = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const items = [];
  let rowIdx = 1;

  for (const line of lines) {
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
 * Checks if a number is restricted (เลขอั้น 50%) in the given draw,
 * and determines whether a slip created at `slipCreatedAt` gets 100% (before cutoff) or 50% (after cutoff).
 */
function evaluateNumberRestriction(number, slipCreatedAt, restrictedList = []) {
  if (!Array.isArray(restrictedList) || restrictedList.length === 0) {
    return {
      isRestrictedNumber: false,
      payoutPercentForThisSlip: 100,
      isBeforeCutoff: true,
      restrictionInfo: null
    };
  }

  const rule = restrictedList.find(r => r.number === number);
  if (!rule) {
    return {
      isRestrictedNumber: false,
      payoutPercentForThisSlip: 100,
      isBeforeCutoff: true,
      restrictionInfo: null
    };
  }

  const slipTime = new Date(slipCreatedAt || Date.now()).getTime();
  const cutoffTime = new Date(rule.announcedAt).getTime();
  const isBeforeCutoff = slipTime < cutoffTime;

  return {
    isRestrictedNumber: true,
    payoutPercentForThisSlip: isBeforeCutoff ? 100 : (rule.payoutPercent ?? 50),
    isBeforeCutoff,
    restrictionInfo: rule
  };
}

/**
 * Aggregates slips for a specific draw period (งวดหวย).
 * Separates amounts submitted BEFORE the dealer's half-payout cutoff (100% payout)
 * vs AFTER the dealer's half-payout cutoff (50% payout).
 */
function aggregateSlips(slips, settings = {}, restrictedList = []) {
  const permutationMode = settings.permutationMode || 'expand';
  const limits = settings.riskLimits || {
    threeStraight: 100,
    threeToad: 100,
    threePerm: 132,
    twoTop: 30,
    twoBottom: 100
  };

  const map = new Map();

  function getOrCreate(number, digitCount) {
    const key = `${digitCount}_${number}`;
    if (!map.has(key)) {
      const rule = (restrictedList || []).find(r => r.number === number) || null;
      map.set(key, {
        key,
        number,
        digitCount,
        isRestricted: Boolean(rule),
        restrictedRule: rule,
        threeStraightAmt: 0,
        threeStraightDirectAmt: 0,
        threeStraightFromPermAmt: 0,
        threeToadAmt: 0,
        threePermRawAmt: 0,
        twoTopAmt: 0,
        twoBottomAmt: 0,
        totalAmt: 0,
        fullPayout100Amt: 0, // ยอดที่ส่งมาก่อนเวลาเจ้ามืออั้น (จ่ายเต็ม 100%)
        halfPayout50Amt: 0,  // ยอดที่ส่งมาหลังเวลาเจ้ามืออั้น (จ่ายครึ่ง 50%)
        contributors: []
      });
    }
    return map.get(key);
  }

  function addContribution(entry, slip, item, amount, typeLabel, category) {
    const evalRes = evaluateNumberRestriction(entry.number, slip.createdAt, restrictedList);
    if (evalRes.payoutPercentForThisSlip === 100) {
      entry.fullPayout100Amt += amount;
    } else {
      entry.halfPayout50Amt += amount;
    }

    entry.contributors.push({
      slipId: slip.id,
      slipTitle: slip.title,
      customerName: slip.customerName,
      customerLineId: slip.customerLineId,
      source: slip.source,
      col: item.col,
      row: item.row,
      originalWrite: `${item.numText} = ${item.amtText}`,
      typeLabel,
      category,
      amount,
      createdAt: slip.createdAt,
      payoutPercent: evalRes.payoutPercentForThisSlip,
      isBeforeCutoff: evalRes.isBeforeCutoff,
      isRestrictedNumber: evalRes.isRestrictedNumber,
      cutoffAnnouncedAt: evalRes.restrictionInfo?.announcedAt || null
    });
  }

  for (const slip of slips) {
    if (slip.status === 'cancelled') continue;

    for (const item of slip.items || []) {
      if (item.isEmpty || !item.baseNumber) continue;
      const dCount = item.baseNumber.length;

      if (dCount === 3) {
        if (item.permMult && item.permTotalAmt > 0) {
          if (permutationMode === 'expand') {
            const perms =
              item.permutations && item.permutations.length > 0
                ? item.permutations
                : getUniquePermutations3(item.baseNumber);
            const eachAmt = +(item.permTotalAmt / perms.length).toFixed(2);

            for (const pNum of perms) {
              const entry = getOrCreate(pNum, 3);
              entry.threeStraightAmt += eachAmt;
              entry.threeStraightFromPermAmt += eachAmt;
              entry.totalAmt += eachAmt;
              addContribution(
                entry,
                slip,
                item,
                eachAmt,
                `แตกจาก ${item.numText} (${eachAmt}฿)`,
                '3 ตัวบน (แตกประตู)'
              );
            }
          } else {
            const entry = getOrCreate(item.baseNumber, 3);
            entry.threePermRawAmt += item.permTotalAmt;
            entry.totalAmt += item.permTotalAmt;
            addContribution(
              entry,
              slip,
              item,
              item.permTotalAmt,
              `ชุดกลับ ×${item.permMult}`,
              `3 ตัวชุดกลับ ×${item.permMult}`
            );
          }
        } else {
          const entry = getOrCreate(item.baseNumber, 3);
          if (item.straightAmt > 0) {
            entry.threeStraightAmt += item.straightAmt;
            entry.threeStraightDirectAmt += item.straightAmt;
            entry.totalAmt += item.straightAmt;
            addContribution(entry, slip, item, item.straightAmt, '3 ตัวบน (ตรง)', '3 ตัวบน (ตรง)');
          }
          if (item.toadAmt > 0) {
            entry.threeToadAmt += item.toadAmt;
            entry.totalAmt += item.toadAmt;
            addContribution(entry, slip, item, item.toadAmt, '3 ตัวโต๊ด', '3 ตัวโต๊ด');
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
              addContribution(
                entry,
                slip,
                item,
                eachAmt,
                `แตกจาก ${item.numText} (${eachAmt}฿)`,
                '2 ตัวบน (กลับ)'
              );
            }
          } else {
            const entry = getOrCreate(item.baseNumber, 2);
            entry.twoTopAmt += item.permTotalAmt;
            entry.totalAmt += item.permTotalAmt;
            addContribution(entry, slip, item, item.permTotalAmt, '2 ตัวชุดกลับ (×2)', '2 ตัวชุดกลับ');
          }
        } else {
          const entry = getOrCreate(item.baseNumber, 2);
          if (item.straightAmt > 0) {
            entry.twoTopAmt += item.straightAmt;
            entry.totalAmt += item.straightAmt;
            addContribution(entry, slip, item, item.straightAmt, '2 ตัวบน', '2 ตัวบน');
          }
          if (item.bottomAmt > 0) {
            entry.twoBottomAmt += item.bottomAmt;
            entry.totalAmt += item.bottomAmt;
            addContribution(entry, slip, item, item.bottomAmt, '2 ตัวล่าง', '2 ตัวล่าง');
          }
        }
      }
    }
  }

  const results = Array.from(map.values()).map(r => {
    const excessThreeStraight = Math.max(0, r.threeStraightAmt - (limits.threeStraight || 100));
    const excessThreeToad = Math.max(0, r.threeToadAmt - (limits.threeToad || 100));
    const excessThreePerm = Math.max(0, r.threePermRawAmt - (limits.threePerm || 132));
    const excessTwoTop = Math.max(0, r.twoTopAmt - (limits.twoTop || 30));
    const excessTwoBottom = Math.max(0, r.twoBottomAmt - (limits.twoBottom || 100));

    const totalExcess =
      excessThreeStraight + excessThreeToad + excessThreePerm + excessTwoTop + excessTwoBottom;

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
  evaluateNumberRestriction,
  aggregateSlips
};
