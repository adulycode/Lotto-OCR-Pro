// LottoOCR Pro Frontend Controller

let appState = {
  settings: {},
  slips: [],
  aggregated: [],
  layoffs: [],
  lineChats: [],
  summary: {}
};

let currentAggFilter = 'all';
let selectedAggNumberKey = null;
let selectedLayoffKeys = new Set();
let customLayoffAmounts = {}; // key -> custom send amount
let currentInspectedSlipId = null;
let showWarningsOnlyInInspector = false;
let currentZoom = 1.0;
let uploadedBase64Image = '';
let uploadedColumnSlices = null;

document.addEventListener('DOMContentLoaded', async () => {
  buildPrintable4x30Template();
  await fetchAppState();
  document.getElementById('webhookUrlDisplay').value = `${window.location.origin}/api/line/webhook`;
});

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 3800);
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));

  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');

  const btn = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');
}

async function fetchAppState() {
  const res = await fetch('/api/state');
  appState = await res.json();

  // Default select over-limit items on first load if set is empty
  if (selectedLayoffKeys.size === 0 && appState.aggregated) {
    appState.aggregated.forEach(item => {
      if (item.isOverLimit) selectedLayoffKeys.add(item.key);
    });
  }

  renderHeaderStats();
  renderAggregatedTable();
  renderLayoffBuilder();
  renderInspectorSelector();
  renderLineSimulator();
  renderCustomerBillsAndLayoffs();
  populateSettingsForm();
}

function renderHeaderStats() {
  const s = appState.summary || {};
  const settings = appState.settings || {};

  document.getElementById('headerModelBadge').textContent = settings.geminiModel || 'gemini-2.5-pro';
  document.getElementById('statTotalSlips').textContent = `${s.totalSlips || 0} ใบ`;
  document.getElementById('statTotalMoney').textContent = `${(s.totalGrandMoney || 0).toLocaleString()} ฿`;

  const totalWarnRows = (appState.slips || []).reduce((acc, sl) => acc + (sl.reviewCount || 0), 0);
  document.getElementById('statPendingReview').textContent = `${totalWarnRows} จุด`;
  document.getElementById('badgeReviewCount').textContent = totalWarnRows;
  document.getElementById('badgeReviewCount').style.display = totalWarnRows > 0 ? 'inline-block' : 'none';

  // Permutation mode buttons
  const isExpand = settings.permutationMode !== 'keep_raw';
  document.getElementById('btnModeExpand').classList.toggle('active', isExpand);
  document.getElementById('btnModeRaw').classList.toggle('active', !isExpand);

  const subtitle = document.getElementById('aggModeSubtitle');
  if (isExpand) {
    subtitle.innerHTML =
      'โหมดปัจจุบัน: <strong>🔀 แยกเลขทุกประตูอัตโนมัติ</strong> (เช่น <code>072×6 = 66฿</code> แตกเป็น <code>072, 027, 207, 270, 702, 720</code> ตัวละ 11฿ แล้วนำไปบวกรวมกับยอด 3 ตัวบนของทุกคนทันที)';
  } else {
    subtitle.innerHTML =
      'โหมดปัจจุบัน: <strong>📋 คงตามหน้าโพย (ไม่แยกหาง)</strong> (เช่น <code>072×6 = 66฿</code> จะแสดงในคอลัมน์ "ชุดกลับ ×6/×3" แยกจาก 3 ตัวเต็ง)';
  }
}

async function setPermutationMode(mode) {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permutationMode: mode })
  });
  await fetchAppState();
  showToast(
    mode === 'expand'
      ? 'สลับเป็นโหมด: แยกเลขกระจายทุกประตู (×6 แตก 6 หาง / ×3 แตก 3 หาง)'
      : 'สลับเป็นโหมด: คงตามหน้าโพย (ไม่แยกหาง)'
  );
}

function setAggFilter(filter, btnEl) {
  currentAggFilter = filter;
  document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  renderAggregatedTable();
}

