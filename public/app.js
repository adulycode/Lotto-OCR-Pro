// ระบบควบคุมหน้าเว็บจัดการโพยหวย (แยกตามงวด • เช็คใครส่งอะไรมา • เลขอั้น 50% ตามเวลาประกาศ • ตัดยอดส่งเจ้ามือ)

let appState = {
  currentDrawId: '',
  currentDraw: null,
  draws: [],
  settings: {},
  slips: [],
  customersInDraw: [],
  aggregated: [],
  layoffs: [],
  lineChats: [],
  summary: {}
};

let currentAggFilter = 'all';
let selectedCustomerFilter = null; // กรองดูเฉพาะเด็กโพยที่คลิกเลือก (รวมทุกรอบของคนนั้น)
let selectedSlipRoundFilter = null; // กรองดูเฉพาะบิล/รอบที่คลิกเลือก (เฉพาะรอบนั้นใบเดียว)
let expandedRunnerCards = new Set(); // เก็บรายชื่อเด็กโพยที่กดกางดูรายการแต่ละรอบ
let selectedAggNumberKey = null;
let selectedLayoffKeys = new Set();
let customLayoffAmounts = {}; // key -> sendAmt in this round
let layoffTableFilter = 'pending_only'; // 'pending_only' = เฉพาะเลขที่มียอดเข้ามาใหม่, 'all' = ดูทุกเลข
let currentInspectorRunner = ''; // ชื่อเด็กโพยที่เลือกในหน้าตรวจบิล OCR
let currentLearnedRunnerFilter = 'all'; // กรองความจำ AI ตามชื่อเด็กโพย
let currentInspectedSlipId = null;
let showWarningsOnlyInInspector = false;
let currentZoom = 1.0;
let uploadedBase64Image = '';
let uploadedColumnSlices = null;

document.addEventListener('DOMContentLoaded', async () => {
  buildPrintable4x30Template();
  await fetchAppState();
  const webhookEl = document.getElementById('webhookUrlDisplay');
  if (webhookEl) webhookEl.value = `${window.location.origin}/api/line/webhook`;
});

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 3800);
}

function formatThaiDateTime(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('th-TH', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' น.';
  } catch {
    return isoStr;
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));

  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');

  const btn = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');
}

async function fetchAppState(drawIdParam = '') {
  const url = drawIdParam ? `/api/state?drawId=${encodeURIComponent(drawIdParam)}` : '/api/state';
  const res = await fetch(url);
  appState = await res.json();

  if (selectedLayoffKeys.size === 0 && appState.aggregated) {
    // Default select numbers that have NEW pending amounts (> 0) and are over limit or restricted
    appState.aggregated.forEach(item => {
      if (item.hasNewPending && (item.isOverLimit || item.isRestricted)) {
        selectedLayoffKeys.add(item.key);
      }
    });
  }

  renderHeaderAndKpis();
  renderCustomersInDraw();
  renderAggregatedTable();
  renderRestrictedNumbersTab();
  renderLayoffBuilder();
  renderInspectorSelector();
  renderLearnedRules();
  renderLineSimulator();
  populateSettingsForm();
}

async function onSwitchDraw(drawId) {
  selectedCustomerFilter = null;
  selectedAggNumberKey = null;
  selectedLayoffKeys.clear();
  await fetch('/api/draws', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'switch', drawId })
  });
  await fetchAppState(drawId);
  showToast(`📅 สลับไปยัง "${appState.currentDraw?.title || ''}" เรียบร้อย`);
}

