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
 * vs AFTER the dealer's half-payout cutoff (50% payout),
 * AND calculates Incremental Layoff Ledger (ส่งเจ้ามือไปแล้ว / เก็บไว้ที่เราแล้ว / ยอดเข้ามาใหม่รอดำเนินการ).
 */
function aggregateSlips(slips, settings = {}, restrictedList = [], layoffs = []) {
  const permutationMode = settings.permutationMode || 'expand';
  const limits = settings.riskLimits || {
    threeStraight: 100,
    threeToad: 100,
    threePerm: 132,
    twoTop: 30,
    twoBottom: 100
  };

  // Build cumulative allocated map from previous dealer layoff rounds in this draw
  // Each layoff round records: { number, sendTotal, keepTotal }
  const allocatedMap = new Map();
  for (const lf of layoffs || []) {
    for (const it of lf.items || []) {
      const num = String(it.number || '').trim();
      if (!num) continue;
      if (!allocatedMap.has(num)) {
        allocatedMap.set(num, { sentToDealerAmt: 0, keptByUsAmt: 0, roundsSent: [] });
      }
      const acc = allocatedMap.get(num);
      const sAmt = Number(it.sendTotal) || 0;
      const kAmt = Number(it.keepTotal) || 0;
      acc.sentToDealerAmt += sAmt;
      acc.keptByUsAmt += kAmt;
      if (sAmt > 0 || kAmt > 0) {
        acc.roundsSent.push({
          roundNumber: lf.roundNumber || 1,
          dealerName: lf.dealerName,
          sentAmt: sAmt,
          keptAmt: kAmt,
          createdAt: lf.createdAt
        });
      }
    }
  }

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

  function addContribution(entry, slip, item, amount, typeLabel, category, fieldKey) {
    const evalRes = evaluateNumberRestriction(entry.number, slip.createdAt, restrictedList);
    if (evalRes.payoutPercentForThisSlip === 100) {
      entry.fullPayout100Amt += amount;
    } else {
      entry.halfPayout50Amt += amount;
    }

    entry.contributors.push({
      slipId: slip.id,
      roundNumber: slip.roundNumber || 1,
      slipTitle: slip.title,
      customerName: slip.customerName,
      customerLineId: slip.customerLineId,
      source: slip.source,
      col: item.col,
      row: item.row,
      rowKey: `${slip.id}_${item.col}_${item.row}`,
      originalWrite: `${item.numText} = ${item.amtText}`,
      typeLabel,
      category,
      fieldKey, // 'threeStraightAmt', 'threeToadAmt', 'threePermRawAmt', 'twoTopAmt', 'twoBottomAmt'
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
                '3 ตัวบน (แตกประตู)',
                'threeStraightAmt'
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
              `3 ตัวชุดกลับ ×${item.permMult}`,
              'threePermRawAmt'
            );
          }
        } else {
          const entry = getOrCreate(item.baseNumber, 3);
          if (item.straightAmt > 0) {
            entry.threeStraightAmt += item.straightAmt;
            entry.threeStraightDirectAmt += item.straightAmt;
            entry.totalAmt += item.straightAmt;
            addContribution(entry, slip, item, item.straightAmt, '3 ตัวบน (ตรง)', '3 ตัวบน (ตรง)', 'threeStraightAmt');
          }
          if (item.toadAmt > 0) {
            entry.threeToadAmt += item.toadAmt;
            entry.totalAmt += item.toadAmt;
            addContribution(entry, slip, item, item.toadAmt, '3 ตัวโต๊ด', '3 ตัวโต๊ด', 'threeToadAmt');
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
                '2 ตัวบน (กลับ)',
                'twoTopAmt'
              );
            }
          } else {
            const entry = getOrCreate(item.baseNumber, 2);
            entry.twoTopAmt += item.permTotalAmt;
            entry.totalAmt += item.permTotalAmt;
            addContribution(entry, slip, item, item.permTotalAmt, '2 ตัวชุดกลับ (×2)', '2 ตัวชุดกลับ', 'twoTopAmt');
          }
        } else {
          const entry = getOrCreate(item.baseNumber, 2);
          if (item.straightAmt > 0) {
            entry.twoTopAmt += item.straightAmt;
            entry.totalAmt += item.straightAmt;
            addContribution(entry, slip, item, item.straightAmt, '2 ตัวบน', '2 ตัวบน', 'twoTopAmt');
          }
          if (item.bottomAmt > 0) {
            entry.twoBottomAmt += item.bottomAmt;
            entry.totalAmt += item.bottomAmt;
            addContribution(entry, slip, item, item.bottomAmt, '2 ตัวล่าง', '2 ตัวล่าง', 'twoBottomAmt');
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
    // Count distinct slip rows (so "287 = 110×110" written on 1 line is counted as 1 entry, not 2!)
    const distinctRowEntries = new Set(r.contributors.map(c => c.rowKey)).size;

    const alloc = allocatedMap.get(r.number) || { sentToDealerAmt: 0, keptByUsAmt: 0, roundsSent: [] };
    const alreadySentAmt = alloc.sentToDealerAmt;
    const alreadyKeptAmt = alloc.keptByUsAmt;
    const alreadyHandledAmt = alreadySentAmt + alreadyKeptAmt;
    const newPendingAmt = Math.max(0, r.totalAmt - alreadyHandledAmt);

    return {
      ...r,
      uniqueCustomers,
      hitCount: distinctRowEntries,
      alreadySentAmt,
      alreadyKeptAmt,
      alreadyHandledAmt,
      newPendingAmt,
      hasNewPending: newPendingAmt > 0,
      roundsSent: alloc.roundsSent,
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

/**
 * Checks all slips and dealer layoffs in a draw against the winning lottery numbers.
 * Calculates exact payouts per runner/slip/row (respecting 100% before-cutoff vs 50% after-cutoff)
 * and calculates dealer claim recovery + net profit/loss for the draw.
 */
function checkDrawWinners(slips = [], currentDraw = {}, settings = {}, layoffs = []) {
  const win = currentDraw.winningResult || {
    firstPrize: '945583',
    threeTop: '583',
    twoTop: '83',
    twoBottom: '21',
    drawDateText: 'งวดวันที่ 16 พ.ย. 2569'
  };

  const threeTop = String(win.threeTop || (win.firstPrize ? win.firstPrize.slice(-3) : '')).trim();
  const twoTop = String(win.twoTop || (threeTop ? threeTop.slice(-2) : '')).trim();
  const twoBottom = String(win.twoBottom || '').trim();

  const rates = settings.payoutRates || {
    threeStraight: 500, // 3 ตัวตรง บาทละ 500
    threeToad: 100,     // 3 ตัวโต๊ด บาทละ 100
    twoTop: 70,         // 2 ตัวบน บาทละ 70
    twoBottom: 70       // 2 ตัวล่าง บาทละ 70
  };

  const threeTopPerms = threeTop.length === 3 ? getUniquePermutations3(threeTop) : [];
  const restrictedList = currentDraw.restrictedNumbers || [];

  const winningTickets = [];
  const runnerWinMap = new Map();

  let totalSalesInDraw = 0;
  let totalCustomerPayout = 0;
  let totalSavedBy50Cutoff = 0; // เงินที่ประหยัดได้จากกติกาเลขอั้น 50%

  for (const slip of slips) {
    if (slip.status === 'cancelled' || slip.isTrainingOnly) continue;
    totalSalesInDraw += slip.totalMoney || 0;

    for (const item of slip.items || []) {
      if (item.isEmpty || !item.baseNumber) continue;

      const dCount = item.baseNumber.length;
      const hitsInRow = [];

      if (dCount === 3 && threeTop.length === 3) {
        const isExactThreeTop = item.baseNumber === threeTop;
        const isPermOfThreeTop = threeTopPerms.includes(item.baseNumber);

        if (item.permMult && item.permTotalAmt > 0) {
          // เลขชุดกลับ ×6 หรือ ×3: ถ้าหนึ่งในประตูตรงกับ threeTop จะถูกรางวัล 3 ตัวตรงในยอดต่อประตู
          if (isPermOfThreeTop) {
            const perms = item.permutations?.length ? item.permutations : getUniquePermutations3(item.baseNumber);
            const perDoor = +(item.permTotalAmt / perms.length).toFixed(2);
            hitsInRow.push({
              winType: `3 ตัวบน (แตกจากชุดกลับ ×${item.permMult})`,
              winNumber: threeTop,
              betAmount: perDoor,
              baseRate: rates.threeStraight
            });
          }
        } else {
          if (item.straightAmt > 0 && isExactThreeTop) {
            hitsInRow.push({
              winType: '3 ตัวบน (ตรง)',
              winNumber: threeTop,
              betAmount: item.straightAmt,
              baseRate: rates.threeStraight
            });
          }
          if (item.toadAmt > 0 && isPermOfThreeTop) {
            hitsInRow.push({
              winType: '3 ตัวโต๊ด',
              winNumber: item.baseNumber,
              betAmount: item.toadAmt,
              baseRate: rates.threeToad
            });
          }
        }
      } else if (dCount === 2) {
        if (item.permMult === 2 && item.permTotalAmt > 0) {
          const perms2 = getUniquePermutations2(item.baseNumber);
          const perDoor2 = +(item.permTotalAmt / perms2.length).toFixed(2);
          if (twoTop && perms2.includes(twoTop)) {
            hitsInRow.push({
              winType: '2 ตัวบน (จากชุดกลับ ×2)',
              winNumber: twoTop,
              betAmount: perDoor2,
              baseRate: rates.twoTop
            });
          }
        } else {
          if (item.straightAmt > 0 && twoTop && item.baseNumber === twoTop) {
            hitsInRow.push({
              winType: '2 ตัวบน',
              winNumber: twoTop,
              betAmount: item.straightAmt,
              baseRate: rates.twoTop
            });
          }
          // สำหรับโพยที่เขียนเลข 2 ตัวเดี่ยวๆ เช่น "21 = 22" ให้ตรวจทั้งกรณีตรงกับ 2 ตัวบน หรือ 2 ตัวล่าง
          if (item.bottomAmt > 0 && twoBottom && item.baseNumber === twoBottom) {
            hitsInRow.push({
              winType: '2 ตัวล่าง',
              winNumber: twoBottom,
              betAmount: item.bottomAmt,
              baseRate: rates.twoBottom
            });
          } else if (item.straightAmt > 0 && item.bottomAmt === 0 && twoBottom && item.baseNumber === twoBottom && item.baseNumber !== twoTop) {
            hitsInRow.push({
              winType: '2 ตัว (ตรงเลขท้าย 2 ตัว)',
              winNumber: twoBottom,
              betAmount: item.straightAmt,
              baseRate: rates.twoBottom
            });
          }
        }
      }

      for (const h of hitsInRow) {
        const evalRes = evaluateNumberRestriction(h.winNumber, slip.createdAt, restrictedList);
        const payoutPercent = evalRes.payoutPercentForThisSlip;
        const effectiveRate = +(h.baseRate * (payoutPercent / 100)).toFixed(2);
        const fullPrizeIf100 = Math.round(h.betAmount * h.baseRate);
        const actualPrize = Math.round(h.betAmount * effectiveRate);
        const savedAmt = Math.max(0, fullPrizeIf100 - actualPrize);

        totalCustomerPayout += actualPrize;
        totalSavedBy50Cutoff += savedAmt;

        const ticket = {
          slipId: slip.id,
          roundNumber: slip.roundNumber || 1,
          slipTitle: slip.title,
          customerName: slip.customerName,
          createdAt: slip.createdAt,
          col: item.col,
          row: item.row,
          originalWrite: `${item.numText} = ${item.amtText}`,
          winType: h.winType,
          winNumber: h.winNumber,
          betAmount: h.betAmount,
          baseRate: h.baseRate,
          payoutPercent,
          effectiveRate,
          fullPrizeIf100,
          actualPrize,
          savedAmt
        };

        winningTickets.push(ticket);

        if (!runnerWinMap.has(slip.customerName)) {
          runnerWinMap.set(slip.customerName, {
            customerName: slip.customerName,
            winCount: 0,
            totalPrize: 0,
            tickets: []
          });
        }
        const rw = runnerWinMap.get(slip.customerName);
        rw.winCount += 1;
        rw.totalPrize += actualPrize;
        rw.tickets.push(ticket);
      }
    }
  }

  // Check how much prize money we recover from the main dealer (from numbers we laid off!)
  let totalDealerRecovery = 0;
  const dealerClaims = [];

  for (const lf of layoffs || []) {
    for (const it of lf.items || []) {
      const num = String(it.number || '').trim();
      const sendAmt = Number(it.sendTotal) || 0;
      if (!num || sendAmt <= 0) continue;

      let claimRate = 0;
      let matchType = '';

      if (num.length === 3 && threeTop.length === 3) {
        if (num === threeTop) {
          // If it was sent as straight+toad (e.g. 583), estimate half straight + half toad or straight rate
          if (String(it.typeDesc).includes('โต๊ด')) {
            claimRate = (rates.threeStraight + rates.threeToad) / 2;
            matchType = '3 ตัวบน+โต๊ด';
          } else {
            claimRate = rates.threeStraight;
            matchType = '3 ตัวบน';
          }
        } else if (threeTopPerms.includes(num) && String(it.typeDesc).includes('โต๊ด')) {
          claimRate = rates.threeToad;
          matchType = '3 ตัวโต๊ด';
        }
      } else if (num.length === 2) {
        if (num === twoTop || num === twoBottom) {
          claimRate = rates.twoTop;
          matchType = '2 ตัว';
        }
      }

      if (claimRate > 0) {
        const claimPrize = Math.round(sendAmt * claimRate);
        totalDealerRecovery += claimPrize;
        dealerClaims.push({
          layoffId: lf.id,
          roundNumber: lf.roundNumber || 1,
          dealerName: lf.dealerName,
          number: num,
          matchType,
          sentAmount: sendAmt,
          claimRate,
          claimPrize
        });
      }
    }
  }

  const totalSentToDealerCost = (layoffs || []).reduce((sum, l) => sum + (Number(l.totalLayoffMoney) || 0), 0);
  const netSalesRetained = totalSalesInDraw - totalSentToDealerCost;
  const netOutOfPocketPayout = Math.max(0, totalCustomerPayout - totalDealerRecovery);
  const netProfitOrLoss = netSalesRetained - (totalCustomerPayout - totalDealerRecovery);

  return {
    winningResult: {
      firstPrize: win.firstPrize || '',
      threeTop,
      twoTop,
      twoBottom,
      threeTopPerms,
      source: win.source || 'ตั้งค่าในระบบ',
      updatedAt: win.updatedAt || null
    },
    payoutRates: rates,
    winningTickets,
    winnersByRunner: Array.from(runnerWinMap.values()),
    dealerClaims,
    financialSummary: {
      totalSalesInDraw,
      totalSentToDealerCost,
      netSalesRetained,
      totalCustomerPayout,
      totalSavedBy50Cutoff,
      totalDealerRecovery,
      netOutOfPocketPayout,
      netProfitOrLoss
    }
  };
}

module.exports = {
  normalizeHandwritingAmount,
  normalizeHandwritingNumber,
  getUniquePermutations3,
  getUniquePermutations2,
  parseAndValidateRow,
  parseFreeTextMessage,
  evaluateNumberRestriction,
  aggregateSlips,
  checkDrawWinners
};