function renderAggregatedTable() {
  const tbody = document.getElementById('aggTableBody');
  const search = (document.getElementById('searchNumberInput')?.value || '').trim();
  const isExpand = appState.settings?.permutationMode !== 'keep_raw';

  // Highlight bar showing notable multi-customer merged numbers (including 21 = 42 Baht!)
  const highlightBar = document.getElementById('exampleHighlightBar');
  const num21 = appState.aggregated.find(a => a.number === '21');
  const num583 = appState.aggregated.find(a => a.number === '583');
  const num154 = appState.aggregated.find(a => a.number === '154');
  const num072 = appState.aggregated.find(a => a.number === '072');

  let hlHtml = `<span>💡 <strong>ตัวอย่างเลขที่มีคนส่งซ้ำและระบบรวมเป็นยอดเงินเดียวอัตโนมัติ (คลิกเพื่อดูรายคน):</strong></span>`;
  if (num21) {
    hlHtml += `<span class="hl-badge" onclick="inspectAggNumber('${num21.key}')">เลข <strong>21</strong> = ${num21.totalAmt}฿ (22+20)</span>`;
  }
  if (num583) {
    hlHtml += `<span class="hl-badge" onclick="inspectAggNumber('${num583.key}')">เลข <strong>583</strong> = ${num583.totalAmt}฿ (${num583.hitCount} รายการ)</span>`;
  }
  if (num154) {
    hlHtml += `<span class="hl-badge" onclick="inspectAggNumber('${num154.key}')">เลข <strong>154</strong> = ${num154.totalAmt}฿ (${num154.hitCount} รายการ)</span>`;
  }
  if (num072) {
    hlHtml += `<span class="hl-badge" onclick="inspectAggNumber('${num072.key}')">เลข <strong>072</strong> = ${num072.totalAmt}฿ (${num072.hitCount} รายการ)</span>`;
  }
  highlightBar.innerHTML = hlHtml;

  let list = appState.aggregated || [];

  if (search) {
    list = list.filter(item => item.number.includes(search));
  }
  if (currentAggFilter === 'multi_hit') {
    list = list.filter(item => item.hitCount > 1);
  } else if (currentAggFilter === 'over_limit') {
    list = list.filter(item => item.isOverLimit);
  } else if (currentAggFilter === 'digit_2') {
    list = list.filter(item => item.digitCount === 2);
  } else if (currentAggFilter === 'digit_3') {
    list = list.filter(item => item.digitCount === 3);
  }

  if (!selectedAggNumberKey && list.length > 0) {
    selectedAggNumberKey = num21 ? num21.key : list[0].key;
  }

  tbody.innerHTML = list
    .map(item => {
      const isSelected = item.key === selectedAggNumberKey;
      const isChecked = selectedLayoffKeys.has(item.key);
      const rowClasses = [
        isSelected ? 'selected-row' : '',
        item.isOverLimit ? 'over-limit-row' : ''
      ]
        .filter(Boolean)
        .join(' ');

      const straightBreakdown =
        isExpand && item.threeStraightFromPermAmt > 0 && item.threeStraightDirectAmt > 0
          ? `<div style="font-size:10px;color:#94a3b8;">(เต็ง ${item.threeStraightDirectAmt}+แตก ${item.threeStraightFromPermAmt})</div>`
          : isExpand && item.threeStraightFromPermAmt > 0
            ? `<div style="font-size:10px;color:#60a5fa;">(จากชุดกลับ)</div>`
            : '';

      const customerNames = Array.from(new Set(item.contributors.map(c => c.customerName))).join(', ');

      return `
        <tr class="${rowClasses}" onclick="inspectAggNumber('${item.key}')">
          <td style="text-align:center;" onclick="event.stopPropagation()">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleLayoffItem('${item.key}', this.checked)" />
          </td>
          <td>
            <span class="number-pill">${item.number}</span>
            ${item.hitCount > 1 ? `<span class="multi-hit-tag">รวม ${item.hitCount} รายการ</span>` : ''}
          </td>
          <td>${item.digitCount} ตัว</td>
          <td class="num-col">
            ${item.threeStraightAmt > 0 ? `<strong>${item.threeStraightAmt.toLocaleString()}</strong>` : '-'}
            ${straightBreakdown}
          </td>
          <td class="num-col">${item.threeToadAmt > 0 ? item.threeToadAmt.toLocaleString() : '-'}</td>
          <td class="num-col">${item.threePermRawAmt > 0 ? item.threePermRawAmt.toLocaleString() : '-'}</td>
          <td class="num-col">${item.twoTopAmt > 0 ? `<strong>${item.twoTopAmt.toLocaleString()}</strong>` : '-'}</td>
          <td class="num-col">${item.twoBottomAmt > 0 ? item.twoBottomAmt.toLocaleString() : '-'}</td>
          <td class="num-col" style="color:var(--gold);font-weight:700;font-size:14px;">
            ${item.totalAmt.toLocaleString()} ฿
          </td>
          <td class="num-col">
            ${
              item.isOverLimit
                ? `<span style="color:#f87171;font-weight:700;">+${item.totalExcess.toLocaleString()} ฿</span>`
                : `<span style="color:#10b981;font-size:11px;">อยู่ในเพดาน</span>`
            }
          </td>
          <td style="font-size:12px;">
            <strong>${item.uniqueCustomers} คน</strong>
            <span class="text-muted">(${customerNames})</span>
          </td>
        </tr>
      `;
    })
    .join('');

  renderSelectedNumberDetail();
}

function inspectAggNumber(key) {
  selectedAggNumberKey = key;
  renderAggregatedTable();
}