async function openNewDrawModal() {
  const title = prompt('ระบุชื่องวดหวยใหม่ (เช่น งวดวันที่ 16 ธ.ค. 2569):', 'งวดวันที่ 16 ธ.ค. 2569');
  if (!title) return;
  const res = await fetch('/api/draws', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  if (res.ok) {
    selectedCustomerFilter = null;
    selectedAggNumberKey = null;
    await fetchAppState();
    showToast(`✅ เปิดงวดใหม่ "${title}" เรียบร้อยแล้ว`);
  }
}

function renderHeaderAndKpis() {
  const s = appState.summary || {};
  const settings = appState.settings || {};
  const draw = appState.currentDraw || {};

  // Draw dropdown
  const drawSelect = document.getElementById('drawSelect');
  if (drawSelect && Array.isArray(appState.draws)) {
    drawSelect.innerHTML = appState.draws
      .map(d => `<option value="${d.id}" ${d.id === appState.currentDrawId ? 'selected' : ''}>${d.title}</option>`)
      .join('');
  }

  document.getElementById('headerModelBadge').textContent = settings.geminiModel || 'gemini-2.5-pro';
  document.getElementById('kpiTotalCustomers').textContent = `${s.totalCustomers || 0} คน (${s.totalSlips || 0} บิล)`;
  document.getElementById('kpiTotalMoney').textContent = `${(s.totalGrandMoney || 0).toLocaleString()} บาท`;
  document.getElementById('kpiUniqueNumbers').textContent = `รวมทั้งหมด ${s.totalUniqueNumbers || 0} เลขไม่ซ้ำกัน`;

  document.getElementById('kpiFull100').textContent = `${(s.totalFull100Money || 0).toLocaleString()} ฿`;
  document.getElementById('kpiHalf50').textContent = `${(s.totalHalf50Money || 0).toLocaleString()} ฿`;

  const restrictedNums = (draw.restrictedNumbers || []).map(r => r.number);
  document.getElementById('kpiRestrictedList').textContent =
    restrictedNums.length > 0 ? `${restrictedNums.join(', ')} (${restrictedNums.length} ชุด)` : 'ยังไม่มีเลขอั้น';

  const badgeRest = document.getElementById('badgeRestrictedCount');
  if (badgeRest) badgeRest.textContent = restrictedNums.length;

  const totalWarnRows = (appState.slips || []).reduce((acc, sl) => acc + (sl.reviewCount || 0), 0);
  const badgeRev = document.getElementById('badgeReviewCount');
  if (badgeRev) {
    badgeRev.textContent = totalWarnRows;
    badgeRev.style.display = totalWarnRows > 0 ? 'inline-block' : 'none';
  }

  const isExpand = settings.permutationMode !== 'keep_raw';
  document.getElementById('btnModeExpand').classList.toggle('active', isExpand);
  document.getElementById('btnModeRaw').classList.toggle('active', !isExpand);

  const subtitle = document.getElementById('aggModeSubtitle');
  if (isExpand) {
    subtitle.innerHTML =
      'วิธีคิดเลขชุดกลับตอนนี้: <strong>🔀 แยกเลขทุกประตูอัตโนมัติ</strong> (เช่น <code>072×6 = 66฿</code> แตกเป็น 6 หาง หางละ 11฿ รวมเข้ากับยอด 3 ตัวบนทันที)';
  } else {
    subtitle.innerHTML =
      'วิธีคิดเลขชุดกลับตอนนี้: <strong>📋 คงตามหน้าโพย (ไม่แยกหาง)</strong> (เก็บ <code>072×6 = 66฿</code> ไว้เป็นรายการชุดกลับตามที่เขียน)';
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

// ============================================================================
// แท็บที่ 1 (ฝั่งซ้าย): เด็กโพย 1 คน ส่งหลายรอบ (พับ/กางดูทีละรอบ + กรองดูได้ทั้งระดับคนและระดับรอบ)
// ============================================================================
function filterByCustomer(customerName) {
  selectedSlipRoundFilter = null;
  selectedCustomerFilter = selectedCustomerFilter === customerName ? null : customerName;
  renderCustomersInDraw();
  renderAggregatedTable();
}

function filterBySingleRound(customerName, slipId, roundNumber) {
  selectedCustomerFilter = customerName;
  selectedSlipRoundFilter = selectedSlipRoundFilter === slipId ? null : slipId;
  expandedRunnerCards.add(customerName);
  renderCustomersInDraw();
  renderAggregatedTable();
}

function toggleRunnerRoundsDrawer(customerName) {
  if (expandedRunnerCards.has(customerName)) {
    expandedRunnerCards.delete(customerName);
  } else {
    expandedRunnerCards.add(customerName);
  }
  renderCustomersInDraw();
}

function renderCustomersInDraw() {
  const container = document.getElementById('customerCardsContainer');
  const customers = appState.customersInDraw || [];

  if (customers.length === 0) {
    container.innerHTML = `<div class="text-muted" style="text-align:center;padding:24px;">ยังไม่มีเด็กโพยส่งบิลในงวดนี้ (กดที่แท็บ "💬 5. ส่งโพยเข้าระบบ" เพื่อเพิ่มบิลแรกได้เลย)</div>`;
    return;
  }

  container.innerHTML = customers
    .map(c => {
      const isActive = selectedCustomerFilter === c.customerName;
      const isExpanded = expandedRunnerCards.has(c.customerName);

      const slipsHtml = c.slips
        .map((sl, idx) => {
          const rNum = sl.roundNumber || idx + 1;
          const has50 = sl.half50Money > 0;
          const isRoundSelected = selectedSlipRoundFilter === sl.id;

          return `
            <div class="slip-mini-row ${isRoundSelected ? 'active-round' : ''}"
              onclick="event.stopPropagation(); filterBySingleRound('${c.customerName}', '${sl.id}', ${rNum})">
              <div>
                <div style="font-weight:700;color:#fde68a;">
                  📌 รอบที่ ${rNum}: <span style="color:#e2e8f0;font-weight:600;">${sl.title.replace(/^รอบที่ \d+ — /, '')}</span>
                </div>
                <div class="text-muted">ส่งเมื่อ: ${formatThaiDateTime(sl.createdAt)} (${sl.totalItems} รายการ)</div>
                ${
                  has50
                    ? `<div style="margin-top:3px;"><span class="badge-50">🔒 มีเลขอั้นส่งหลังประกาศ (${sl.restrictedHits.join(', ')}) = ${sl.half50Money.toLocaleString()}฿ จ่าย 50%</span></div>`
                    : `<div style="margin-top:3px;"><span class="badge-100">🟢 ส่งก่อนอั้น จ่ายเต็ม 100%</span></div>`
                }
              </div>
              <div style="text-align:right;min-width:92px;">
                <div style="font-family:var(--font-mono);font-weight:700;color:var(--gold);">${sl.totalMoney.toLocaleString()} ฿</div>
                <button type="button" class="btn btn-ghost btn-sm" style="margin-top:4px;padding:2px 7px;font-size:11px;color:#60a5fa;"
                  onclick="event.stopPropagation(); jumpToSlipInspector('${sl.id}', 1, 1)">
                  🔍 ตรวจใบนี้
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="customer-card ${isActive ? 'active-customer' : ''}" onclick="filterByCustomer('${c.customerName}')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:15px;font-weight:700;color:#93c5fd;display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
                <span>👤 ${c.customerName}</span>
                <span class="runner-rounds-badge">ส่งแล้ว ${c.slipCount} รอบ</span>
              </div>
              <div class="text-muted" style="margin-top:3px;">
                รวมทุกรอบ: <strong>${c.totalItems} รายการ</strong> • ส่งล่าสุด: ${formatThaiDateTime(c.latestAt)}
              </div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:10.5px;color:var(--text-muted);">ยอดสะสมรวม ${c.slipCount} รอบ</div>
              <div style="font-family:var(--font-mono);font-size:18px;font-weight:700;color:var(--gold);">
                ${c.totalMoney.toLocaleString()} ฿
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:11.5px;">
            <div>
              <span class="badge-100">🟢 ได้ 100%: ${c.full100Money.toLocaleString()} ฿</span>
              ${
                c.half50Money > 0
                  ? `<span class="badge-50" style="margin-left:4px;">🔒 ติดอั้น 50%: ${c.half50Money.toLocaleString()} ฿</span>`
                  : ''
              }
            </div>
          </div>

          <div class="runner-actions-bar" onclick="event.stopPropagation()">
            <button type="button" class="btn ${isActive && !selectedSlipRoundFilter ? 'btn-primary' : 'btn-outline'} btn-sm" style="flex:1;"
              onclick="filterByCustomer('${c.customerName}')">
              📊 ${isActive && !selectedSlipRoundFilter ? 'กำลังดูยอดรวมทุกใบของคนนี้' : `ดูยอดรวมทั้ง ${c.slipCount} รอบ`}
            </button>
            <button type="button" class="btn btn-ghost btn-sm"
              onclick="toggleRunnerRoundsDrawer('${c.customerName}')">
              📂 ${isExpanded ? 'พับเก็บ ▲' : `กางดูทีละรอบ (${c.slipCount}) ▼`}
            </button>
          </div>

          <div class="rounds-drawer ${isExpanded ? '' : 'hidden'}">
            <div style="font-size:11px;color:var(--text-muted);padding:2px 4px 4px 4px;">
              คลิกที่รอบใดก็ได้เพื่อกรองดูตารางตัวเลขเฉพาะรอบนั้น หรือกด "🔍 ตรวจใบนี้" เพื่อดูรูปโพย:
            </div>
            ${slipsHtml}
          </div>
        </div>
      `;
    })
    .join('');
}

// ============================================================================
// แท็บที่ 1 (ฝั่งขวา): สรุปยอดรวมแต่ละเลขในงวดนี้ (รองรับกรอง 3 ระดับ: ทั้งงวด / รายคนทุกรอบ / เฉพาะรอบ)
// ============================================================================
function setAggFilter(filter, btnEl) {
  currentAggFilter = filter;
  document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  renderAggregatedTable();
}

function renderAggregatedTable() {
  const tbody = document.getElementById('aggTableBody');
  const search = (document.getElementById('searchNumberInput')?.value || '').trim();
  const titleEl = document.getElementById('aggTableTitle');

  if (selectedSlipRoundFilter) {
    const slipObj = (appState.slips || []).find(s => s.id === selectedSlipRoundFilter);
    titleEl.innerHTML = `📄 2. กำลังดูเฉพาะ: <span style="color:var(--gold);">${selectedCustomerFilter} — รอบที่ ${slipObj?.roundNumber || ''} (${(slipObj?.totalMoney || 0).toLocaleString()}฿)</span> <button class="btn btn-outline btn-sm" style="margin-left:8px;" onclick="filterByCustomer('${selectedCustomerFilter}')">📊 ดูรวมทุกรอบของคนนี้</button> <button class="btn btn-ghost btn-sm" onclick="filterByCustomer(null)">🌐 ดูรวมทุกคน</button>`;
  } else if (selectedCustomerFilter) {
    const custObj = (appState.customersInDraw || []).find(c => c.customerName === selectedCustomerFilter);
    titleEl.innerHTML = `👤 2. ยอดรวมทุกรอบของ: <span style="color:#60a5fa;">${selectedCustomerFilter} (รวม ${custObj?.slipCount || 1} รอบ = ${(custObj?.totalMoney || 0).toLocaleString()}฿)</span> <button class="btn btn-ghost btn-sm" style="margin-left:8px;" onclick="filterByCustomer(null)">🌐 กลับไปดูรวมทุกคนทั้งงวด</button>`;
  } else {
    titleEl.textContent = `📊 2. สรุปยอดรวมแต่ละเลขในงวดนี้ (รวมเด็กโพยทุกคน ทุกรอบ เป็นยอดเงินเดียว)`;
  }

  // แถบตัวอย่างไฮไลต์ด้านบนตาราง
  const highlightBar = document.getElementById('exampleHighlightBar');
  const num21 = (appState.aggregated || []).find(a => a.number === '21');
  const num583 = (appState.aggregated || []).find(a => a.number === '583');
  const num154 = (appState.aggregated || []).find(a => a.number === '154');

  let hlHtml = `<span>💡 <strong>คลิกดูตัวอย่างเลขที่ส่งมาหลายรอบและแยกเวลาส่งก่อนอั้น (100%) vs หลังอั้น (50%):</strong></span>`;
  if (num21) {
    hlHtml += `<span class="hl-badge" onclick="inspectAggNumber('${num21.key}')">เลข <strong>21</strong> รวม = ${num21.totalAmt}฿ (100% = ${num21.fullPayout100Amt}฿ | 50% = ${num21.halfPayout50Amt}฿)</span>`;
  }
  if (num154) {
    hlHtml += `<span class="hl-badge" onclick="inspectAggNumber('${num154.key}')">เลข <strong>154</strong> รวม = ${num154.totalAmt}฿ (100% = ${num154.fullPayout100Amt}฿ | 50% = ${num154.halfPayout50Amt}฿)</span>`;
  }
  if (num583) {
    hlHtml += `<span class="hl-badge" onclick="inspectAggNumber('${num583.key}')">เลข <strong>583</strong> รวม = ${num583.totalAmt}฿ (รวม ${num583.hitCount} รอบ)</span>`;
  }
  highlightBar.innerHTML = hlHtml;

  // คำนวณรายการตัวเลขตามระดับตัวกรอง (ทั้งงวด vs เฉพาะเด็กโพยคนเดียวรวมทุกรอบ vs เฉพาะรอบเดียว)
  let list = (appState.aggregated || []).map(item => {
    if (!selectedCustomerFilter && !selectedSlipRoundFilter) return item;

    const filteredContribs = item.contributors.filter(c => {
      if (selectedSlipRoundFilter) return c.slipId === selectedSlipRoundFilter;
      if (selectedCustomerFilter) return c.customerName === selectedCustomerFilter;
      return true;
    });

    if (filteredContribs.length === 0) return null;

    let totalAmt = 0;
    let full100 = 0;
    let half50 = 0;
    let threeStraightAmt = 0;
    let threeToadAmt = 0;
    let threePermRawAmt = 0;
    let twoTopAmt = 0;
    let twoBottomAmt = 0;

    for (const fc of filteredContribs) {
      totalAmt += fc.amount;
      if (fc.payoutPercent === 100) full100 += fc.amount;
      else half50 += fc.amount;

      if (fc.fieldKey === 'threeStraightAmt') threeStraightAmt += fc.amount;
      else if (fc.fieldKey === 'threeToadAmt') threeToadAmt += fc.amount;
      else if (fc.fieldKey === 'threePermRawAmt') threePermRawAmt += fc.amount;
      else if (fc.fieldKey === 'twoTopAmt') twoTopAmt += fc.amount;
      else if (fc.fieldKey === 'twoBottomAmt') twoBottomAmt += fc.amount;
    }

    const distinctRowCount = new Set(filteredContribs.map(c => c.rowKey || `${c.slipId}_${c.col}_${c.row}`)).size;

    return {
      ...item,
      threeStraightAmt,
      threeToadAmt,
      threePermRawAmt,
      twoTopAmt,
      twoBottomAmt,
      totalAmt,
      fullPayout100Amt: full100,
      halfPayout50Amt: half50,
      hitCount: distinctRowCount,
      uniqueCustomers: new Set(filteredContribs.map(c => c.customerName)).size,
      contributors: filteredContribs
    };
  }).filter(Boolean);

  if (search) {
    list = list.filter(item => item.number.includes(search));
  }
  if (currentAggFilter === 'multi_hit') {
    list = list.filter(item => item.hitCount > 1);
  } else if (currentAggFilter === 'restricted') {
    list = list.filter(item => item.isRestricted);
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
      const topAmt = item.digitCount === 2 ? item.twoTopAmt : item.threeStraightAmt;
      const secondAmt =
        item.digitCount === 2
          ? item.twoBottomAmt
          : item.threeToadAmt + item.threePermRawAmt;

      const customerNames = Array.from(new Set(item.contributors.map(c => c.customerName))).join(', ');

      return `
        <tr class="${isSelected ? 'selected-row' : ''}" onclick="inspectAggNumber('${item.key}')">
          <td>
            <span class="number-pill">${item.number}</span>
          </td>
          <td>
            ${
              item.isRestricted
                ? `<span class="badge-50">🔒 เลขอั้น ${item.restrictedRule?.payoutPercent || 50}%</span>`
                : `<span class="badge-100">🟢 ปกติ 100%</span>`
            }
          </td>
          <td class="num-col">${topAmt > 0 ? `${topAmt.toLocaleString()} ฿` : '-'}</td>
          <td class="num-col">${secondAmt > 0 ? `${secondAmt.toLocaleString()} ฿` : '-'}</td>
          <td class="num-col" style="color:var(--gold);font-weight:700;font-size:15px;">
            ${item.totalAmt.toLocaleString()} ฿
          </td>
          <td class="num-col">
            ${
              item.fullPayout100Amt > 0
                ? `<strong style="color:#34d399;">${item.fullPayout100Amt.toLocaleString()} ฿</strong>`
                : '-'
            }
          </td>
          <td class="num-col">
            ${
              item.halfPayout50Amt > 0
                ? `<strong style="color:#fb923c;">${item.halfPayout50Amt.toLocaleString()} ฿</strong>`
                : '-'
            }
          </td>
          <td style="font-size:12.5px;">
            <strong>รวม ${item.hitCount} รายการ</strong>
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
  const container = document.getElementById('selectedNumberBreakdownBox');
  const item = (appState.aggregated || []).find(a => a.key === selectedAggNumberKey);
  if (!item) {
    container.innerHTML = `<div class="text-muted">คลิกที่แถวตัวเลขในตารางด้านบน เพื่อดูว่าใครส่งเลขนั้นมาบ้าง ส่งเวลาไหน ได้เรท 100% หรือ 50%</div>`;
    return;
  }

  const contribHtml = item.contributors
    .map(c => {
      const is100 = c.payoutPercent === 100;
      return `
        <div class="contributor-item" style="margin-top:8px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <strong style="color:#60a5fa;font-size:14px;">👤 ${c.customerName}</strong>
              ${
                is100
                  ? `<span class="badge-100">🟢 แทงก่อนเวลาอั้น ➔ ได้เต็ม 100%</span>`
                  : `<span class="badge-50">🔒 แทงหลังเวลาอั้น ➔ ได้ ${c.payoutPercent}%</span>`
              }
            </div>
            <div class="text-muted" style="margin-top:2px;">
              จาก: <strong>${c.slipTitle}</strong> • เวลาที่ส่ง: ${formatThaiDateTime(c.createdAt)}
            </div>
            <div style="font-size:12px;margin-top:2px;">
              ที่เขียนในโพย: <code style="color:var(--gold);">${c.originalWrite}</code> (${c.typeLabel})
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:${is100 ? '#34d399' : '#fb923c'};">
              +${c.amount.toLocaleString()} บาท
            </div>
            <button class="btn btn-ghost btn-sm" style="margin-top:4px;" onclick="jumpToSlipInspector('${c.slipId}', ${c.col || 1}, ${c.row || 1})">
              🔍 ดูในใบโพย
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <div>
        <span style="font-size:13px;font-weight:700;">📌 รายละเอียดผู้ส่งเลข:</span>
        <span class="number-pill" style="font-size:18px;margin-left:8px;">${item.number}</span>
        ${
          item.isRestricted
            ? `<span class="badge-50" style="margin-left:8px;">🔒 เลขอั้นเจ้ามือ (ประกาศอั้นเมื่อ ${formatThaiDateTime(item.restrictedRule?.announcedAt)})</span>`
            : ''
        }
      </div>
      <div style="display:flex;gap:16px;font-family:var(--font-mono);font-size:14px;">
        <span>🟢 ยอดที่ได้ 100%: <strong class="text-success">${item.fullPayout100Amt.toLocaleString()} ฿</strong></span>
        <span>🔒 ยอดที่ได้ 50%: <strong class="text-warn">${item.halfPayout50Amt.toLocaleString()} ฿</strong></span>
        <span>💰 ยอดรวมทั้งหมด: <strong class="text-gold">${item.totalAmt.toLocaleString()} ฿</strong></span>
      </div>
    </div>
    ${contribHtml}
  `;
}

// ============================================================================
// แท็บที่ 2: จัดการเลขอั้นเจ้ามือ 50% ตามเวลาที่ประกาศ
// ============================================================================
function renderRestrictedNumbersTab() {
  const wrap = document.getElementById('restrictedNumbersTableWrap');
  if (!wrap) return;

  const list = appState.currentDraw?.restrictedNumbers || [];
  if (list.length === 0) {
    wrap.innerHTML = `<div class="text-muted" style="padding:24px;text-align:center;">ยังไม่มีเลขอั้นในงวดนี้ สามารถพิมพ์เลขด้านซ้ายแล้วกดบันทึกได้เลยครับ</div>`;
    return;
  }

  const rowsHtml = list
    .map(r => {
      const agg = (appState.aggregated || []).find(a => a.number === r.number);
      const full100 = agg ? agg.fullPayout100Amt : 0;
      const half50 = agg ? agg.halfPayout50Amt : 0;
      const total = agg ? agg.totalAmt : 0;

      return `
        <tr>
          <td><span class="number-pill">${r.number}</span></td>
          <td><span class="badge-50">จ่าย ${r.payoutPercent}%</span></td>
          <td>${formatThaiDateTime(r.announcedAt)}</td>
          <td class="num-col" style="color:#34d399;font-weight:700;">${full100.toLocaleString()} ฿</td>
          <td class="num-col" style="color:#fb923c;font-weight:700;">${half50.toLocaleString()} ฿</td>
          <td class="num-col" style="color:var(--gold);font-weight:700;">${total.toLocaleString()} ฿</td>
          <td style="text-align:right;">
            <button class="btn btn-ghost btn-sm" onclick="removeRestrictedNumber('${r.number}')">ลบ</button>
          </td>
        </tr>
      `;
    })
    .join('');

  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>เลขอั้น</th>
            <th>เรทหลังอั้น</th>
            <th>เวลาที่เจ้ามือประกาศ</th>
            <th class="num-col">แทงก่อนอั้น (ได้ 100%)</th>
            <th class="num-col">แทงหลังอั้น (ได้ 50%)</th>
            <th class="num-col">ยอดรวมเลขนี้</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

async function addRestrictedNumbersBatch(useNow = false) {
  const numbersText = document.getElementById('restrictNumbersInput').value.trim();
  if (!numbersText) {
    showToast('กรุณากรอกตัวเลขที่เจ้ามือแจ้งอั้นก่อนครับ');
    return;
  }

  const payoutPercent = Number(document.getElementById('restrictPayoutPercentInput').value) || 50;
  let announcedAt = new Date().toISOString();
  if (!useNow) {
    const dtVal = document.getElementById('restrictAnnouncedAtInput').value;
    if (dtVal) announcedAt = new Date(dtVal).toISOString();
  }

  await fetch('/api/draws/restrictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add_batch',
      drawId: appState.currentDrawId,
      numbersText,
      payoutPercent,
      announcedAt
    })
  });

  await fetchAppState();
  showToast('🔒 บันทึกชุดเลขอั้นและคำนวณแยกบิล 100% / 50% ตามเวลาที่ส่งเรียบร้อยแล้ว!');
}

async function removeRestrictedNumber(number) {
  await fetch('/api/draws/restrictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'remove',
      drawId: appState.currentDrawId,
      number
    })
  });
  await fetchAppState();
  showToast(`ลบเลข ${number} ออกจากรายการอั้นแล้ว`);
}

async function clearAllRestrictions() {
  await fetch('/api/draws/restrictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'clear_all',
      drawId: appState.currentDrawId
    })
  });
  await fetchAppState();
  showToast('ล้างรายการเลขอั้นทั้งหมดในงวดนี้แล้ว');
}

// ============================================================================
// แท็บที่ 3: ตัดยอดส่งเจ้ามือเป็นรอบๆ (หักลบยอดที่ส่งแล้ว/เก็บแล้วอัตโนมัติ ไม่ส่งซ้ำ)
// ============================================================================
function setLayoffTableFilter(filterMode) {
  layoffTableFilter = filterMode;
  document.getElementById('btnFilterLayoffPending')?.classList.toggle('active', filterMode === 'pending_only');
  document.getElementById('btnFilterLayoffAll')?.classList.toggle('active', filterMode === 'all');
  renderLayoffBuilder();
}

function toggleLayoffItem(key, checked) {
  const item = (appState.aggregated || []).find(a => a.key === key);
  if (checked && item && !item.hasNewPending) {
    showToast(`เลข ${item.number} จัดการยอดครบไปแล้วในรอบก่อน (ยอดเข้ามาใหม่ = 0 บาท) จึงไม่ดึงมาส่งซ้ำครับ`);
    renderLayoffBuilder();
    return;
  }
  if (checked) selectedLayoffKeys.add(key);
  else {
    selectedLayoffKeys.delete(key);
    delete customLayoffAmounts[key];
  }
  renderLayoffBuilder();
}

function toggleSelectAllAgg(checked) {
  if (checked) {
    (appState.aggregated || []).forEach(a => {
      if (a.hasNewPending) selectedLayoffKeys.add(a.key);
    });
  } else {
    selectedLayoffKeys.clear();
    customLayoffAmounts = {};
  }
  renderLayoffBuilder();
}

function selectAllNewPendingForDealer() {
  selectedLayoffKeys.clear();
  customLayoffAmounts = {};
  (appState.aggregated || []).forEach(a => {
    if (a.hasNewPending) selectedLayoffKeys.add(a.key);
  });
  renderLayoffBuilder();
  showToast(`เลือกเลขที่มียอดเข้ามาใหม่ทั้งหมด ${selectedLayoffKeys.size} เลขแล้ว`);
}

function clearLayoffSelection() {
  selectedLayoffKeys.clear();
  customLayoffAmounts = {};
  renderLayoffBuilder();
}

function onChangeLayoffPresetMode() {
  customLayoffAmounts = {};
  renderLayoffBuilder();
}

function onCustomLayoffAmountChange(key, val, maxNewPending) {
  const numVal = Math.min(maxNewPending, Math.max(0, Number(val) || 0));
  customLayoffAmounts[key] = numVal;
  renderLayoffBuilder(true);
}

function setRowActionQuick(key, actionType, maxNewPending) {
  selectedLayoffKeys.add(key);
  if (actionType === 'send_all') {
    customLayoffAmounts[key] = maxNewPending;
  } else if (actionType === 'keep_all') {
    customLayoffAmounts[key] = 0; // ส่งเจ้ามือ 0 = เก็บไว้ที่เราทั้งหมดในรอบนี้
  }
  renderLayoffBuilder();
}

function computeDefaultSendForNewPending(item, mode) {
  const newAmt = item.newPendingAmt || 0;
  if (newAmt <= 0) return 0;

  if (mode === 'keep_all_new') {
    return 0;
  }
  if (mode === 'split_half') {
    return Math.round(newAmt / 2);
  }
  if (mode === 'keep_within_limit') {
    const limit = item.digitCount === 2
      ? (appState.settings?.riskLimits?.twoTop || 30)
      : (appState.settings?.riskLimits?.threeStraight || 100);
    const roomToKeep = Math.max(0, limit - (item.alreadyKeptAmt || 0));
    const keepThisRound = Math.min(newAmt, roomToKeep);
    return Math.max(0, newAmt - keepThisRound);
  }
  // default: 'send_all_new'
  return newAmt;
}

function renderLayoffBuilder(skipInputRebuild = false) {
  const s = appState.summary || {};
  const nextRound = s.nextLayoffRound || ((appState.layoffs || []).length + 1);

  const elGrand = document.getElementById('layoffKpiGrandTotal');
  if (elGrand) {
    elGrand.textContent = `${(s.totalGrandMoney || 0).toLocaleString()} ฿`;
    document.getElementById('layoffKpiAlreadySent').textContent = `${(s.totalSentToDealerMoney || 0).toLocaleString()} ฿`;
    document.getElementById('layoffKpiAlreadyKept').textContent = `${(s.totalKeptByUsMoney || 0).toLocaleString()} ฿`;
    document.getElementById('layoffKpiNewPending').textContent = `${(s.totalNewPendingMoney || 0).toLocaleString()} ฿`;
    document.getElementById('layoffKpiNewPendingSub').textContent =
      `มี ${s.pendingNumbersCount || 0} เลขที่มียอดเข้ามาใหม่ รอจัดการในรอบที่ ${nextRound}`;
    document.getElementById('currentLayoffRoundTitle').textContent = `รอบที่ ${nextRound}`;
    document.getElementById('rightLayoffRoundBadge').textContent = `รอบที่ ${nextRound}`;
  }

  const selectTbody = document.getElementById('layoffSelectTableBody');
  if (selectTbody) {
    let tableList = appState.aggregated || [];
    if (layoffTableFilter === 'pending_only') {
      tableList = tableList.filter(item => item.hasNewPending);
    }

    if (tableList.length === 0) {
      selectTbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center;padding:28px;color:var(--success);font-weight:600;">
            ✅ จัดการยอดของทุกเลขครบหมดแล้วในรอบนี้ (ไม่มีเลขค้างส่งซ้ำ) — เมื่อลูกค้าส่งโพยรอบใหม่เข้ามา ยอดใหม่จะเด้งขึ้นมาที่นี่อัตโนมัติครับ
          </td>
        </tr>
      `;
    } else {
      selectTbody.innerHTML = tableList
        .map(item => {
          const isChecked = selectedLayoffKeys.has(item.key) && item.hasNewPending;
          const statusBadge = !item.hasNewPending
            ? `<span class="badge-100">✅ จัดการครบแล้ว</span>`
            : item.alreadyHandledAmt > 0
              ? `<span class="badge-50">🔥 มียอดเข้ามาเพิ่มใหม่!</span>`
              : `<span class="badge-50">🔥 ยอดใหม่รอจัดสรร</span>`;

          return `
            <tr class="${isChecked ? 'selected-row' : ''}" onclick="toggleLayoffItem('${item.key}', ${!isChecked})">
              <td style="text-align:center;" onclick="event.stopPropagation()">
                <input type="checkbox" ${isChecked ? 'checked' : ''} ${!item.hasNewPending ? 'disabled' : ''}
                  onchange="toggleLayoffItem('${item.key}', this.checked)" />
              </td>
              <td>
                <div class="num-cell-wrap">
                  <span class="number-pill">${item.number}</span>
                  ${item.isRestricted ? `<span class="badge-50">อั้น 50%</span>` : ''}
                </div>
              </td>
              <td class="num-col">${item.totalAmt.toLocaleString()} ฿</td>
              <td class="num-col" style="color:#60a5fa;">
                ${item.alreadySentAmt > 0 ? `${item.alreadySentAmt.toLocaleString()} ฿` : '-'}
              </td>
              <td class="num-col" style="color:#34d399;">
                ${item.alreadyKeptAmt > 0 ? `${item.alreadyKeptAmt.toLocaleString()} ฿` : '-'}
              </td>
              <td class="num-col" style="color:#fbbf24;font-weight:700;font-size:15px;">
                ${item.newPendingAmt > 0 ? `+${item.newPendingAmt.toLocaleString()} ฿` : '0 ฿'}
              </td>
              <td onclick="event.stopPropagation()">
                ${
                  item.hasNewPending
                    ? `<div style="display:flex;gap:4px;">
                        <button class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:11px;"
                          onclick="setRowActionQuick('${item.key}', 'send_all', ${item.newPendingAmt})">📤 ส่งเจ้ามือ</button>
                        <button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:11px;color:#34d399;"
                          onclick="setRowActionQuick('${item.key}', 'keep_all', ${item.newPendingAmt})">🏠 เก็บไว้ที่เรา</button>
                      </div>`
                    : statusBadge
                }
              </td>
            </tr>
          `;
        })
        .join('');
    }
  }

  const mode = document.getElementById('layoffModeSelect')?.value || 'send_all_new';
  const dealerName = document.getElementById('dealerNameInput')?.value || 'เจ้ามือสายใหญ่ #1';
  const listContainer = document.getElementById('layoffItemsList');
  if (!listContainer) return;

  const selectedItems = (appState.aggregated || []).filter(
    a => selectedLayoffKeys.has(a.key) && a.hasNewPending
  );

  let totalSendThisRound = 0;
  let totalKeepThisRound = 0;

  const layoffRows = selectedItems.map(item => {
    const newAmt = item.newPendingAmt || 0;
    const defaultSend = computeDefaultSendForNewPending(item, mode);
    const sendAmt =
      customLayoffAmounts[item.key] !== undefined
        ? Math.min(newAmt, Math.max(0, customLayoffAmounts[item.key]))
        : defaultSend;
    const keepAmt = Math.max(0, newAmt - sendAmt);

    totalSendThisRound += sendAmt;
    totalKeepThisRound += keepAmt;

    let typeDesc = item.digitCount === 2 ? '2 ตัวบน' : '3 ตัวบน';
    if (item.threeStraightAmt > 0 && item.threeToadAmt > 0) {
      typeDesc = `3 ตัวบน+โต๊ด`;
    }

    return {
      key: item.key,
      number: item.number,
      typeDesc,
      newPendingAmt: newAmt,
      alreadySentAmt: item.alreadySentAmt,
      alreadyKeptAmt: item.alreadyKeptAmt,
      keepTotal: keepAmt,
      sendTotal: sendAmt
    };
  });

  if (!skipInputRebuild) {
    if (layoffRows.length === 0) {
      listContainer.innerHTML = `<div class="text-muted" style="text-align:center;padding:18px;">ติ๊กเลือกตัวเลขจากตารางด้านซ้าย (หรือกดปุ่ม "📤 ส่งเจ้ามือ" / "🏠 เก็บไว้ที่เรา") เพื่อจัดสรรยอดใหม่ของรอบที่ ${nextRound}</div>`;
    } else {
      listContainer.innerHTML = layoffRows
        .map(
          r => `
        <div class="layoff-row-item" style="flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="font-family:var(--font-mono);color:var(--gold);font-size:15px;">${r.number}</strong>
            <span style="font-size:12px;color:#fbbf24;margin-left:6px;font-weight:600;">
              ยอดใหม่รอบนี้: ${r.newPendingAmt.toLocaleString()}฿
            </span>
            ${
              r.alreadySentAmt > 0 || r.alreadyKeptAmt > 0
                ? `<span class="text-muted" style="font-size:11px;margin-left:4px;">(รอบก่อนส่งแล้ว ${r.alreadySentAmt}฿ / เก็บแล้ว ${r.alreadyKeptAmt}฿)</span>`
                : ''
            }
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:12px;color:#34d399;">🏠 เก็บที่เรา: <strong>${r.keepTotal.toLocaleString()}฿</strong></span>
            <div style="display:flex;align-items:center;gap:4px;">
              <span style="font-size:12px;color:#60a5fa;">📤 ส่งเจ้ามือ:</span>
              <input type="number" class="cell-input" style="width:76px;" value="${r.sendTotal}" max="${r.newPendingAmt}" min="0"
                oninput="onCustomLayoffAmountChange('${r.key}', this.value, ${r.newPendingAmt})" />
              <span>฿</span>
            </div>
          </div>
        </div>
      `
        )
        .join('');
    }
  } else {
    // Update the "เก็บที่เรา" text dynamically while typing without losing input focus
    renderLayoffBuilder(false);
    return;
  }

  document.getElementById('layoffSelectedCount').textContent = `${layoffRows.length} เลข`;
  document.getElementById('layoffKeepTotal').textContent = `${totalKeepThisRound.toLocaleString()} บาท`;
  document.getElementById('layoffSendTotal').textContent = `${totalSendThisRound.toLocaleString()} บาท`;

  const linesToSend = layoffRows.filter(r => r.sendTotal > 0);
  const lines = [
    `📋 ใบตัดยอดส่ง: ${dealerName} (รอบที่ ${nextRound})`,
    `📅 ${appState.currentDraw?.title || 'งวดวันที่ 16/11'}`,
    `-------------------------`,
    ...(linesToSend.length > 0
      ? linesToSend.map(r => `${r.number} = ${r.sendTotal} บ. (${r.typeDesc})`)
      : ['(รอบนี้เลือกเก็บไว้ที่เราทั้งหมด ไม่มียอดส่งเจ้ามือ)']),
    `-------------------------`,
    `รวมส่งเจ้ามือรอบที่ ${nextRound}: ${linesToSend.length} เลข | ยอดส่งรวม ${totalSendThisRound.toLocaleString()} บาท`
  ];
  document.getElementById('layoffFormattedText').value = lines.join('\n');

  const layoffHistoryEl = document.getElementById('layoffHistoryList');
  if (layoffHistoryEl) {
    const layoffs = appState.layoffs || [];
    layoffHistoryEl.innerHTML =
      layoffs.length === 0
        ? `<div class="text-muted">ยังไม่มีประวัติการส่งเจ้ามือในงวดนี้</div>`
        : layoffs
            .map(
              (l, idx) => `
          <div class="contributor-item" style="margin-bottom:8px;flex-direction:column;align-items:stretch;gap:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <span class="badge-100">รอบที่ ${l.roundNumber || idx + 1}</span>
                <strong style="margin-left:6px;">📤 ${l.dealerName}</strong>
                <span class="text-muted" style="font-size:11.5px;margin-left:6px;">(${formatThaiDateTime(l.createdAt)})</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="font-size:12px;color:#34d399;">🏠 เก็บเอง: ${(l.totalKeptMoney || 0).toLocaleString()}฿</span>
                <strong style="color:var(--gold);font-family:var(--font-mono);">📤 ส่งเจ้ามือ: ${(l.totalLayoffMoney || 0).toLocaleString()}฿</strong>
                <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;color:#34d399;border-color:rgba(16,185,129,0.45);" onclick="exportSavedLayoffRoundExcel('${l.id}')">📊 โหลด Excel รอบนี้</button>
                <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:11px;" onclick="undoLayoffRound('${l.id}')">ยกเลิกรอบนี้</button>
              </div>
            </div>
            <div style="font-size:12px;color:var(--text-muted);">
              รายการในรอบนี้: ${(l.items || [])
                .map(it => `${it.number} (ส่ง ${it.sendTotal}฿ / เก็บ ${it.keepTotal || 0}฿)`)
                .join(' • ')}
            </div>
          </div>
        `
            )
            .join('');
  }
}

async function copyAndSaveLayoff(alsoDownloadExcel = false) {
  const text = document.getElementById('layoffFormattedText').value;
  const dealerName = document.getElementById('dealerNameInput').value || 'เจ้ามือสายใหญ่ #1';
  const mode = document.getElementById('layoffModeSelect')?.value || 'send_all_new';
  const selectedItems = (appState.aggregated || []).filter(
    a => selectedLayoffKeys.has(a.key) && a.hasNewPending
  );

  if (selectedItems.length === 0) {
    showToast('กรุณาติ๊กเลือกตัวเลขที่มียอดเข้ามาใหม่เพื่อจัดการในรอบนี้ก่อนครับ');
    return;
  }

  if (alsoDownloadExcel) {
    exportCurrentLayoffExcel();
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch {}

  const itemsPayload = selectedItems.map(item => {
    const newAmt = item.newPendingAmt || 0;
    const defaultSend = computeDefaultSendForNewPending(item, mode);
    const sendTotal =
      customLayoffAmounts[item.key] !== undefined
        ? Math.min(newAmt, Math.max(0, customLayoffAmounts[item.key]))
        : defaultSend;
    const keepTotal = Math.max(0, newAmt - sendTotal);

    return {
      number: item.number,
      sendTotal,
      keepTotal,
      isRestricted: Boolean(item.isRestricted),
      payoutPercent: item.isRestricted ? (item.restrictedRule?.payoutPercent || 50) : 100,
      typeDesc: item.digitCount === 2 ? '2 ตัวบน' : (item.threeStraightAmt > 0 && item.threeToadAmt > 0 ? '3 ตัวบน+โต๊ด' : '3 ตัวบน')
    };
  });

  await fetch('/api/layoffs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drawId: appState.currentDrawId,
      dealerName,
      formattedText: text,
      items: itemsPayload
    })
  });

  selectedLayoffKeys.clear();
  customLayoffAmounts = {};
  await fetchAppState();
  showToast('✅ ยืนยันส่งเจ้ามือรอบนี้ + ดาวน์โหลดไฟล์ Excel + ล็อกยอดไม่ให้ส่งซ้ำเรียบร้อย!');
}

/**
 * Helper to trigger browser file download with UTF-8 BOM
 */
function downloadBlobFile(content, fileName, mimeType) {
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

function buildCurrentRoundLayoffRows() {
  const mode = document.getElementById('layoffModeSelect')?.value || 'send_all_new';
  const selectedItems = (appState.aggregated || []).filter(
    a => selectedLayoffKeys.has(a.key) && a.hasNewPending
  );

  return selectedItems.map(item => {
    const newAmt = item.newPendingAmt || 0;
    const defaultSend = computeDefaultSendForNewPending(item, mode);
    const sendTotal =
      customLayoffAmounts[item.key] !== undefined
        ? Math.min(newAmt, Math.max(0, customLayoffAmounts[item.key]))
        : defaultSend;
    const keepTotal = Math.max(0, newAmt - sendTotal);

    let typeDesc = item.digitCount === 2 ? '2 ตัวบน' : '3 ตัวบน (ตรง)';
    if (item.threeStraightAmt > 0 && item.threeToadAmt > 0) {
      typeDesc = '3 ตัวบน+โต๊ด';
    }

    return {
      number: item.number,
      digitCount: item.digitCount,
      typeDesc,
      isRestricted: Boolean(item.isRestricted),
      payoutPercent: item.isRestricted ? (item.restrictedRule?.payoutPercent || 50) : 100,
      newPendingAmt: newAmt,
      sendTotal,
      keepTotal
    };
  });
}

/**
 * Exports formatted Microsoft Excel (.xls) file for sending to the dealer in the current round.
 * Preserves leading zeros (e.g. "072" stays "072") using mso-number-format:'\@'.
 */
function exportCurrentLayoffExcel() {
  const rows = buildCurrentRoundLayoffRows();
  if (rows.length === 0) {
    showToast('กรุณาติ๊กเลือกตัวเลขที่จะส่งเจ้ามือในรอบนี้ก่อนดาวน์โหลด Excel ครับ');
    return;
  }

  const s = appState.summary || {};
  const nextRound = s.nextLayoffRound || ((appState.layoffs || []).length + 1);
  const dealerName = document.getElementById('dealerNameInput')?.value || 'เจ้ามือสายใหญ่ #1';
  const drawTitle = appState.currentDraw?.title || 'งวดวันที่ 16/11';

  generateDealerLayoffExcelFile({
    roundNumber: nextRound,
    dealerName,
    drawTitle,
    createdAt: new Date().toISOString(),
    rows
  });
}

function exportSavedLayoffRoundExcel(layoffId) {
  const lf = (appState.layoffs || []).find(l => l.id === layoffId);
  if (!lf) return;
  const drawTitle = appState.currentDraw?.title || 'งวดวันที่ 16/11';

  generateDealerLayoffExcelFile({
    roundNumber: lf.roundNumber || 1,
    dealerName: lf.dealerName || 'เจ้ามือสายใหญ่',
    drawTitle,
    createdAt: lf.createdAt,
    rows: (lf.items || []).map(it => ({
      number: it.number,
      typeDesc: it.typeDesc || (String(it.number).length === 2 ? '2 ตัวบน' : '3 ตัวบน'),
      payoutPercent: it.payoutPercent || 100,
      sendTotal: Number(it.sendTotal) || 0,
      keepTotal: Number(it.keepTotal) || 0
    }))
  });
}

function generateDealerLayoffExcelFile({ roundNumber, dealerName, drawTitle, createdAt, rows }) {
  const rowsToSend = rows.filter(r => r.sendTotal > 0);
  const targetRows = rowsToSend.length > 0 ? rowsToSend : rows;
  const totalSend = targetRows.reduce((sum, r) => sum + (Number(r.sendTotal) || 0), 0);
  const totalKeep = targetRows.reduce((sum, r) => sum + (Number(r.keepTotal) || 0), 0);

  const tableRowsHtml = targetRows
    .map(
      (r, idx) => `
      <tr>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;">${idx + 1}</td>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;font-weight:bold;font-size:14pt;mso-number-format:'\\@';">${r.number}</td>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;">${r.typeDesc || ''}</td>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;color:${r.payoutPercent < 100 ? '#d97706' : '#059669'};">
          ${r.payoutPercent < 100 ? `เลขอั้น จ่าย ${r.payoutPercent}%` : 'จ่ายเต็ม 100%'}
        </td>
        <td style="text-align:right;border:1px solid #cbd5e1;padding:6px;font-weight:bold;font-size:13pt;background:#fef3c7;">${r.sendTotal}</td>
        <td style="text-align:right;border:1px solid #cbd5e1;padding:6px;color:#64748b;">${r.keepTotal || 0}</td>
      </tr>
    `
    )
    .join('');

  const html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="UTF-8">
      <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>ใบส่งเจ้ามือ รอบที่ ${roundNumber}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
    </head>
    <body style="font-family:'Tahoma',sans-serif;">
      <table style="border-collapse:collapse;width:100%;">
        <tr>
          <td colspan="6" style="font-size:16pt;font-weight:bold;background:#1e293b;color:#ffffff;padding:10px;text-align:center;">
            ใบตัดยอดส่งเจ้ามือ: ${escapeHtml(dealerName)} — รอบที่ ${roundNumber}
          </td>
        </tr>
        <tr>
          <td colspan="6" style="font-size:11pt;background:#f1f5f9;padding:8px;text-align:center;border:1px solid #cbd5e1;">
            ${escapeHtml(drawTitle)} | วัน-เวลาที่ทำรายการ: ${formatThaiDateTime(createdAt)} | จำนวน ${targetRows.length} รายการ
          </td>
        </tr>
        <tr style="background:#334155;color:#ffffff;font-weight:bold;">
          <th style="border:1px solid #cbd5e1;padding:8px;width:60px;">ลำดับ</th>
          <th style="border:1px solid #cbd5e1;padding:8px;width:110px;">ตัวเลข</th>
          <th style="border:1px solid #cbd5e1;padding:8px;width:140px;">ประเภท</th>
          <th style="border:1px solid #cbd5e1;padding:8px;width:140px;">เรทจ่าย</th>
          <th style="border:1px solid #cbd5e1;padding:8px;width:150px;">ยอดส่งเจ้ามือ (บาท)</th>
          <th style="border:1px solid #cbd5e1;padding:8px;width:150px;">เก็บไว้ที่เรา (บาท)</th>
        </tr>
        ${tableRowsHtml}
        <tr style="background:#1e293b;color:#ffffff;font-weight:bold;font-size:13pt;">
          <td colspan="4" style="text-align:right;border:1px solid #cbd5e1;padding:8px;">รวมยอดรอบที่ ${roundNumber} ทั้งสิ้น:</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#fbbf24;">${totalSend}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#6ee7b7;">${totalKeep}</td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const safeDealer = dealerName.replace(/[^\u0E00-\u0E7Fa-zA-Z0-9_-]/g, '_');
  const fileName = `ใบส่งเจ้ามือ_${safeDealer}_รอบที่_${roundNumber}.xls`;
  downloadBlobFile(html, fileName, 'application/vnd.ms-excel;charset=utf-8');
  showToast(`📊 ดาวน์โหลดไฟล์ Excel "${fileName}" เรียบร้อยแล้ว!`);
}

function exportCurrentLayoffCsv() {
  const rows = buildCurrentRoundLayoffRows();
  if (rows.length === 0) {
    showToast('กรุณาติ๊กเลือกตัวเลขที่จะส่งเจ้ามือในรอบนี้ก่อนดาวน์โหลด CSV ครับ');
    return;
  }
  const s = appState.summary || {};
  const nextRound = s.nextLayoffRound || ((appState.layoffs || []).length + 1);
  const dealerName = document.getElementById('dealerNameInput')?.value || 'เจ้ามือสายใหญ่ #1';

  const csvLines = [
    ['ลำดับ', 'ตัวเลข', 'ประเภท', 'เรทจ่าย', 'ยอดส่งเจ้ามือ (บาท)', 'เก็บไว้ที่เรา (บาท)'].join(',')
  ];

  let totalSend = 0;
  let totalKeep = 0;
  rows.forEach((r, idx) => {
    totalSend += r.sendTotal;
    totalKeep += r.keepTotal;
    // Use ="072" format so Excel preserves leading zeros in CSV
    csvLines.push(
      [
        idx + 1,
        `="${r.number}"`,
        `"${r.typeDesc}"`,
        `"${r.payoutPercent < 100 ? `เลขอั้น ${r.payoutPercent}%` : 'ปกติ 100%'}"`,
        r.sendTotal,
        r.keepTotal
      ].join(',')
    );
  });
  csvLines.push(['', 'รวมทั้งสิ้น', '', '', totalSend, totalKeep].join(','));

  const fileName = `ใบส่งเจ้ามือ_รอบที่_${nextRound}.csv`;
  downloadBlobFile(csvLines.join('\r\n'), fileName, 'text/csv;charset=utf-8');
  showToast(`📄 ดาวน์โหลดไฟล์ CSV "${fileName}" เรียบร้อยแล้ว!`);
}

function exportFullDrawSummaryExcel() {
  const list = appState.aggregated || [];
  if (list.length === 0) {
    showToast('ยังไม่มีข้อมูลตัวเลขในงวดนี้');
    return;
  }

  const drawTitle = appState.currentDraw?.title || 'งวดวันที่ 16/11';
  const totalAll = list.reduce((sum, a) => sum + (a.totalAmt || 0), 0);
  const total100 = list.reduce((sum, a) => sum + (a.fullPayout100Amt || 0), 0);
  const total50 = list.reduce((sum, a) => sum + (a.halfPayout50Amt || 0), 0);
  const totalSent = list.reduce((sum, a) => sum + (a.alreadySentAmt || 0), 0);
  const totalKept = list.reduce((sum, a) => sum + (a.alreadyKeptAmt || 0), 0);

  const rowsHtml = list
    .map((item, idx) => {
      const topAmt = item.digitCount === 2 ? item.twoTopAmt : item.threeStraightAmt;
      const secondAmt = item.digitCount === 2 ? item.twoBottomAmt : item.threeToadAmt + item.threePermRawAmt;
      const runners = Array.from(new Set(item.contributors.map(c => c.customerName))).join(', ');

      return `
        <tr>
          <td style="text-align:center;border:1px solid #cbd5e1;padding:5px;">${idx + 1}</td>
          <td style="text-align:center;border:1px solid #cbd5e1;padding:5px;font-weight:bold;font-size:13pt;mso-number-format:'\\@';">${item.number}</td>
          <td style="text-align:center;border:1px solid #cbd5e1;padding:5px;">${item.isRestricted ? 'เลขอั้น 50%' : 'ปกติ 100%'}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;">${topAmt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;">${secondAmt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;font-weight:bold;background:#fef3c7;">${item.totalAmt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#059669;">${item.fullPayout100Amt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#d97706;">${item.halfPayout50Amt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#2563eb;">${item.alreadySentAmt || 0}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#059669;">${item.alreadyKeptAmt || 0}</td>
          <td style="text-align:left;border:1px solid #cbd5e1;padding:5px;">${escapeHtml(runners)}</td>
        </tr>
      `;
    })
    .join('');

  const html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="UTF-8"></head>
    <body style="font-family:'Tahoma',sans-serif;">
      <table style="border-collapse:collapse;width:100%;">
        <tr>
          <td colspan="11" style="font-size:15pt;font-weight:bold;background:#1e293b;color:#ffffff;padding:10px;text-align:center;">
            สรุปยอดรวมเลขหวยทั้งหมด — ${escapeHtml(drawTitle)}
          </td>
        </tr>
        <tr style="background:#334155;color:#ffffff;font-weight:bold;">
          <th style="border:1px solid #cbd5e1;padding:6px;">ลำดับ</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เลข</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">สถานะ</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เต็ง/บน</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">โต๊ด/ล่าง</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ยอดรวมเงินเดียว</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ได้ 100% (ก่อนอั้น)</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ได้ 50% (หลังอั้น)</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ส่งเจ้ามือแล้ว</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เก็บไว้ที่เราแล้ว</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">สายเด็กโพย</th>
        </tr>
        ${rowsHtml}
        <tr style="background:#1e293b;color:#ffffff;font-weight:bold;">
          <td colspan="5" style="text-align:right;border:1px solid #cbd5e1;padding:8px;">รวมทั้งงวด:</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#fbbf24;">${totalAll}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#6ee7b7;">${total100}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#fdba74;">${total50}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#93c5fd;">${totalSent}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#6ee7b7;">${totalKept}</td>
          <td style="border:1px solid #cbd5e1;padding:8px;"></td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const fileName = `สรุปยอดรวมทั้งงวด_${drawTitle.replace(/\s+/g, '_')}.xls`;
  downloadBlobFile(html, fileName, 'application/vnd.ms-excel;charset=utf-8');
  showToast(`📊 ดาวน์โหลดไฟล์ Excel สรุปยอดรวมทั้งงวดเรียบร้อย!`);
}

async function undoLayoffRound(layoffId) {
  await fetch(`/api/layoffs/${encodeURIComponent(layoffId)}`, { method: 'DELETE' });
  await fetchAppState();
  showToast('🔄 ยกเลิกรอบการส่งเจ้ามือนั้นแล้ว ยอดกลับมารอจัดสรรใหม่');
}

// ============================================================================
// แท็บที่ 4: ตรวจบิล OCR เทียบรูปกระดาษ (แยกชื่อเด็กโพย & รอบวันเวลาชัดเจน)
// ============================================================================
function jumpToSlipInspector(slipId, col, row) {
  const allInspectableSlips = [...(appState.slips || []), ...(appState.trainingSlips || [])];
  const targetSlip = allInspectableSlips.find(s => s.id === slipId);
  if (targetSlip) {
    currentInspectorRunner = targetSlip.customerName;
  }
  currentInspectedSlipId = slipId;
  switchTab('tab-inspector');
  renderInspectorSelector();
  selectSlipForInspection(slipId, col, row);
}

function onInspectorRunnerChange(runnerName) {
  currentInspectorRunner = runnerName;
  currentLearnedRunnerFilter = runnerName;
  const allInspectableSlips = [...(appState.slips || []), ...(appState.trainingSlips || [])];
  const runnerSlips = allInspectableSlips.filter(s => s.customerName === runnerName);
  if (runnerSlips.length > 0) {
    currentInspectedSlipId = runnerSlips[0].id;
  }
  renderInspectorSelector();
  renderLearnedRules();
}

function renderInspectorSelector() {
  const sidebarEl = document.getElementById('inspectorSidebarList');
  const allInspectableSlips = [...(appState.slips || [])];

  if (!sidebarEl) return;
  if (allInspectableSlips.length === 0) {
    sidebarEl.innerHTML = `<div class="text-muted" style="padding:16px;text-align:center;">ไม่มีบิลในงวดนี้</div>`;
    return;
  }

  if (!currentInspectedSlipId || !allInspectableSlips.find(s => s.id === currentInspectedSlipId)) {
    currentInspectedSlipId = allInspectableSlips[0].id;
  }

  selectSlipForInspection(currentInspectedSlipId);
}

function renderSidebarListForInspector() {
  const sidebarEl = document.getElementById('inspectorSidebarList');
  if (!sidebarEl) return;
  const allInspectableSlips = [...(appState.slips || [])];

  const runnerGroups = new Map();
  for (const s of allInspectableSlips) {
    if (!runnerGroups.has(s.customerName)) {
      runnerGroups.set(s.customerName, []);
    }
    runnerGroups.get(s.customerName).push(s);
  }

  sidebarEl.innerHTML = Array.from(runnerGroups.entries())
    .map(([runnerName, list]) => {
      const totalRunnerMoney = list.reduce((sum, x) => sum + (x.totalMoney || 0), 0);
      const roundsHtml = list
        .map((s, idx) => {
          const rNum = s.roundNumber || idx + 1;
          const isCurrent = s.id === currentInspectedSlipId;
          const hasWarn = (s.reviewCount || 0) > 0;
          return `
            <div class="round-list-item ${isCurrent ? 'active' : ''}" onclick="selectSlipForInspection('${s.id}')">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <strong style="color:${isCurrent ? '#fde68a' : '#e2e8f0'};font-size:13px;">
                  📌 รอบที่ ${rNum}
                </strong>
                ${
                  hasWarn
                    ? `<span class="badge-50" style="padding:1px 7px;font-size:10.5px;">⚠️ รอเช็ค ${s.reviewCount} จุด</span>`
                    : `<span class="badge-100" style="padding:1px 7px;font-size:10.5px;">✅ ตรงแล้ว</span>`
                }
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;font-size:11.5px;">
                <span class="text-muted">${formatThaiDateTime(s.createdAt)} (${s.totalItems} รายการ)</span>
                <strong style="font-family:var(--font-mono);color:var(--gold);">${s.totalMoney.toLocaleString()} ฿</strong>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="runner-sidebar-group">
          <div class="runner-sidebar-header">
            <span>👤 ${runnerName}</span>
            <span style="font-family:var(--font-mono);font-size:12px;color:var(--gold);">${list.length} รอบ (${totalRunnerMoney.toLocaleString()}฿)</span>
          </div>
          <div>${roundsHtml}</div>
        </div>
      `;
    })
    .join('');
}

function selectSlipForInspection(slipId, highlightCol = null, highlightRow = null) {
  currentInspectedSlipId = slipId;
  const allInspectableSlips = [...(appState.slips || [])];
  const slip = allInspectableSlips.find(s => s.id === slipId);
  if (!slip) return;

  currentInspectorRunner = slip.customerName;
  const learnInput = document.getElementById('learnCustomerInput');
  if (learnInput) learnInput.value = slip.customerName;

  renderSidebarListForInspector();
  renderLearnedRules();

  const imgEl = document.getElementById('inspectorImage');
  imgEl.src = slip.imageUrl || '/uploads/slip-16-11-page1.jpg';
  document.getElementById('inspectorMetaText').textContent =
    `👤 ${slip.customerName} | 📌 รอบที่ ${slip.roundNumber || 1} (${formatThaiDateTime(slip.createdAt)}) | ยอดบิล: ${slip.totalMoney.toLocaleString()}฿`;

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

  const container = document.getElementById('paperGridContainer');
  const cols = [1, 2, 3, 4];

  container.innerHTML = cols
    .map(colNum => {
      const colItems = (slip.items || []).filter(i => (i.col || 1) === colNum);
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
        const rowClass =
          item.warnings && item.warnings.length > 0 ? 'row-warn' : isHighlighted ? 'row-warn' : '';

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
  await saveAndVerifyCurrentSlip(false);
}

async function saveAndVerifyCurrentSlip(markVerified = false) {
  const allInspectableSlips = [...(appState.slips || []), ...(appState.trainingSlips || [])];
  const slip = allInspectableSlips.find(s => s.id === currentInspectedSlipId);
  if (!slip) return;

  const numInputs = document.querySelectorAll('.cell-input[data-field="numText"]');
  const updatedMap = new Map();

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
        ? '✅ ยืนยันความถูกต้องของบิลรอบนี้ 100% และอัปเดตยอดรวมทั้งหมดแล้ว!'
        : '💾 บันทึกการแก้ไขและคำนวณยอดบิลใหม่เรียบร้อย'
    );
  }
}

function toggleLearnedMemoryPanel() {
  const panel = document.getElementById('learnedMemoryPanel');
  if (panel) panel.classList.toggle('hidden');
}

function jumpFromLearnedRule(customerName, roundNumber) {
  const allInspectableSlips = [...(appState.slips || []), ...(appState.trainingSlips || [])];
  const target =
    allInspectableSlips.find(s => s.customerName === customerName && (s.roundNumber || 1) === roundNumber) ||
    allInspectableSlips.find(s => s.customerName === customerName);
  if (target) {
    currentInspectorRunner = target.customerName;
    currentInspectedSlipId = target.id;
    renderInspectorSelector();
    showToast(`🔍 เปิดบิลของ "${target.customerName} — รอบที่ ${target.roundNumber || 1}" เรียบร้อย`);
  }
}
function setLearnedRunnerFilter(filterVal) {
  currentLearnedRunnerFilter = filterVal;
  renderLearnedRules();
}

function renderLearnedRules() {
  const allRules = appState.learnedRules || [];
  const activeRunner = currentInspectorRunner || 'ทุกสาย';

  // Filter chips by runner
  const chipsEl = document.getElementById('learnedRunnerFilterChips');
  const runnerNames = Array.from(new Set(allRules.map(r => r.customerName)));
  if (chipsEl) {
    chipsEl.innerHTML =
      `<button class="chip ${currentLearnedRunnerFilter === 'all' ? 'active' : ''}" onclick="setLearnedRunnerFilter('all')">ดูทุกสาย (${allRules.length})</button>` +
      runnerNames
        .map(name => {
          const cnt = allRules.filter(r => r.customerName === name).length;
          return `<button class="chip ${currentLearnedRunnerFilter === name ? 'active' : ''}" onclick="setLearnedRunnerFilter('${name}')">👤 ${name} (${cnt})</button>`;
        })
        .join('');
  }

  const rules =
    currentLearnedRunnerFilter === 'all'
      ? allRules
      : allRules.filter(r => r.customerName === currentLearnedRunnerFilter);

  const labelEl = document.getElementById('learnedActiveRunnerLabel');
  if (labelEl) {
    labelEl.textContent = currentLearnedRunnerFilter === 'all' ? 'รวมเด็กโพยทุกสาย' : currentLearnedRunnerFilter;
  }

  const countEl = document.getElementById('learnedRulesCountText');
  if (countEl) countEl.textContent = rules.length;

  const container = document.getElementById('learnedRulesListContainer');
  if (!container) return;

  if (rules.length === 0) {
    container.innerHTML = `<div class="text-muted">ยังไม่มีประวัติความจำลายมือของคนนี้</div>`;
    return;
  }

  container.innerHTML = rules
    .map(
      r => `
      <div class="contributor-item" style="padding:8px 12px;margin-bottom:6px;font-size:12.5px;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
          <span class="badge-100" style="cursor:pointer;" onclick="jumpFromLearnedRule('${r.customerName}', ${r.roundNumber || 1})">👤 ${r.customerName}</span>
          <span class="runner-rounds-badge" style="margin-left:0;cursor:pointer;" onclick="jumpFromLearnedRule('${r.customerName}', ${r.roundNumber || 1})" title="คลิกเพื่อเปิดดูบิลรอบนี้">
            📌 รอบที่ ${r.roundNumber || 1} • 📅 ${formatThaiDateTime(r.learnedAt)} (คลิกดูบิล ➔)
          </span>
          <span>
            ช่อง${r.field === 'amtText' ? 'ยอดเงิน' : 'ตัวเลข'}: หากเขียนคล้าย
            <code style="color:#f87171;font-weight:700;">${r.wrongText}</code>
            ➔ ให้แปลงเป็น
            <code style="color:#34d399;font-weight:700;">${r.correctText}</code>
          </span>
          <span class="text-muted">(${r.reason || ''})</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="removeLearnedRule('${r.id}')">ลบ</button>
      </div>
    `
    )
    .join('');
}

async function addManualLearnedRule() {
  const customerName = document.getElementById('learnCustomerInput').value.trim() || 'ทุกสาย (Global)';
  const field = document.getElementById('learnFieldSelect').value;
  const wrongText = document.getElementById('learnWrongInput').value.trim();
  const correctText = document.getElementById('learnCorrectInput').value.trim();

  if (!wrongText || !correctText) {
    showToast('กรุณาระบุทั้งลายมือที่มักอ่านเพี้ยน และค่าที่ถูกต้องจริงครับ');
    return;
  }

  await fetch('/api/learning', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add',
      customerName,
      field,
      wrongText,
      correctText,
      reason: 'แอดมินสอนเพิ่มด้วยตัวเอง'
    })
  });

  document.getElementById('learnWrongInput').value = '';
  document.getElementById('learnCorrectInput').value = '';
  await fetchAppState();
  showToast(`🧠 บันทึกเข้าสมอง AI เรียบร้อย: "${wrongText}" ➔ "${correctText}" (${customerName})`);
}

async function removeLearnedRule(id) {
  await fetch('/api/learning', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', id })
  });
  await fetchAppState();
  showToast('ลบกฎความจำลายมือเรียบร้อย');
}

function toggleGridOverlay() {
  document.getElementById('gridOverlay4x30').classList.toggle('hidden');
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
// แท็บที่ 5: ส่งโพยเข้าระบบ / จำลองแชท LINE OA
// ============================================================================
function onSimCustomerChange() {
  document.getElementById('simCustomCustomerInput').value = '';
}

function getSimCustomerName() {
  const custom = document.getElementById('simCustomCustomerInput').value.trim();
  return custom || document.getElementById('simCustomerSelect').value;
}

function getSimSubmittedAt(selectId) {
  const mode = document.getElementById(selectId)?.value || 'after_cutoff';
  if (mode === 'before_cutoff') {
    return '2026-11-14T11:00:00.000Z'; // ส่งวันที่ 14 พ.ย. (ก่อนเวลาเจ้ามือประกาศอั้น 15 พ.ย.)
  }
  return new Date().toISOString();
}

function fillLinePreset(text) {
  document.getElementById('lineMessageInput').value = text;
}

function renderLineSimulator() {
  const stream = document.getElementById('lineChatStream');
  if (!stream) return;
  const chats = appState.lineChats || [];

  stream.innerHTML = chats
    .map(msg => {
      const isCustomer = msg.sender === 'customer';
      return `
        <div class="chat-bubble-wrap ${isCustomer ? 'customer' : 'bot'}">
          <div class="chat-sender-name">${isCustomer ? `👤 ${msg.customerName} (${formatThaiDateTime(msg.timestamp)})` : '🤖 ระบบตอบรับโพยอัตโนมัติ'}</div>
          <div class="chat-bubble">${escapeHtml(msg.text || '')}${
        msg.imageUrl ? `<br/><img src="${msg.imageUrl}" class="chat-thumb" alt="รูปโพย" />` : ''
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
  const submittedAt = getSimSubmittedAt('simTimingSelect');
  textEl.value = '';

  await fetch('/api/line/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drawId: appState.currentDrawId,
      customerName,
      text,
      submittedAt
    })
  });

  await fetchAppState();
  showToast(`💬 บันทึกบิลของ "${customerName}" เข้าสู่ ${appState.currentDraw?.title || 'งวดนี้'} เรียบร้อย!`);
}

async function simulateLineSamplePhoto() {
  const customerName = getSimCustomerName();
  const submittedAt = getSimSubmittedAt('simTimingSelect');
  showToast(`📸 กำลังส่งรูปโพย 16/11 (120 แถว) เข้า LINE ในนาม "${customerName}"...`);

  await fetch('/api/line/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drawId: appState.currentDrawId,
      customerName,
      useSamplePhoto: true,
      submittedAt,
      text: 'ส่งรูปโพยกระดาษ 16/11 (120 รายการ)'
    })
  });

  await fetchAppState();
  showToast(`✅ อ่านรูปโพยของ "${customerName}" และรวมยอดเข้าตารางเรียบร้อย!`);
}

async function sendLineCustomPhoto(inputEl) {
  const file = inputEl.files?.[0];
  if (!file) return;
  const customerName = getSimCustomerName();
  const submittedAt = getSimSubmittedAt('simTimingSelect');
  const base64Image = await fileToBase64(file);

  showToast(`📸 กำลังอ่านรูปโพยจาก LINE ของ "${customerName}"...`);
  await fetch('/api/line/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drawId: appState.currentDrawId,
      customerName,
      base64Image,
      submittedAt,
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

async function sliceImageInto4Columns(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const slices = [];
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
  showToast('✂️ ตัดแบ่งภาพเป็น 4 คอลัมน์อัตโนมัติพร้อมส่งให้ AI แล้ว');
}

async function runDirectOcrUpload() {
  const btn = document.getElementById('btnRunOcr');
  const customerName = document.getElementById('uploadCustomerName').value.trim() || 'ลูกค้าทั่วไป';
  const title = document.getElementById('uploadSlipTitle').value.trim() || `โพยกระดาษ - ${customerName}`;
  const timingMode = document.getElementById('uploadTimingSelect')?.value || 'after_cutoff';
  const isTrainingOnly = timingMode === 'training_only';
  const submittedAt = getSimSubmittedAt('uploadTimingSelect');

  btn.disabled = true;
  btn.textContent = isTrainingOnly
    ? '🧠 กำลังอ่านโพยเก่าเพื่อฝึกสอนลายมือให้ AI (ไม่คิดเงินรวมในงวดปัจจุบัน)...'
    : '⏳ กำลังอ่านลายมือด้วย AI + ตรวจสอบกฎคณิตศาสตร์ 4 ชั้น...';

  try {
    const res = await fetch('/api/slips/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        drawId: appState.currentDrawId,
        customerName,
        title,
        submittedAt,
        isTrainingOnly,
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
      showToast(
        isTrainingOnly
          ? `🧠 โหลดโพยเก่าเข้าโหมดฝึกสอนสำเร็จ! แก้ไขตัวเลขที่เพี้ยนในตารางเพื่อให้ AI จำลายมือได้เลย (ไม่รวมในยอดเงินงวดปัจจุบัน)`
          : `✅ อ่านโพยสำเร็จ (${data.slip.totalItems} รายการ รวม ${data.slip.totalMoney.toLocaleString()} บาท)`
      );
    }
  } catch (err) {
    showToast(`❌ เกิดข้อผิดพลาด: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 เริ่มอ่านลายมือในโพยด้วย AI (Gemini 2.5 Pro)';
  }
}

// ============================================================================
// แท็บที่ 6: ตั้งค่าระบบ (แยกหมวดย่อย 5 หมวด) & พิมพ์กระดาษโพย 4×30
// ============================================================================
function switchSettingsSubTab(subTabId) {
  document.querySelectorAll('.settings-subpanel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.settings-subbtn').forEach(b => b.classList.remove('active'));

  const target = document.getElementById(subTabId);
  if (target) target.classList.add('active');

  const btn = document.querySelector(`.settings-subbtn[data-subtab="${subTabId}"]`);
  if (btn) btn.classList.add('active');

  const sheet = document.getElementById('printableSheet');
  if (sheet) {
    sheet.classList.toggle('show-preview', subTabId === 'sub-print');
  }
}

async function copyWebhookUrl() {
  const el = document.getElementById('webhookUrlDisplay');
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.value);
    showToast('📋 คัดลอกลิงก์ Webhook URL ลง Clipboard แล้ว');
  } catch {
    showToast('คัดลอกลิงก์เรียบร้อย');
  }
}

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
  selectedCustomerFilter = null;
  await fetchAppState();
  showToast('🔄 รีเซ็ตข้อมูลตัวอย่างเริ่มต้นเรียบร้อยแล้ว');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