function renderSelectedNumberDetail() {
  const container = document.getElementById('numberDetailBody');
  const item = (appState.aggregated || []).find(a => a.key === selectedAggNumberKey);
  if (!item) {
    container.innerHTML = `<div class="empty-hint">คลิกเลือกตัวเลขในตารางเพื่อดูรายละเอียดผู้ส่ง</div>`;
    return;
  }

  const contribHtml = item.contributors
    .map(
      c => `
      <div class="contributor-item">
        <div>
          <div style="font-weight:700;color:#60a5fa;">👤 ${c.customerName}</div>
          <div class="text-muted">
            บิล: <strong>${c.slipTitle}</strong>
            ${c.col ? `• คอลัมน์ ${c.col} แถว ${c.row}` : ''}
          </div>
          <div style="font-size:12px;margin-top:2px;">
            ต้นฉบับที่เขียน: <code style="color:var(--gold);">${c.originalWrite}</code> → <span>${c.typeLabel}</span>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:var(--success);">
            +${c.amount.toLocaleString()} ฿
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-top:4px;" onclick="jumpToSlipInspector('${c.slipId}', ${c.col || 1}, ${c.row || 1})">
            🔍 ดูในโพย
          </button>
        </div>
      </div>
    `
    )
    .join('');

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;background:var(--bg-input);padding:10px 14px;border-radius:8px;border:1px solid var(--border);">
      <div>
        <span style="font-size:12px;color:var(--text-muted);">เลขที่เลือกดู:</span>
        <span class="number-pill" style="font-size:18px;margin-left:8px;">${item.number}</span>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:var(--text-muted);">ผลรวมยอดเงินเดียว (${item.contributors.length} รายการ)</div>
        <div style="font-family:var(--font-mono);font-size:18px;font-weight:700;color:var(--gold);">
          ${item.totalAmt.toLocaleString()} บาท
        </div>
      </div>
    </div>
    ${contribHtml}
  `;
}

function jumpToSlipInspector(slipId, col, row) {
  currentInspectedSlipId = slipId;
  switchTab('tab-inspector');
  renderInspectorSelector();
  selectSlipForInspection(slipId, col, row);
}

// ============================================================================
// DEALER LAYOFF (ระบบเลือกเลขตัดยอดส่งเจ้ามือเพื่อกระจายความเสี่ยง)
// ============================================================================
function toggleLayoffItem(key, checked) {
  if (checked) selectedLayoffKeys.add(key);
  else selectedLayoffKeys.delete(key);
  renderLayoffBuilder();
}

function toggleSelectAllAgg(checked) {
  if (checked) {
    (appState.aggregated || []).forEach(a => selectedLayoffKeys.add(a.key));
  } else {
    selectedLayoffKeys.clear();
  }
  renderAggregatedTable();
  renderLayoffBuilder();
}

function selectOverLimitForLayoff() {
  selectedLayoffKeys.clear();
  (appState.aggregated || []).forEach(a => {
    if (a.isOverLimit) selectedLayoffKeys.add(a.key);
  });
  renderAggregatedTable();
  renderLayoffBuilder();
  showToast(`เลือกเลขที่เกินเพดานความเสี่ยงทั้งหมด ${selectedLayoffKeys.size} เลขแล้ว`);
}

function clearLayoffSelection() {
  selectedLayoffKeys.clear();
  customLayoffAmounts = {};
  renderAggregatedTable();
  renderLayoffBuilder();
}

function onCustomLayoffAmountChange(key, val) {
  customLayoffAmounts[key] = Math.max(0, Number(val) || 0);
  renderLayoffBuilder(true);
}

function renderLayoffBuilder(skipInputRebuild = false) {
  const mode = document.getElementById('layoffModeSelect')?.value || 'excess';
  const dealerName = document.getElementById('dealerNameInput')?.value || 'เจ้ามือสายใหญ่ #1';
  const listContainer = document.getElementById('layoffItemsList');

  const selectedItems = (appState.aggregated || []).filter(a => selectedLayoffKeys.has(a.key));
  let totalAllMoney = (appState.summary?.totalGrandMoney || 0);
  let totalSendMoney = 0;

  const layoffRows = selectedItems.map(item => {
    let defaultSend = item.totalAmt;
    if (mode === 'excess') {
      defaultSend = item.totalExcess > 0 ? item.totalExcess : item.totalAmt;
    } else if (mode === 'half') {
      defaultSend = Math.round(item.totalAmt / 2);
    }

    const sendAmt =
      customLayoffAmounts[item.key] !== undefined ? customLayoffAmounts[item.key] : defaultSend;
    const keepAmt = Math.max(0, item.totalAmt - sendAmt);
    totalSendMoney += sendAmt;

    // Describe type for dealer slip
    let typeDesc = '';
    if (item.digitCount === 2) {
      if (item.twoTopAmt > 0 && item.twoBottomAmt > 0) typeDesc = `บน×ล่าง`;
      else if (item.twoBottomAmt > 0) typeDesc = `2 ตัวล่าง`;
      else typeDesc = `2 ตัวบน`;
    } else {
      if (item.threeStraightAmt > 0 && item.threeToadAmt > 0) {
        if (mode === 'excess') {
          const sEx = item.excessThreeStraight > 0 ? item.excessThreeStraight : item.threeStraightAmt;
          const tEx = item.excessThreeToad > 0 ? item.excessThreeToad : item.threeToadAmt;
          typeDesc = `${sEx}×${tEx}`;
        } else {
          typeDesc = `${item.threeStraightAmt}×${item.threeToadAmt}`;
        }
      } else if (item.threePermRawAmt > 0) {
        typeDesc = `ชุดกลับ`;
      } else if (item.threeToadAmt > 0) {
        typeDesc = `โต๊ด`;
      } else {
        typeDesc = `3 ตัวบน`;
      }
    }

    return {
      key: item.key,
      number: item.number,
      typeDesc,
      totalReceived: item.totalAmt,
      keepAmt,
      sendTotal: sendAmt
    };
  });

  if (!skipInputRebuild) {
    if (layoffRows.length === 0) {
      listContainer.innerHTML = `<div class="text-muted" style="text-align:center;padding:18px;">ยังไม่ได้ติ๊กเลือกเลขที่จะตัดส่งเจ้ามือ (ติ๊กช่องหน้าตัวเลขในตารางด้านซ้าย หรือกดปุ่ม "⚡ ติ๊กเลือกเลขเกินเพดานทั้งหมด")</div>`;
    } else {
      listContainer.innerHTML = layoffRows
        .map(
          r => `
        <div class="layoff-row-item">
          <div>
            <strong style="font-family:var(--font-mono);color:var(--gold);font-size:15px;">${r.number}</strong>
            <span class="text-muted" style="margin-left:6px;">(รับมา ${r.totalReceived}฿ | เก็บเอง ${r.keepAmt}฿)</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="text-muted">ส่งออก:</span>
            <input type="number" class="cell-input" style="width:78px;" value="${r.sendTotal}"
              oninput="onCustomLayoffAmountChange('${r.key}', this.value)" />
            <span>฿</span>
          </div>
        </div>
      `
        )
        .join('');
    }
  }

  document.getElementById('layoffSelectedCount').textContent = `${layoffRows.length} เลข`;
  document.getElementById('layoffKeepTotal').textContent = `${Math.max(0, totalAllMoney - totalSendMoney).toLocaleString()} บาท`;
  document.getElementById('layoffSendTotal').textContent = `${totalSendMoney.toLocaleString()} บาท`;

  // Build formatted text for dealer LINE message
  const lines = [
    `📋 ใบตัดยอดส่ง: ${dealerName}`,
    `📅 งวดวันที่: 16/11`,
    `-------------------------`,
    ...layoffRows.map(r => `${r.number} = ${r.sendTotal} บ. (${r.typeDesc})`),
    `-------------------------`,
    `รวม ${layoffRows.length} รายการ | ยอดรวม ${totalSendMoney.toLocaleString()} บาท`
  ];
  document.getElementById('layoffFormattedText').value = lines.join('\n');
}

async function copyAndSaveLayoff() {
  const text = document.getElementById('layoffFormattedText').value;
  const dealerName = document.getElementById('dealerNameInput').value || 'เจ้ามือสายใหญ่ #1';
  const selectedItems = (appState.aggregated || []).filter(a => selectedLayoffKeys.has(a.key));

  if (selectedItems.length === 0) {
    showToast('กรุณาติ๊กเลือกตัวเลขที่ต้องการตัดยอดส่งเจ้ามือก่อนครับ');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {}

  const itemsPayload = selectedItems.map(item => ({
    number: item.number,
    sendTotal: customLayoffAmounts[item.key] ?? (item.totalExcess > 0 ? item.totalExcess : item.totalAmt)
  }));

  await fetch('/api/layoffs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dealerName,
      formattedText: text,
      items: itemsPayload
    })
  });

  await fetchAppState();
  showToast('✅ คัดลอกโพยส่งเจ้ามือลง Clipboard และบันทึกประวัติเรียบร้อยแล้ว!');
}

// ============================================================================
// TAB 2: SIDE-BY-SIDE 4x30 PAPER SLIP INSPECTOR & MATH VALIDATOR
// ============================================================================
function renderInspectorSelector() {
  const select = document.getElementById('inspectorSlipSelect');
  const slips = appState.slips || [];
  if (slips.length === 0) return;

  if (!currentInspectedSlipId || !slips.find(s => s.id === currentInspectedSlipId)) {
    currentInspectedSlipId = slips[0].id;
  }

  select.innerHTML = slips
    .map(
      s =>
        `<option value="${s.id}" ${s.id === currentInspectedSlipId ? 'selected' : ''}>
          ${s.title} — ผู้ส่ง: ${s.customerName} (${s.totalItems} รายการ | ${s.totalMoney.toLocaleString()}฿) ${
          s.reviewCount > 0 ? `[⚠️ รอตรวจ ${s.reviewCount} จุด]` : '[✅ ยืนยันแล้ว]'
        }
        </option>`
    )
    .join('');

  selectSlipForInspection(currentInspectedSlipId);
}

function selectSlipForInspection(slipId, highlightCol = null, highlightRow = null) {
  currentInspectedSlipId = slipId;
  const slip = (appState.slips || []).find(s => s.id === slipId);
  if (!slip) return;

  // Photo & Meta
  const imgEl = document.getElementById('inspectorImage');
  imgEl.src = slip.imageUrl || '/uploads/slip-16-11-page1.jpg';
  document.getElementById('inspectorMetaText').textContent =
    `ผู้ส่ง: ${slip.customerName} | วันที่ในโพย: ${slip.sheetDate || '16/11'} | แผ่นที่: ${slip.sheetPage || '1'} | อ่านด้วย: ${slip.modelUsed || 'gemini-2.5-pro'}`;

  // Validation Banner
  const banner = document.getElementById('validationSummaryBanner');
  const warnItems = (slip.items || []).filter(i => i.needsReview);
  if (warnItems.length > 0) {
    banner.className = 'validation-banner warn';
    const warnDesc = warnItems
      .map(w => `คอลัมน์ ${w.col} แถว ${w.row} (${w.numText}=${w.amtText}): ${w.warnings.join(', ') || 'กรุณาตรวจซ้ำ'}`)
      .join(' | ');
    banner.innerHTML = `
      <div>
        <strong>⚠️ ระบบตรวจสอบความถูกต้อง 4 ชั้น พบจุดที่ควรเช็คเทียบกับรูปกระดาษ ${warnItems.length} จุด:</strong>
        <div style="margin-top:2px;">${warnDesc}</div>
      </div>
      <span style="font-family:var(--font-mono);font-weight:700;">ยอดรวมใบนี้: ${slip.totalMoney.toLocaleString()} ฿</span>
    `;
  } else {
    banner.className = 'validation-banner ok';
    banner.innerHTML = `
      <div>
        <strong>✅ ผ่านการตรวจสอบกฎคณิตศาสตร์ครบทุกแถว (${slip.totalItems} รายการ):</strong>
        กฎ ×6 (เลขไม่ซ้ำ/หาร 6 ลงตัว) • กฎ ×3 (เลขเบิ้ล/หาร 3 ลงตัว) • กฎพหูคูณ 11 บาท ถูกต้อง 100%
      </div>
      <span style="font-family:var(--font-mono);font-weight:700;">ยอดรวมใบนี้: ${slip.totalMoney.toLocaleString()} ฿</span>
    `;
  }

  // Render 4 Columns x 30 Rows Grid
  const container = document.getElementById('paperGridContainer');
  const cols = [1, 2, 3, 4];

  container.innerHTML = cols
    .map(colNum => {
      const colItems = (slip.items || []).filter(i => (i.col || 1) === colNum);
      // Ensure rows 1..30 if it's a 4x30 sheet, or render existing items
      const maxRows = slip.isGrid4x30 ? 30 : Math.max(colItems.length, 1);
      const rowsHtml = [];
      let colTotal = 0;

      for (let rIdx = 1; rIdx <= maxRows; rIdx++) {
        const item = colItems.find(i => i.row === rIdx) || {
          col: colNum,
          row: rIdx,
          numText: '',
          amtText: '',
          rowTotalMoney: 0,
          warnings: [],
          needsReview: false
        };
        colTotal += item.rowTotalMoney || 0;

        if (showWarningsOnlyInInspector && !item.needsReview) continue;

        const isHighlighted = highlightCol === colNum && highlightRow === rIdx;
        const rowClass = item.warnings && item.warnings.length > 0
          ? 'row-warn'
          : isHighlighted
            ? 'row-warn'
            : '';

        rowsHtml.push(`
          <div class="paper-row-item ${rowClass}" id="cell-${colNum}-${rIdx}">
            <span class="row-idx">${rIdx}</span>
            <input type="text" class="cell-input" data-col="${colNum}" data-row="${rIdx}" data-field="numText"
              value="${item.numText || ''}" placeholder="เลข"
              onchange="onCellEdit(${colNum}, ${rIdx})" />
            <input type="text" class="cell-input" data-col="${colNum}" data-row="${rIdx}" data-field="amtText"
              value="${item.amtText || ''}" placeholder="ยอดเงิน"
              onchange="onCellEdit(${colNum}, ${rIdx})" />
            ${
              item.warnings && item.warnings.length > 0
                ? `<div class="row-warn-note">⚠️ ${item.warnings.join(' | ')}</div>`
                : ''
            }
          </div>
        `);
      }

      return `
        <div class="paper-col-box">
          <div class="paper-col-header">
            <span>คอลัมน์ที่ ${colNum} (3 ตัวท้ายที่ 1)</span>
            <span>แถว 1-${maxRows}</span>
          </div>
          <div class="paper-col-body">
            ${rowsHtml.join('') || '<div class="text-muted" style="padding:12px;text-align:center;">ไม่มีรายการในคอลัมน์นี้</div>'}
          </div>
          <div class="paper-col-footer">
            <span>รวมคอลัมน์ ${colNum}:</span>
            <span>${colTotal.toLocaleString()} ฿</span>
          </div>
        </div>
      `;
    })
    .join('');

  if (highlightCol && highlightRow) {
    setTimeout(() => {
      const el = document.getElementById(`cell-${highlightCol}-${highlightRow}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }
}

function filterInspectorWarningsOnly() {
  showWarningsOnlyInInspector = !showWarningsOnlyInInspector;
  const btn = document.getElementById('btnFilterWarnings');
  btn.textContent = showWarningsOnlyInInspector ? '📋 แสดงครบทั้ง 120 แถว' : '⚠️ ดูเฉพาะแถวที่ระบบแจ้งเตือน';
  selectSlipForInspection(currentInspectedSlipId);
}

async function onCellEdit(col, row) {
  // Immediately save and run server-side 4-layer math validation so the user gets instant feedback
  await saveAndVerifyCurrentSlip(false);
}

async function saveAndVerifyCurrentSlip(markVerified = false) {
  const slip = (appState.slips || []).find(s => s.id === currentInspectedSlipId);
  if (!slip) return;

  // Gather all edited inputs from the 4x30 DOM grid
  const numInputs = document.querySelectorAll('.cell-input[data-field="numText"]');
  const updatedMap = new Map();

  // Seed with existing items first (so hidden rows when filtering warnings are preserved)
  for (const it of slip.items || []) {
    updatedMap.set(`${it.col}_${it.row}`, {
      col: it.col,
      row: it.row,
      numText: it.numText,
      amtText: it.amtText,
      note: markVerified ? '' : it.note,
      clearedNote: markVerified
    });
  }

  numInputs.forEach(numEl => {
    const col = parseInt(numEl.getAttribute('data-col'), 10);
    const row = parseInt(numEl.getAttribute('data-row'), 10);
    const amtEl = document.querySelector(`.cell-input[data-col="${col}"][data-row="${row}"][data-field="amtText"]`);
    const numText = numEl.value.trim();
    const amtText = amtEl ? amtEl.value.trim() : '';

    if (numText || amtText) {
      updatedMap.set(`${col}_${row}`, {
        col,
        row,
        numText,
        amtText,
        clearedNote: true
      });
    } else {
      updatedMap.delete(`${col}_${row}`);
    }
  });

  const res = await fetch(`/api/slips/${encodeURIComponent(slip.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: Array.from(updatedMap.values()),
      markVerified
    })
  });

  if (res.ok) {
    await fetchAppState();
    showToast(
      markVerified
        ? '✅ ยืนยันความถูกต้องของโพยนี้ 100% และอัปเดตยอดรวมทั้งหมดแล้ว!'
        : '💾 บันทึกการแก้ไขและคำนวณกฎคณิตศาสตร์ใหม่เรียบร้อย'
    );
  }
}

function toggleGridOverlay() {
  const overlay = document.getElementById('gridOverlay4x30');
  overlay.classList.toggle('hidden');
}

function adjustZoom(delta) {
  currentZoom = Math.min(2.5, Math.max(0.75, currentZoom + delta));
  document.getElementById('photoCanvasWrap').style.transform = `scale(${currentZoom})`;
  document.getElementById('zoomLevelText').textContent = `${Math.round(currentZoom * 100)}%`;
}

function resetZoom() {
  currentZoom = 1.0;
  document.getElementById('photoCanvasWrap').style.transform = `scale(1)`;
  document.getElementById('zoomLevelText').textContent = `100%`;
}

// ============================================================================
// TAB 3: LINE SIMULATOR & 4-COLUMN SLICING OCR UPLOAD
// ============================================================================
function onSimCustomerChange(val) {
  document.getElementById('simCustomCustomerInput').value = '';
}

function getSimCustomerName() {
  const custom = document.getElementById('simCustomCustomerInput').value.trim();
  return custom || document.getElementById('simCustomerSelect').value;
}

function fillLinePreset(text) {
  document.getElementById('lineMessageInput').value = text;
}

function renderLineSimulator() {
  const stream = document.getElementById('lineChatStream');
  const chats = appState.lineChats || [];

  stream.innerHTML = chats
    .map(msg => {
      const isCustomer = msg.sender === 'customer';
      return `
        <div class="chat-bubble-wrap ${isCustomer ? 'customer' : 'bot'}">
          <div class="chat-sender-name">${isCustomer ? `👤 ${msg.customerName}` : '🤖 LottoOCR LINE Bot'}</div>
          <div class="chat-bubble">${escapeHtml(msg.text || '')}${
        msg.imageUrl ? `<br/><img src="${msg.imageUrl}" class="chat-thumb" alt="slip" />` : ''
      }</div>
        </div>
      `;
    })
    .join('');

  stream.scrollTop = stream.scrollHeight;
}

async function sendLineTextMessage() {
  const textEl = document.getElementById('lineMessageInput');
  const text = textEl.value.trim();
  if (!text) {
    showToast('กรุณาพิมพ์ตัวเลขหวยก่อนกดส่งครับ');
    return;
  }

  const customerName = getSimCustomerName();
  textEl.value = '';

  const res = await fetch('/api/line/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerName, text })
  });

  await fetchAppState();
  showToast(`💬 รับบิล LINE จาก "${customerName}" และอัปเดตยอดรวมทันที!`);
}

async function simulateLineSamplePhoto() {
  const customerName = getSimCustomerName();
  showToast(`📸 กำลังส่งรูปโพย 16/11 (120 แถว) เข้า LINE Bot ในนาม "${customerName}"...`);

  await fetch('/api/line/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName,
      useSamplePhoto: true,
      text: 'ส่งรูปโพยกระดาษ 16/11 (120 รายการ)'
    })
  });

  await fetchAppState();
  showToast(`✅ LINE Bot อ่านรูปโพยของ "${customerName}" และรวมยอดเข้าตารางเรียบร้อย!`);
}

async function sendLineCustomPhoto(inputEl) {
  const file = inputEl.files?.[0];
  if (!file) return;
  const customerName = getSimCustomerName();
  const base64Image = await fileToBase64(file);

  showToast(`📸 กำลังอ่านรูปโพยจาก LINE ของ "${customerName}" ด้วย ${appState.settings.geminiModel}...`);
  await fetch('/api/line/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName,
      base64Image,
      text: `ส่งรูปโพย (${file.name})`
    })
  });

  inputEl.value = '';
  await fetchAppState();
  showToast(`✅ อ่านรูปโพยจาก LINE สำเร็จ!`);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Slices a 4-column lottery slip image into 4 vertical column strips using HTML5 Canvas
 * so Gemini 2.5 Pro reads 30 rows per strip without jumping across columns.
 */
async function sliceImageInto4Columns(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const slices = [];
      // Approximate table area: top 12% to 96%, left 6% to 97% divided into 4 columns
      const tableLeft = img.width * 0.05;
      const tableWidth = img.width * 0.92;
      const colWidth = tableWidth / 4;
      const tableTop = img.height * 0.11;
      const tableHeight = img.height * 0.86;

      for (let i = 0; i < 4; i++) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(colWidth);
        canvas.height = Math.round(tableHeight);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(
          img,
          Math.round(tableLeft + i * colWidth),
          Math.round(tableTop),
          Math.round(colWidth),
          Math.round(tableHeight),
          0,
          0,
          canvas.width,
          canvas.height
        );
        slices.push(canvas.toDataURL('image/jpeg', 0.92));
      }
      resolve(slices);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function previewUploadImage(inputEl) {
  const file = inputEl.files?.[0];
  if (!file) return;

  uploadedBase64Image = await fileToBase64(file);
  uploadedColumnSlices = await sliceImageInto4Columns(uploadedBase64Image);

  const grid = document.getElementById('slicePreviewGrid');
  if (uploadedColumnSlices && uploadedColumnSlices.length === 4) {
    grid.innerHTML = uploadedColumnSlices
      .map(
        (src, i) => `
      <div class="slice-item">
        <div style="margin-bottom:4px;font-weight:700;">คอลัมน์ ${i + 1}</div>
        <img src="${src}" style="width:100%;max-height:140px;object-fit:cover;border-radius:4px;" />
      </div>
    `
      )
      .join('');
  }
  showToast('✂️ ตัดแบ่งภาพเป็น 4 คอลัมน์อัตโนมัติพร้อมส่งให้ Gemini 2.5 Pro แล้ว');
}

async function runDirectOcrUpload() {
  const btn = document.getElementById('btnRunOcr');
  const customerName = document.getElementById('uploadCustomerName').value.trim() || 'ลูกค้าทั่วไป';
  const title = document.getElementById('uploadSlipTitle').value.trim() || `โพยกระดาษ - ${customerName}`;

  btn.disabled = true;
  btn.textContent = '⏳ กำลังอ่านลายมือด้วย Gemini 2.5 Pro + ตรวจสอบกฎคณิตศาสตร์ 4 ชั้น...';

  try {
    const res = await fetch('/api/slips/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName,
        title,
        base64Image: uploadedBase64Image,
        columnSlices: uploadedColumnSlices
      })
    });
    const data = await res.json();
    await fetchAppState();

    if (data.slip) {
      currentInspectedSlipId = data.slip.id;
      switchTab('tab-inspector');
      renderInspectorSelector();
      showToast(`✅ อ่านโพยสำเร็จ (${data.slip.totalItems} รายการ รวม ${data.slip.totalMoney.toLocaleString()} บาท)`);
    }
  } catch (err) {
    showToast(`❌ เกิดข้อผิดพลาด: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 เริ่มอ่านลายมือด้วย AI (Gemini 2.5 Pro + เช็คกฎคณิตศาสตร์ 4 ชั้น)';
  }
}

// ============================================================================
// TAB 4: CUSTOMER BILLS & DEALER LAYOFF HISTORY
// ============================================================================
function renderCustomerBillsAndLayoffs() {
  const listEl = document.getElementById('customerSlipsList');
  const slips = appState.slips || [];

  listEl.innerHTML = slips
    .map(
      s => `
      <div class="contributor-item">
        <div>
          <div style="font-weight:700;font-size:15px;color:#93c5fd;">
            📄 ${s.title}
          </div>
          <div class="text-muted">
            👤 ผู้ส่ง: <strong>${s.customerName}</strong> • ช่องทาง: ${s.source} • โมเดล: ${s.modelUsed}
          </div>
          <div style="font-size:12px;margin-top:4px;">
            จำนวน: <strong>${s.totalItems} รายการ</strong> • สถานะ: ${
        s.reviewCount > 0
          ? `<span style="color:var(--gold);">⚠️ รอตรวจทาน ${s.reviewCount} จุด</span>`
          : `<span style="color:var(--success);">✅ ยืนยันแล้ว</span>`
      }
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:var(--gold);">
            ${s.totalMoney.toLocaleString()} ฿
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button class="btn btn-outline btn-sm" onclick="jumpToSlipInspector('${s.id}', 1, 1)">
              🔍 เปิดดู/แก้ไข
            </button>
            <button class="btn btn-ghost btn-sm" onclick="deleteSlip('${s.id}')">
              🗑️ ลบ
            </button>
          </div>
        </div>
      </div>
    `
    )
    .join('');

  const layoffEl = document.getElementById('layoffHistoryList');
  const layoffs = appState.layoffs || [];
  if (layoffs.length === 0) {
    layoffEl.innerHTML = `<div class="text-muted" style="padding:18px;text-align:center;">ยังไม่มีประวัติการตัดยอดส่งเจ้ามือ</div>`;
  } else {
    layoffEl.innerHTML = layoffs
      .map(
        l => `
        <div class="contributor-item" style="flex-direction:column;align-items:stretch;gap:8px;">
          <div style="display:flex;justify-content:space-between;">
            <strong>📤 ${l.dealerName} (${l.itemCount} เลข)</strong>
            <strong style="color:var(--gold);font-family:var(--font-mono);">${l.totalLayoffMoney.toLocaleString()} ฿</strong>
          </div>
          <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-family:var(--font-mono);font-size:11px;overflow-x:auto;">${escapeHtml(
            l.formattedText
          )}</pre>
        </div>
      `
      )
      .join('');
  }
}

async function deleteSlip(slipId) {
  await fetch(`/api/slips/${encodeURIComponent(slipId)}`, { method: 'DELETE' });
  await fetchAppState();
  showToast('🗑️ ลบบิลเรียบร้อยแล้ว');
}

// ============================================================================
// TAB 5: PRINTABLE STANDARD 4x30 PAPER SLIP TEMPLATE
// ============================================================================
function buildPrintable4x30Template() {
  const table = document.getElementById('printTable4x30');
  if (!table) return;

  let html = `
    <thead>
      <tr>
        <th style="width:26px;">#</th>
        <th>3 ตัวท้ายที่ 1 (เลข)</th>
        <th>จำนวนเงิน</th>
        <th style="width:26px;">#</th>
        <th>3 ตัวท้ายที่ 1 (เลข)</th>
        <th>จำนวนเงิน</th>
        <th style="width:26px;">#</th>
        <th>3 ตัวท้ายที่ 1 (เลข)</th>
        <th>จำนวนเงิน</th>
        <th style="width:26px;">#</th>
        <th>3 ตัวท้ายที่ 1 (เลข)</th>
        <th>จำนวนเงิน</th>
      </tr>
    </thead>
    <tbody>
  `;

  for (let r = 1; r <= 30; r++) {
    html += `
      <tr>
        <td style="text-align:center;font-weight:700;">${r}</td><td></td><td></td>
        <td style="text-align:center;font-weight:700;">${r}</td><td></td><td></td>
        <td style="text-align:center;font-weight:700;">${r}</td><td></td><td></td>
        <td style="text-align:center;font-weight:700;">${r}</td><td></td><td></td>
      </tr>
    `;
  }

  html += `
      <tr>
        <td colspan="2" style="font-weight:700;">รวมคอลัมน์ 1</td><td></td>
        <td colspan="2" style="font-weight:700;">รวมคอลัมน์ 2</td><td></td>
        <td colspan="2" style="font-weight:700;">รวมคอลัมน์ 3</td><td></td>
        <td colspan="2" style="font-weight:700;">รวมคอลัมน์ 4</td><td></td>
      </tr>
    </tbody>
  `;
  table.innerHTML = html;
}

// ============================================================================
// TAB 6: SETTINGS
// ============================================================================
function populateSettingsForm() {
  const s = appState.settings || {};
  document.getElementById('settingGeminiModel').value = s.geminiModel || 'gemini-2.5-pro';
  document.getElementById('settingGeminiKey').value = s.geminiApiKey || '';
  document.getElementById('settingPermMode').value = s.permutationMode || 'expand';
  document.getElementById('settingCheck11').checked = s.checkMultiplesOf11 !== false;

  const lim = s.riskLimits || {};
  document.getElementById('limitThreeStraight').value = lim.threeStraight ?? 100;
  document.getElementById('limitThreeToad').value = lim.threeToad ?? 100;
  document.getElementById('limitTwoTop').value = lim.twoTop ?? 30;
  document.getElementById('limitTwoBottom').value = lim.twoBottom ?? 100;

  document.getElementById('settingLineToken').value = s.lineChannelAccessToken || '';
  document.getElementById('settingLineSecret').value = s.lineChannelSecret || '';
}

async function saveSettingsFromForm() {
  const payload = {
    geminiModel: document.getElementById('settingGeminiModel').value,
    geminiApiKey: document.getElementById('settingGeminiKey').value.trim(),
    permutationMode: document.getElementById('settingPermMode').value,
    checkMultiplesOf11: document.getElementById('settingCheck11').checked,
    riskLimits: {
      threeStraight: Number(document.getElementById('limitThreeStraight').value) || 100,
      threeToad: Number(document.getElementById('limitThreeToad').value) || 100,
      twoTop: Number(document.getElementById('limitTwoTop').value) || 30,
      twoBottom: Number(document.getElementById('limitTwoBottom').value) || 100
    },
    lineChannelAccessToken: document.getElementById('settingLineToken').value.trim(),
    lineChannelSecret: document.getElementById('settingLineSecret').value.trim()
  };

  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  await fetchAppState();
  showToast('✅ บันทึกการตั้งค่าและคำนวณยอดรวมใหม่เรียบร้อยแล้ว');
}

async function resetDemoDatabase() {
  await fetch('/api/reset', { method: 'POST' });
  selectedLayoffKeys.clear();
  customLayoffAmounts = {};
  await fetchAppState();
  showToast('🔄 รีเซ็ตข้อมูลตัวอย่างเริ่มต้นเรียบร้อยแล้ว');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
