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
let aggSortCol = 'total';
let aggSortDir = 'desc';
let selectedCustomerFilter = null; // กรองดูเฉพาะเด็กโพยที่คลิกเลือก (รวมทุกรอบของคนนั้น)
let selectedSlipRoundFilter = null; // กรองดูเฉพาะบิล/รอบที่คลิกเลือก (เฉพาะรอบนั้นใบเดียว)
let expandedRunnerCards = new Set(); // เก็บรายชื่อเด็กโพยที่กดกางดูรายการแต่ละรอบ
let expandedPermDropdownKeys = new Set(); // เก็บรายการเลขที่กดกาง Dropdown ดูประตูชุดกลับ (×6 / ×3)
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

// Theme & User Authentication State
let currentTheme = localStorage.getItem('lotto_theme_v2') || 'light';
let currentUser = null;

// Wrap window.fetch to automatically inject actorName into JSON POST/PUT requests for Audit Logging
const _origFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  if (init && init.body && typeof init.body === 'string') {
    try {
      const parsed = JSON.parse(init.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.actorName && currentUser) {
        parsed.actorName = currentUser.displayName || currentUser.username;
        init = { ...init, body: JSON.stringify(parsed) };
      }
    } catch {}
  }
  return _origFetch(input, init);
};

function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  localStorage.setItem('lotto_theme_v2', currentTheme);
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    btn.textContent = currentTheme === 'light' ? '🌙 โหมดมืด' : '☀️ โหมดสว่าง';
  }
}

function toggleThemeMode() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  showToast(next === 'light' ? '☀️ สลับเป็นโหมดสว่าง (Light Mode)' : '🌙 สลับเป็นโหมดมืด (Dark Mode)');
}

function updateCurrentUserUi() {
  const el = document.getElementById('currentUserDisplayName');
  if (el) {
    el.textContent = currentUser?.displayName || currentUser?.username || '-';
  }
}

function showAuthenticatedApp(user) {
  currentUser = user;
  if (user) {
    localStorage.setItem('lotto_user', JSON.stringify(user));
  }
  updateCurrentUserUi();
  document.getElementById('loginOverlay')?.classList.add('hidden');
  document.getElementById('appShell')?.classList.remove('hidden');
  const webhookEl = document.getElementById('webhookUrlDisplay');
  if (webhookEl) webhookEl.value = `${window.location.origin}/api/line/webhook`;
}

function showStealthLogin() {
  const wasAppVisible = !document.getElementById('appShell')?.classList.contains('hidden');
  if (antigravityQueuePollTimer) {
    clearTimeout(antigravityQueuePollTimer);
    antigravityQueuePollTimer = null;
  }
  currentUser = null;
  localStorage.removeItem('lotto_user');
  if (wasAppVisible) {
    window.location.replace('/');
    return;
  }
  updateCurrentUserUi();
  const pEl = document.getElementById('loginPasswordInput');
  if (pEl) pEl.value = '';
  document.getElementById('appShell')?.classList.add('hidden');
  document.getElementById('btnCloseLoginModal')?.classList.add('hidden');
  document.getElementById('loginOverlay')?.classList.remove('hidden');
}

async function readApiError(res, fallbackMsg) {
  try {
    const data = await res.json();
    return data?.error || fallbackMsg;
  } catch {
    return fallbackMsg;
  }
}

function openLoginModal(prefillUsername = '') {
  const overlay = document.getElementById('loginOverlay');
  if (!overlay) return;
  const closeBtn = document.getElementById('btnCloseLoginModal');
  if (closeBtn) {
    closeBtn.classList.toggle('hidden', !currentUser);
  }
  const uEl = document.getElementById('loginUsernameInput');
  const pEl = document.getElementById('loginPasswordInput');
  if (prefillUsername && uEl) {
    uEl.value = prefillUsername;
  }
  if (pEl) pEl.value = '';
  overlay.classList.remove('hidden');
  if (prefillUsername && pEl) {
    pEl.focus();
  }
}

function closeLoginModal() {
  if (!currentUser) return;
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.classList.add('hidden');
}

async function checkAuthAndBoot() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (res.ok && data.ok && data.authenticated && data.user) {
      showAuthenticatedApp(data.user);
      await fetchAppState();
      return;
    }
  } catch {}
  showStealthLogin();
}

async function submitLogin() {
  const username = (document.getElementById('loginUsernameInput')?.value || '').trim();
  const password = (document.getElementById('loginPasswordInput')?.value || '').trim();
  if (!username || !password) {
    showToast('กรุณากรอก Username และ Password');
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showToast(`❌ ${data.error || 'เข้าสู่ระบบไม่สำเร็จ'}`);
      return;
    }

    const pEl = document.getElementById('loginPasswordInput');
    if (pEl) pEl.value = '';
    showAuthenticatedApp(data.user);
    await fetchAppState();
    showToast(`🔐 เข้าสู่ระบบในนาม "${data.user.displayName}" เรียบร้อย`);
  } catch (err) {
    showToast(`❌ เกิดข้อผิดพลาดในการเข้าสู่ระบบ: ${err.message}`);
  }
}

async function logoutSession() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  localStorage.removeItem('lotto_user');
  window.location.replace('/');
}

async function logCustomAuditEvent(actionType, detail) {
  try {
    await fetch('/api/audit-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionType, detail })
    });
  } catch {}
}

document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(currentTheme);
  buildPrintable4x30Template();
  initPhotoViewportDragPan();
  await checkAuthAndBoot();
});

function initPhotoViewportDragPan() {
  const viewport = document.getElementById('photoViewport');
  if (!viewport) return;

  let isDown = false;
  let startX = 0;
  let startY = 0;
  let scrollLeft = 0;
  let scrollTop = 0;

  viewport.addEventListener('mousedown', e => {
    // Allow clicking issue boxes
    if (e.target.closest('.photo-issue-box')) return;
    isDown = true;
    viewport.classList.add('is-dragging');
    startX = e.pageX - viewport.offsetLeft;
    startY = e.pageY - viewport.offsetTop;
    scrollLeft = viewport.scrollLeft;
    scrollTop = viewport.scrollTop;
  });

  viewport.addEventListener('mouseleave', () => {
    isDown = false;
    viewport.classList.remove('is-dragging');
  });

  viewport.addEventListener('mouseup', () => {
    isDown = false;
    viewport.classList.remove('is-dragging');
  });

  viewport.addEventListener('mousemove', e => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - viewport.offsetLeft;
    const y = e.pageY - viewport.offsetTop;
    const walkX = (x - startX) * 1.25;
    const walkY = (y - startY) * 1.25;
    viewport.scrollLeft = scrollLeft - walkX;
    viewport.scrollTop = scrollTop - walkY;
  });
}

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

function toggleSidebarCollapse() {
  const shell = document.getElementById('appShell');
  if (!shell) return;
  shell.classList.toggle('sidebar-collapsed');
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));

  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');

  const btn = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');
}

let antigravityQueuePollTimer = null;

async function fetchAppState(drawIdParam = '') {
  const url = drawIdParam ? `/api/state?drawId=${encodeURIComponent(drawIdParam)}` : '/api/state';
  const res = await fetch(url);
  if (res.status === 401) {
    showStealthLogin();
    return;
  }
  if (!res.ok) return;
  appState = await res.json();

  renderHeaderAndKpis();
  renderCustomersInDraw();
  renderAggregatedTable();
  renderRestrictedNumbersTab();
  renderLayoffBuilder();
  renderInspectorSelector();
  renderLearnedRules();
  renderLineSimulator();
  renderWinnersTab();
  populateSettingsForm();
  renderUsersAndAuditLogs();

  // If any slip is waiting in queue for Antigravity Agent OCR, poll every 4 seconds automatically
  const hasPendingAg = [...(appState.slips || []), ...(appState.trainingSlips || [])].some(
    s => s.status === 'pending_antigravity'
  );
  if (antigravityQueuePollTimer) {
    clearTimeout(antigravityQueuePollTimer);
    antigravityQueuePollTimer = null;
  }
  if (hasPendingAg) {
    antigravityQueuePollTimer = setTimeout(() => {
      fetchAppState(appState.currentDrawId);
    }, 4000);
  }
}

async function onSwitchDraw(drawId) {
  selectedCustomerFilter = null;
  selectedSlipRoundFilter = null;
  selectedAggNumberKey = null;
  selectedLayoffKeys.clear();
  customLayoffAmounts = {};
  currentInspectedSlipId = null;
  currentInspectorRunner = '';
  await fetch('/api/draws', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'switch', drawId })
  });
  await fetchAppState(drawId);
  showToast(`📅 สลับไปยัง "${appState.currentDraw?.title || ''}" เรียบร้อย`);
}

function openNewDrawModal() {
  const modal = document.getElementById('newDrawModalOverlay');
  const listEl = document.getElementById('upcomingGloDrawsList');
  if (!modal || !listEl) return;

  const upcoming = appState.upcomingGloDraws || [];
  listEl.innerHTML = upcoming
    .map(u => {
      return `
        <div class="contributor-item" style="margin-bottom:0;border-color:${u.isShifted ? 'var(--primary-border)' : 'var(--border)'};background:${u.isShifted ? 'var(--primary-soft)' : 'var(--bg-elevated)'};">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <strong style="font-size:15px;color:${u.isShifted ? 'var(--primary)' : 'var(--text-main)'};">📅 ${escapeHtml(u.title)}</strong>
              ${
                u.isShifted
                  ? `<span class="badge-50">${escapeHtml(u.shiftReason)}</span>`
                  : `<span class="badge-100">🟢 ออกตามวันปกติ</span>`
              }
            </div>
            <div class="text-muted" style="font-size:11.5px;margin-top:2px;">รหัสวันที่กองสลาก: ${escapeHtml(u.drawDate)}</div>
          </div>
          <div>
            ${
              u.alreadyCreated
                ? `<span class="badge-100">เปิดงวดนี้ไว้แล้ว</span>`
                : `<button class="btn btn-primary btn-sm" onclick="createDrawFromSchedule('${escapeJsArg(u.title)}', '${escapeJsArg(u.drawDate)}')">+ เปิดรับโพยงวดนี้</button>`
            }
          </div>
        </div>
      `;
    })
    .join('');

  modal.classList.remove('hidden');
}

function closeNewDrawModal() {
  document.getElementById('newDrawModalOverlay')?.classList.add('hidden');
}

async function createDrawFromSchedule(title, drawDate) {
  const res = await fetch('/api/draws', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, drawDate })
  });
  if (res.ok) {
    closeNewDrawModal();
    selectedCustomerFilter = null;
    selectedAggNumberKey = null;
    await fetchAppState();
    showToast(`✅ เปิด "${title}" ตามปฏิทินกองสลากเรียบร้อยแล้ว!`);
  }
}

async function createCustomNewDraw() {
  const title = document.getElementById('customNewDrawTitleInput')?.value.trim();
  const drawDate = document.getElementById('customNewDrawDateInput')?.value || '';
  if (!title) {
    showToast('กรุณาระบุชื่องวดหวยก่อนครับ');
    return;
  }
  await createDrawFromSchedule(title, drawDate);
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

  const modelBadge = document.getElementById('headerModelBadge');
  if (modelBadge) modelBadge.textContent = settings.geminiModel || 'gemini-2.5-pro';
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
  document.getElementById('btnModeExpand')?.classList.toggle('active', isExpand);
  document.getElementById('btnModeRaw')?.classList.toggle('active', !isExpand);

  const subtitle = document.getElementById('aggModeSubtitle');
  if (subtitle) {
    subtitle.innerHTML = isExpand
      ? 'แสดงตัวเลขตามหน้าโพยจริง • เลขที่มีชุดกลับ (<code>×6</code> หรือ <code>×3</code>) สามารถกดปุ่ม <strong>"🔀 ดูประตูเฉลี่ย ▼"</strong> เพื่อกางดูทุกประตูพร้อมราคาเฉลี่ยได้ทันที'
      : 'แสดงตัวเลขคงตามหน้าโพยจริง (ไม่แยกหางชุดกลับ ×6 / ×3)';
  }

  renderAntigravityStatusUi();
}

function renderAntigravityStatusUi() {
  const ag = appState.antigravityStatus || {
    online: false,
    lastSeenAt: null,
    priorityMode: appState.settings?.ocrPriorityMode || 'auto_hybrid',
    hasApiKey: Boolean((appState.settings?.geminiApiKey || '').trim()),
    pendingQueueCount: 0
  };

  const pillEl = document.getElementById('antigravityStatusSidebarPill');
  if (pillEl) {
    if (ag.online) {
      pillEl.style.borderColor = 'rgba(16,185,129,0.35)';
      pillEl.style.background = 'var(--success-soft)';
      pillEl.style.color = 'var(--success)';
      pillEl.innerHTML = `<span>🟢 Antigravity: ออนไลน์ (Priority #1)</span>${ag.pendingQueueCount > 0 ? `<span class="badge-50" style="font-size:10px;padding:1px 5px;">คิว ${ag.pendingQueueCount}</span>` : ''}`;
    } else if (ag.hasApiKey) {
      pillEl.style.borderColor = 'rgba(37,99,235,0.35)';
      pillEl.style.background = 'var(--info-soft)';
      pillEl.style.color = 'var(--info)';
      pillEl.innerHTML = `<span>🔵 Antigravity ออฟไลน์ (ใช้ API Key 24 ชม.)</span>`;
    } else {
      pillEl.style.borderColor = 'var(--border)';
      pillEl.style.background = 'var(--bg-input)';
      pillEl.style.color = 'var(--text-muted)';
      pillEl.innerHTML = `<span>⚪ Antigravity ออฟไลน์ (โหมดจำลอง / รอใส่ API Key)</span>`;
    }
  }

  const bannerEl = document.getElementById('antigravityStatusBanner');
  if (bannerEl) {
    const modeLabel =
      ag.priorityMode === 'antigravity_only'
        ? '🤖 บังคับใช้ Antigravity Agent เท่านั้น'
        : ag.priorityMode === 'api_only'
          ? '🔑 บังคับใช้ Gemini API Key เสมอ'
          : '⚡ โหมดผสมอัตโนมัติ (Antigravity Priority #1 ➔ API Key Fallback)';
    const lastSeenStr = ag.lastSeenAt ? formatThaiDateTime(ag.lastSeenAt) : 'ยังไม่มีประวัติเชื่อมต่อ';

    if (ag.online) {
      bannerEl.style.borderColor = 'rgba(16,185,129,0.35)';
      bannerEl.style.background = 'var(--success-soft)';
      bannerEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="font-weight:700;color:var(--success);font-size:13.5px;">🟢 Antigravity: ออนไลน์ (Priority #1) — พร้อมอ่านโพยโดยตรง ไม่เสียโควต้า API Key!</div>
            <div class="text-muted" style="font-size:11.5px;margin-top:2px;">โหมดที่เลือก: <strong>${modeLabel}</strong> • ซิงค์ล่าสุด: ${lastSeenStr}</div>
          </div>
          <span class="badge-100">คิวรออ่าน: ${ag.pendingQueueCount || 0} ใบ</span>
        </div>
      `;
    } else if (ag.hasApiKey) {
      bannerEl.style.borderColor = 'rgba(37,99,235,0.35)';
      bannerEl.style.background = 'var(--info-soft)';
      bannerEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="font-weight:700;color:var(--info);font-size:13.5px;">🔵 Antigravity ออฟไลน์ (ใช้ API Key 24 ชม.) — ระบบสลับใช้ Gemini API Key บนเซิร์ฟเวอร์อัตโนมัติ</div>
            <div class="text-muted" style="font-size:11.5px;margin-top:2px;">โหมดที่เลือก: <strong>${modeLabel}</strong> • Antigravity ออนไลน์ล่าสุด: ${lastSeenStr}</div>
          </div>
          <span class="badge-ai">พร้อมทำงาน 24 ชม.</span>
        </div>
      `;
    } else {
      bannerEl.style.borderColor = 'var(--primary-border)';
      bannerEl.style.background = 'var(--primary-soft)';
      bannerEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="font-weight:700;color:var(--primary);font-size:13.5px;">⚪ Antigravity ออฟไลน์ (โหมดจำลอง / รอใส่ API Key)</div>
            <div class="text-muted" style="font-size:11.5px;margin-top:2px;">โหมดที่เลือก: <strong>${modeLabel}</strong> • หากต้องการให้อ่านโพยจริงตอนปิด Antigravity กรุณาใส่ Gemini API Key ด้านล่าง</div>
          </div>
          <span class="badge-50">คิวรออ่าน: ${ag.pendingQueueCount || 0} ใบ</span>
        </div>
      `;
    }
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
              onclick="event.stopPropagation(); filterBySingleRound('${escapeJsArg(c.customerName)}', '${escapeJsArg(sl.id)}', ${rNum})">
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;color:var(--primary);word-break:break-word;">
                  📌 รอบที่ ${rNum}: <span style="color:var(--text-main);font-weight:600;">${escapeHtml(sl.title.replace(/^รอบที่ \d+ — /, ''))}</span>
                </div>
                <div class="text-muted">ส่งเมื่อ: ${formatThaiDateTime(sl.createdAt)} (${sl.totalItems} รายการ)</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
                  ${
                    has50
                      ? `<span class="badge-50">🔒 ติดอั้น 50% (${sl.restrictedHits.join(', ')}) = ${sl.half50Money.toLocaleString()}฿</span>`
                      : `<span class="badge-100">🟢 ส่งก่อนอั้น จ่ายเต็ม 100%</span>`
                  }
                  ${
                    sl.status === 'pending_antigravity'
                      ? `<span class="badge-ai" title="อยู่ในคิวรอ Antigravity Agent อ่านลายมือ">⏳ รอ Antigravity อ่าน...</span>`
                      : (sl.reviewCount || 0) > 0
                        ? `<span class="badge-50" title="AI พบจุดที่ควรตรวจสอบเทียบกับรูปกระดาษ">⚠️ รอเช็ค ${sl.reviewCount} จุด</span>`
                        : sl.humanApproved
                          ? `<span class="badge-100" title="คนตรวจและกดยืนยันแล้วโดย ${escapeHtml(sl.approvedBy || 'แอดมิน')}">✅ คนยืนยันแล้ว</span>`
                          : `<span class="badge-ai" title="AI อ่านและตรวจกฎคณิตศาสตร์ผ่านอัตโนมัติ (รอคนกดปุ่มยืนยัน)">🤖 AI อ่านผ่าน</span>`
                  }
                </div>
              </div>
              <div style="flex-shrink:0;text-align:right;">
                <div style="font-family:var(--font-mono);font-weight:700;color:var(--text-main);white-space:nowrap;">${sl.totalMoney.toLocaleString()} ฿</div>
                <button type="button" class="btn btn-outline btn-sm" style="margin-top:4px;padding:2px 7px;font-size:11px;white-space:nowrap;"
                  onclick="event.stopPropagation(); jumpToSlipInspector('${sl.id}', 1, 1)">
                  🔍 ตรวจใบนี้
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="customer-card ${isActive ? 'active-customer' : ''}" onclick="filterByCustomer('${escapeJsArg(c.customerName)}')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13.5px;font-weight:700;color:var(--text-main);display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
                <span>👤 ${escapeHtml(c.customerName)}</span>
                <span class="runner-rounds-badge">ส่งแล้ว ${c.slipCount} รอบ</span>
              </div>
              <div class="text-muted" style="margin-top:2px;font-size:11px;">
                รวมทุกรอบ: <strong>${c.totalItems} รายการ</strong> • ล่าสุด: ${formatThaiDateTime(c.latestAt)}
              </div>
            </div>
            <div style="flex-shrink:0;text-align:right;">
              <div style="font-size:10px;color:var(--text-muted);white-space:nowrap;">ยอดรวม ${c.slipCount} รอบ</div>
              <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:var(--text-main);white-space:nowrap;">
                ${c.totalMoney.toLocaleString()} ฿
              </div>
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:5px;font-size:11px;">
            <span class="badge-100" style="padding:2px 8px;font-size:11px;">🟢 ได้ 100%: ${c.full100Money.toLocaleString()} ฿</span>
            ${
              c.half50Money > 0
                ? `<span class="badge-50" style="padding:2px 8px;font-size:11px;">🔒 ติดอั้น 50%: ${c.half50Money.toLocaleString()} ฿</span>`
                : ''
            }
          </div>

          <div class="runner-actions-bar" onclick="event.stopPropagation()">
            <button type="button" class="btn ${isActive && !selectedSlipRoundFilter ? 'btn-primary' : 'btn-outline'} btn-sm" style="flex:1;padding:3px 7px;font-size:11.5px;"
              onclick="filterByCustomer('${escapeJsArg(c.customerName)}')">
              📊 ${isActive && !selectedSlipRoundFilter ? 'กำลังดูยอดรวมคนนี้' : `ดูรวมทั้ง ${c.slipCount} รอบ`}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" style="padding:3px 7px;font-size:11.5px;"
              onclick="toggleRunnerRoundsDrawer('${escapeJsArg(c.customerName)}')">
              📂 ${isExpanded ? 'พับ ▲' : `ทีละรอบ (${c.slipCount}) ▼`}
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
function togglePermDropdown(key) {
  if (expandedPermDropdownKeys.has(key)) {
    expandedPermDropdownKeys.delete(key);
  } else {
    expandedPermDropdownKeys.add(key);
  }
  renderAggregatedTable();
}

function setAggFilter(filter, btnEl) {
  currentAggFilter = filter;
  document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
  const targetChip = btnEl || document.querySelector(`.filter-chips .chip[data-filter="${filter}"]`);
  if (targetChip) targetChip.classList.add('active');
  renderAggregatedTable();
}

function toggleAggColumnSort(col) {
  if (aggSortCol === col) {
    aggSortDir = aggSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    aggSortCol = col;
    aggSortDir = col === 'number' ? 'asc' : 'desc';
  }

  const sortSelect = document.getElementById('sortAggSelect');
  if (sortSelect) {
    const presetKey = `${aggSortCol}_${aggSortDir}`;
    if (['total_desc', 'kept_desc', 'sent_desc', 'number_asc'].includes(presetKey)) {
      sortSelect.value = presetKey;
    }
  }
  renderAggregatedTable();
}

function onAggSortDropdownChange(val) {
  if (val === 'kept_desc') {
    aggSortCol = 'kept';
    aggSortDir = 'desc';
  } else if (val === 'sent_desc') {
    aggSortCol = 'sent';
    aggSortDir = 'desc';
  } else if (val === 'number_asc') {
    aggSortCol = 'number';
    aggSortDir = 'asc';
  } else {
    aggSortCol = 'total';
    aggSortDir = 'desc';
  }
  renderAggregatedTable();
}

function updateAggSortHeaderIndicators() {
  document.querySelectorAll('#tab-dashboard th.sortable-th[data-sort-col]').forEach(th => {
    const col = th.getAttribute('data-sort-col');
    const ind = th.querySelector('.sort-indicator');
    const isActive = col === aggSortCol;
    th.classList.toggle('sort-active', isActive);
    if (ind) {
      ind.textContent = isActive ? (aggSortDir === 'asc' ? '▲' : '▼') : '⇅';
    }
  });
}

function renderAggregatedTable() {
  const tbody = document.getElementById('aggTableBody');
  const search = (document.getElementById('searchNumberInput')?.value || '').trim();
  const titleEl = document.getElementById('aggTableTitle');
  updateAggSortHeaderIndicators();

  if (selectedSlipRoundFilter) {
    const slipObj = (appState.slips || []).find(s => s.id === selectedSlipRoundFilter);
    titleEl.innerHTML = `📄 2. กำลังดูเฉพาะ: <span style="color:var(--primary);">${escapeHtml(selectedCustomerFilter)} — รอบที่ ${slipObj?.roundNumber || ''} (${(slipObj?.totalMoney || 0).toLocaleString()}฿)</span> <button class="btn btn-outline btn-sm" style="margin-left:8px;" onclick="filterByCustomer('${escapeJsArg(selectedCustomerFilter)}')">📊 ดูรวมทุกรอบของคนนี้</button> <button class="btn btn-ghost btn-sm" onclick="filterByCustomer(null)">🌐 ดูรวมทุกคน</button>`;
  } else if (selectedCustomerFilter) {
    const custObj = (appState.customersInDraw || []).find(c => c.customerName === selectedCustomerFilter);
    titleEl.innerHTML = `👤 2. ยอดรวมทุกรอบของ: <span style="color:var(--primary);">${escapeHtml(selectedCustomerFilter)} (รวม ${custObj?.slipCount || 1} รอบ = ${(custObj?.totalMoney || 0).toLocaleString()}฿)</span> <button class="btn btn-ghost btn-sm" style="margin-left:8px;" onclick="filterByCustomer(null)">🌐 กลับไปดูรวมทุกคนทั้งงวด</button>`;
  } else {
    titleEl.textContent = `📊 2. สรุปยอดรวมแต่ละเลขในงวดนี้ (รวมเด็กโพยทุกคน ทุกรอบ เป็นยอดเงินเดียว)`;
  }

  const allAgg = (appState.aggregated || []).map(a => {
    const sent = a.alreadySentAmt || 0;
    const netKept = Math.max(0, (a.totalAmt || 0) - sent);
    return {
      ...a,
      netKeptAmt: netKept
    };
  });
  const keptItems = allAgg.filter(a => a.netKeptAmt > 0).sort((a, b) => b.netKeptAmt - a.netKeptAmt);
  const sentItems = allAgg.filter(a => (a.alreadySentAmt || 0) > 0).sort((a, b) => b.alreadySentAmt - a.alreadySentAmt);

  const totalKeptAmt = keptItems.reduce((sum, a) => sum + a.netKeptAmt, 0);
  const totalSentAmt = sentItems.reduce((sum, a) => sum + (a.alreadySentAmt || 0), 0);
  const layoffRoundCount = (appState.layoffs || []).length;

  // อัปเดตตัวเลขบนปุ่ม Filter Chips
  const chipAllEl = document.getElementById('chipCountAll');
  const chipSentEl = document.getElementById('chipCountSent');
  const chipKeptEl = document.getElementById('chipCountKept');
  if (chipAllEl) chipAllEl.textContent = `(${allAgg.length})`;
  if (chipSentEl) chipSentEl.textContent = `(${sentItems.length})`;
  if (chipKeptEl) chipKeptEl.textContent = `(${keptItems.length})`;

  // แถบสรุปสถานะจัดสรรของงวดนี้ (เก็บไว้เองอัตโนมัติ vs ตัดส่งเจ้ามือแล้ว)
  const allocBar = document.getElementById('drawAllocationSummaryBar');
  if (allocBar) {
    const topKeptBadges = keptItems
      .slice(0, 5)
      .map(a => `<span class="alloc-mini-pill" onclick="event.stopPropagation(); inspectAggNumber('${a.key}')"><strong>${a.number}</strong> (${a.netKeptAmt.toLocaleString()}฿)</span>`)
      .join('');
    const topSentBadges = sentItems
      .slice(0, 5)
      .map(a => `<span class="alloc-mini-pill" onclick="event.stopPropagation(); inspectAggNumber('${a.key}')"><strong>${a.number}</strong> (${a.alreadySentAmt.toLocaleString()}฿)</span>`)
      .join('');

    allocBar.innerHTML = `
      <div class="draw-alloc-card alloc-kept ${currentAggFilter === 'kept_us' ? 'active-filter' : ''}"
        onclick="setAggFilter('${currentAggFilter === 'kept_us' ? 'all' : 'kept_us'}')"
        title="คลิกเพื่อกรองดูเฉพาะเลขที่เราเก็บไว้รับกินเอง (ยอดซื้อรวม หักลบยอดที่ตัดส่งเจ้ามือแล้ว)">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11.5px;font-weight:700;color:var(--success);">🏠 เก็บไว้รับเอง (${keptItems.length} เลข)</span>
          <span style="font-size:10px;color:var(--text-muted);">${currentAggFilter === 'kept_us' ? '✕ ยกเลิกกรอง' : 'คลิกกรองดู'}</span>
        </div>
        <div style="font-family:var(--font-mono);font-size:15.5px;font-weight:700;color:var(--text-main);">
          ${totalKeptAmt.toLocaleString()} ฿
        </div>
        <div class="alloc-mini-pills">
          ${topKeptBadges || `<span class="text-muted" style="font-size:10.5px;">ส่งเจ้ามือครบทุกเลขแล้ว</span>`}
          ${keptItems.length > 5 ? `<span class="text-muted" style="font-size:10.5px;">+${keptItems.length - 5} เลข</span>` : ''}
        </div>
      </div>

      <div class="draw-alloc-card alloc-sent ${currentAggFilter === 'sent_dealer' ? 'active-filter' : ''}"
        onclick="setAggFilter('${currentAggFilter === 'sent_dealer' ? 'all' : 'sent_dealer'}')"
        title="คลิกเพื่อกรองดูเฉพาะเลขที่ตัดส่งเจ้ามือใหญ่ไปแล้ว">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:4px;">
          <span style="font-size:11.5px;font-weight:700;color:var(--info);">📤 ส่งเจ้ามือแล้ว (${sentItems.length} เลข • ${layoffRoundCount} รอบ)</span>
          <button type="button" class="btn btn-outline btn-sm" style="padding:1px 7px;font-size:10px;"
            onclick="event.stopPropagation(); switchTab('tab-layoff')">ไปหน้าตัดยอด ➤</button>
        </div>
        <div style="font-family:var(--font-mono);font-size:15.5px;font-weight:700;color:var(--text-main);">
          ${totalSentAmt.toLocaleString()} ฿
        </div>
        <div class="alloc-mini-pills">
          ${topSentBadges || `<span class="text-muted" style="font-size:10.5px;">ยังไม่มีการตัดส่งเจ้ามือในงวดนี้ (เก็บไว้เอง 100%)</span>`}
          ${sentItems.length > 5 ? `<span class="text-muted" style="font-size:10.5px;">+${sentItems.length - 5} เลข</span>` : ''}
        </div>
      </div>
    `;
  }

  // แถบตัวอย่างไฮไลต์ด้านบนตาราง
  const highlightBar = document.getElementById('exampleHighlightBar');
  const num21 = allAgg.find(a => a.number === '21');
  const num583 = allAgg.find(a => a.number === '583');
  const num154 = allAgg.find(a => a.number === '154');

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
  let list = allAgg.map(item => {
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
      netKeptAmt: Math.max(0, totalAmt - (item.alreadySentAmt || 0)),
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
  if (currentAggFilter === 'sent_dealer') {
    list = list.filter(item => (item.alreadySentAmt || 0) > 0);
  } else if (currentAggFilter === 'kept_us') {
    list = list.filter(item => (item.netKeptAmt ?? Math.max(0, item.totalAmt - (item.alreadySentAmt || 0))) > 0);
  } else if (currentAggFilter === 'multi_hit') {
    list = list.filter(item => item.hitCount > 1);
  } else if (currentAggFilter === 'restricted') {
    list = list.filter(item => item.isRestricted);
  } else if (currentAggFilter === 'digit_2') {
    list = list.filter(item => item.digitCount === 2);
  } else if (currentAggFilter === 'digit_3') {
    list = list.filter(item => item.digitCount === 3);
  }

  // เรียงลำดับตามหัวคอลัมน์ที่คลิกเลือก (หรือตัวเลือกใน #sortAggSelect)
  const dir = aggSortDir === 'asc' ? 1 : -1;
  const getColSortVal = (item, col) => {
    if (col === 'restricted') return item.isRestricted ? 1 : 0;
    if (col === 'top') return item.digitCount === 2 ? (item.twoTopAmt || 0) : (item.threeStraightAmt || 0);
    if (col === 'second') return item.digitCount === 2 ? (item.twoBottomAmt || 0) : (item.threeToadAmt || 0);
    if (col === 'perm') return item.threePermRawAmt || 0;
    if (col === 'total') return item.totalAmt || 0;
    if (col === 'full100') return item.fullPayout100Amt || 0;
    if (col === 'half50') return item.halfPayout50Amt || 0;
    if (col === 'kept') return item.netKeptAmt ?? Math.max(0, (item.totalAmt || 0) - (item.alreadySentAmt || 0));
    if (col === 'sent') return item.alreadySentAmt || 0;
    if (col === 'hits') return item.hitCount || 0;
    return item.totalAmt || 0;
  };

  list = [...list].sort((a, b) => {
    if (aggSortCol === 'number') {
      if (a.digitCount !== b.digitCount) return (a.digitCount - b.digitCount) * dir;
      return a.number.localeCompare(b.number, 'en') * dir;
    }
    const diff = getColSortVal(a, aggSortCol) - getColSortVal(b, aggSortCol);
    if (diff !== 0) return diff * dir;
    const totalDiff = (b.totalAmt || 0) - (a.totalAmt || 0);
    return totalDiff !== 0 ? totalDiff : a.number.localeCompare(b.number, 'en');
  });

  if (!selectedAggNumberKey && list.length > 0) {
    selectedAggNumberKey = num21 ? num21.key : list[0].key;
  }

  tbody.innerHTML = list
    .map(item => {
      const isSelected = item.key === selectedAggNumberKey;
      const topAmt = item.digitCount === 2 ? item.twoTopAmt : item.threeStraightAmt;
      const secondAmt = item.digitCount === 2 ? item.twoBottomAmt : item.threeToadAmt;
      const permAmt = item.threePermRawAmt || 0;
      const doorCount = Array.isArray(item.permBreakdown) && item.permBreakdown.length > 0
        ? item.permBreakdown.length
        : (item.permMult || (item.digitCount === 2 ? 2 : 6));

      const customerNames = Array.from(new Set(item.contributors.map(c => c.customerName))).join(', ');
      const isExpandMode = appState.settings?.permutationMode !== 'keep_raw';
      const hasPermDoors = isExpandMode && Array.isArray(item.permBreakdown) && item.permBreakdown.length > 0 && item.threePermRawAmt > 0;
      const isPermExpanded = expandedPermDropdownKeys.has(item.key);
      const avgDoorVal = hasPermDoors ? +(item.threePermRawAmt / item.permBreakdown.length).toFixed(2) : 0;

      const permDropdownBtnHtml = hasPermDoors
        ? `<button type="button" class="perm-dropdown-btn"
            onclick="event.stopPropagation(); togglePermDropdown('${item.key}')"
            title="คลิกเพื่อกางดูเลขกลับทั้ง ${item.permBreakdown.length} ประตู พร้อมราคาเฉลี่ยประตูละ ${avgDoorVal} บาท">
            🔀 ×${item.permBreakdown.length} (${avgDoorVal}฿) ${isPermExpanded ? '▲' : '▼'}
          </button>`
        : '';

      const permSubRowHtml =
        hasPermDoors && isPermExpanded
          ? `
          <tr class="perm-dropdown-row">
            <td colspan="11">
              <div style="font-size:12px;color:var(--text-main);margin-bottom:6px;font-weight:600;">
                ↳ รายการแยกประตูของเลข <strong>${item.number}×${item.permBreakdown.length}</strong> (ยอดชุดกลับ ${item.threePermRawAmt.toLocaleString()}฿ ÷ ${item.permBreakdown.length} ประตู = เฉลี่ยประตูละ <strong>${avgDoorVal} บาท</strong>):
              </div>
              <div class="perm-doors-grid">
                ${item.permBreakdown
                  .map(
                    d => `
                  <div class="perm-door-chip">
                    <strong style="color:var(--primary);font-size:14px;">${d.doorNumber}</strong>
                    <span style="color:var(--success);font-weight:600;">เฉลี่ย ${d.avgPermAmt} ฿</span>
                    ${
                      d.directStraightAmt > 0
                        ? `<span style="font-size:11px;color:var(--text-muted);">(+เต็ง ${d.directStraightAmt}฿ = รวม ${d.combinedRiskAmt}฿)</span>`
                        : ''
                    }
                  </div>
                `
                  )
                  .join('')}
              </div>
            </td>
          </tr>
        `
          : '';

      const sentAmt = item.alreadySentAmt || 0;
      const netKeptAmt = item.netKeptAmt ?? Math.max(0, (item.totalAmt || 0) - sentAmt);

      const keptCellHtml =
        netKeptAmt > 0
          ? `<strong style="color:var(--success);">🏠 ${netKeptAmt.toLocaleString()} ฿</strong>`
          : '-';

      const sentCellHtml =
        sentAmt > 0
          ? `<strong style="color:var(--info);">📤 ${sentAmt.toLocaleString()} ฿</strong>`
          : '-';

      return `
        <tr class="${isSelected ? 'selected-row' : ''}" onclick="inspectAggNumber('${item.key}')">
          <td>
            <div class="num-cell-wrap">
              <span class="number-pill">${item.number}</span>
              ${permDropdownBtnHtml}
            </div>
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
          <td class="num-col">${
            permAmt > 0
              ? `<span style="color:var(--info);font-weight:600;">${permAmt.toLocaleString()} ฿</span> <span class="text-muted" style="font-size:10.5px;">(×${doorCount})</span>`
              : '-'
          }</td>
          <td class="num-col" style="color:var(--text-main);font-weight:700;font-size:13.5px;">
            ${item.totalAmt.toLocaleString()} ฿
          </td>
          <td class="num-col">
            ${
              item.fullPayout100Amt > 0
                ? `<strong style="color:var(--success);">${item.fullPayout100Amt.toLocaleString()} ฿</strong>`
                : '-'
            }
          </td>
          <td class="num-col">
            ${
              item.halfPayout50Amt > 0
                ? `<strong style="color:var(--primary);">${item.halfPayout50Amt.toLocaleString()} ฿</strong>`
                : '-'
            }
          </td>
          <td class="num-col">${keptCellHtml}</td>
          <td class="num-col">${sentCellHtml}</td>
          <td style="font-size:11.5px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="รวม ${item.hitCount} รายการ (${escapeHtml(customerNames)})">
            <strong>${item.hitCount} ใบ</strong>
            <span class="text-muted">(${escapeHtml(customerNames)})</span>
          </td>
        </tr>
        ${permSubRowHtml}
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
              <strong style="color:var(--text-main);font-size:14px;">👤 ${escapeHtml(c.customerName)}</strong>
              ${
                is100
                  ? `<span class="badge-100">🟢 แทงก่อนเวลาอั้น ➔ ได้เต็ม 100%</span>`
                  : `<span class="badge-50">🔒 แทงหลังเวลาอั้น ➔ ได้ ${c.payoutPercent}%</span>`
              }
            </div>
            <div class="text-muted" style="margin-top:2px;">
              จาก: <strong>${escapeHtml(c.slipTitle)}</strong> • เวลาที่ส่ง: ${formatThaiDateTime(c.createdAt)}
            </div>
            <div style="font-size:12px;margin-top:2px;">
              ที่เขียนในโพย: <code style="color:var(--primary);font-weight:600;">${escapeHtml(c.originalWrite)}</code> (${escapeHtml(c.typeLabel)})
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:${is100 ? 'var(--success)' : 'var(--primary)'};">
              +${c.amount.toLocaleString()} บาท
            </div>
            <button class="btn btn-outline btn-sm" style="margin-top:4px;" onclick="jumpToSlipInspector('${escapeJsArg(c.slipId)}', ${Number(c.col) || 1}, ${Number(c.row) || 1})">
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
        <span class="number-pill" style="font-size:18px;margin-left:8px;">${escapeHtml(item.number)}</span>
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
          <td><span class="number-pill">${escapeHtml(r.number)}</span></td>
          <td><span class="badge-50">จ่าย ${r.payoutPercent}%</span></td>
          <td>${formatThaiDateTime(r.announcedAt)}</td>
          <td class="num-col" style="color:var(--success);font-weight:700;">${full100.toLocaleString()} ฿</td>
          <td class="num-col" style="color:var(--primary);font-weight:700;">${half50.toLocaleString()} ฿</td>
          <td class="num-col" style="color:var(--text-main);font-weight:700;">${total.toLocaleString()} ฿</td>
          <td style="text-align:right;">
            <button class="btn btn-ghost btn-sm" onclick="removeRestrictedNumber('${escapeJsArg(r.number)}')">ลบ</button>
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
  const res = await fetch('/api/draws/restrictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'clear_all',
      drawId: appState.currentDrawId
    })
  });
  if (!res.ok) {
    showToast(`❌ ${await readApiError(res, 'ไม่สามารถล้างเลขอั้นได้')}`);
    return;
  }
  await fetchAppState();
  showToast('ล้างรายการเลขอั้นทั้งหมดในงวดนี้แล้ว');
}

// ============================================================================
// แท็บที่ 3: ตัดยอดส่งเจ้ามือเป็นรอบๆ (หักลบยอดที่ส่งแล้ว/เก็บแล้วอัตโนมัติ ไม่ส่งซ้ำ)
// ============================================================================
function buildLayoffTypeSummary(item) {
  const doorCount =
    Array.isArray(item.permBreakdown) && item.permBreakdown.length > 0
      ? item.permBreakdown.length
      : item.permMult || (item.digitCount === 2 ? 2 : 6);

  const parts = [];
  const badges = [];

  if (item.digitCount === 2) {
    if ((item.twoTopAmt || 0) > 0) {
      parts.push(`บน ${item.twoTopAmt.toLocaleString()}฿`);
      badges.push(`<span class="badge-ai" style="font-size:11px;padding:2px 6px;">บน ${item.twoTopAmt.toLocaleString()}฿</span>`);
    }
    if ((item.twoBottomAmt || 0) > 0) {
      parts.push(`ล่าง ${item.twoBottomAmt.toLocaleString()}฿`);
      badges.push(`<span class="badge-50" style="font-size:11px;padding:2px 6px;">ล่าง ${item.twoBottomAmt.toLocaleString()}฿</span>`);
    }
    if ((item.threePermRawAmt || 0) > 0) {
      parts.push(`ชุดกลับ(×${doorCount}) ${item.threePermRawAmt.toLocaleString()}฿`);
      badges.push(`<span class="badge-100" style="font-size:11px;padding:2px 6px;">กลับ×${doorCount} ${item.threePermRawAmt.toLocaleString()}฿</span>`);
    }
    if (parts.length === 0) {
      parts.push('2 ตัวบน');
      badges.push(`<span class="badge-ai" style="font-size:11px;padding:2px 6px;">2 ตัวบน</span>`);
    }
  } else {
    if ((item.threeStraightAmt || 0) > 0) {
      parts.push(`เต็ง ${item.threeStraightAmt.toLocaleString()}฿`);
      badges.push(`<span class="badge-100" style="font-size:11px;padding:2px 6px;">เต็ง ${item.threeStraightAmt.toLocaleString()}฿</span>`);
    }
    if ((item.threeToadAmt || 0) > 0) {
      parts.push(`โต๊ด ${item.threeToadAmt.toLocaleString()}฿`);
      badges.push(`<span class="badge-ai" style="font-size:11px;padding:2px 6px;">โต๊ด ${item.threeToadAmt.toLocaleString()}฿</span>`);
    }
    if ((item.threePermRawAmt || 0) > 0) {
      parts.push(`ชุดกลับ(×${doorCount}) ${item.threePermRawAmt.toLocaleString()}฿`);
      badges.push(`<span class="badge-50" style="font-size:11px;padding:2px 6px;">ชุดกลับ×${doorCount} ${item.threePermRawAmt.toLocaleString()}฿</span>`);
    }
    if (parts.length === 0) {
      parts.push('3 ตัวเต็ง');
      badges.push(`<span class="badge-100" style="font-size:11px;padding:2px 6px;">3 ตัวเต็ง</span>`);
    }
  }

  return {
    typeDesc: parts.join(' + '),
    badgesHtml: `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">${badges.join('')}</div>`
  };
}

function getFilteredLayoffList() {
  const all = appState.aggregated || [];
  if (layoffTableFilter === 'full_100') {
    return all.filter(item => item.hasNewPending && !item.isRestricted);
  }
  if (layoffTableFilter === 'restricted_50') {
    return all.filter(item => item.hasNewPending && item.isRestricted);
  }
  if (layoffTableFilter === 'all') {
    return all;
  }
  return all.filter(item => item.hasNewPending);
}

function setLayoffTableFilter(filterMode) {
  layoffTableFilter = filterMode;
  document.getElementById('btnFilterLayoffPending')?.classList.toggle('active', filterMode === 'pending_only');
  document.getElementById('btnFilterLayoffFull100')?.classList.toggle('active', filterMode === 'full_100');
  document.getElementById('btnFilterLayoffRestricted50')?.classList.toggle('active', filterMode === 'restricted_50');
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
    getFilteredLayoffList().forEach(a => {
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
  getFilteredLayoffList().forEach(a => {
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

  if (mode === 'split_half') {
    return Math.round(newAmt / 2);
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
    document.getElementById('currentLayoffRoundTitle').textContent = `รอบที่ ${nextRound}`;
    document.getElementById('rightLayoffRoundBadge').textContent = `รอบที่ ${nextRound}`;
  }

  const selectTbody = document.getElementById('layoffSelectTableBody');
  if (selectTbody) {
    const tableList = getFilteredLayoffList();

    if (tableList.length === 0) {
      selectTbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align:center;padding:28px;color:var(--success);font-weight:600;">
            ✅ ไม่มีรายการคงเหลือในตัวกรองนี้ — สามารถสลับตัวกรองด้านบนเพื่อดูทั้งหมดได้ครับ
          </td>
        </tr>
      `;
    } else {
      selectTbody.innerHTML = tableList
        .map(item => {
          const isChecked = selectedLayoffKeys.has(item.key) && item.hasNewPending;
          const payoutPct = item.restrictedRule?.payoutPercent || 50;
          const { badgesHtml } = buildLayoffTypeSummary(item);

          let rateCellHtml = '';
          if (item.isRestricted) {
            const splitSub =
              item.fullPayout100Amt > 0 && item.halfPayout50Amt > 0
                ? `<div class="text-muted" style="font-size:10.5px;margin-top:2px;">100%: ${item.fullPayout100Amt.toLocaleString()}฿ / 50%: ${item.halfPayout50Amt.toLocaleString()}฿</div>`
                : '';
            rateCellHtml = `<span class="badge-50">🔒 อั้น ${payoutPct}%</span>${splitSub}`;
          } else {
            rateCellHtml = `<span class="badge-100">🟢 จ่ายเต็ม 100%</span>`;
          }

          let statusBadge = '';
          if (!item.hasNewPending) {
            statusBadge = `<span class="badge-ai">✅ ส่งเจ้ามือครบแล้ว</span>`;
          } else if (isChecked) {
            statusBadge = `<span class="badge-50">📤 เลือกส่งในรอบนี้</span>`;
          } else if (item.alreadySentAmt > 0) {
            statusBadge = `<span class="badge-100">🏠 เหลือเก็บที่เรา (ส่งบางส่วนแล้ว)</span>`;
          } else {
            statusBadge = `<span class="badge-100">🏠 เก็บไว้ที่เรา</span>`;
          }

          return `
            <tr class="${isChecked ? 'selected-row' : ''}" onclick="toggleLayoffItem('${item.key}', ${!isChecked})" style="cursor:pointer;">
              <td style="text-align:center;" onclick="event.stopPropagation()">
                <input type="checkbox" ${isChecked ? 'checked' : ''} ${!item.hasNewPending ? 'disabled' : ''}
                  onchange="toggleLayoffItem('${item.key}', this.checked)" />
              </td>
              <td>
                <div class="num-cell-wrap">
                  <span class="number-pill">${item.number}</span>
                </div>
              </td>
              <td>${rateCellHtml}</td>
              <td>${badgesHtml}</td>
              <td class="num-col">${item.totalAmt.toLocaleString()} ฿</td>
              <td class="num-col" style="color:var(--info);">
                ${item.alreadySentAmt > 0 ? `${item.alreadySentAmt.toLocaleString()} ฿` : '-'}
              </td>
              <td class="num-col" style="color:var(--success);font-weight:700;font-size:14.5px;">
                ${item.newPendingAmt > 0 ? `${item.newPendingAmt.toLocaleString()} ฿` : '0 ฿'}
              </td>
              <td>
                ${statusBadge}
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

    const { typeDesc } = buildLayoffTypeSummary(item);
    const payoutPercent = item.isRestricted ? (item.restrictedRule?.payoutPercent || 50) : 100;

    return {
      key: item.key,
      number: item.number,
      typeDesc,
      isRestricted: Boolean(item.isRestricted),
      payoutPercent,
      newPendingAmt: newAmt,
      alreadySentAmt: item.alreadySentAmt,
      alreadyKeptAmt: item.alreadyKeptAmt,
      keepTotal: keepAmt,
      sendTotal: sendAmt
    };
  });

  const elNewPending = document.getElementById('layoffKpiNewPending');
  const elNewPendingSub = document.getElementById('layoffKpiNewPendingSub');
  if (elNewPending && elNewPendingSub) {
    elNewPending.textContent = `${totalSendThisRound.toLocaleString()} ฿`;
    elNewPendingSub.textContent = `เลือกไว้ ${layoffRows.length} เลข (คงเหลือเก็บไว้ที่เราหลังส่งรอบนี้: ${Math.max(0, (s.totalKeptByUsMoney || 0) - totalSendThisRound).toLocaleString()} ฿)`;
  }

  if (!skipInputRebuild) {
    if (layoffRows.length === 0) {
      listContainer.innerHTML = `<div class="text-muted" style="text-align:center;padding:18px;">ติ๊กเลือกตัวเลขจากตารางด้านซ้าย เพื่อตัดยอดส่งเจ้ามือในรอบที่ ${nextRound} (เลขที่ไม่ติ๊กจะถูก 🏠 เก็บไว้ที่เราอัตโนมัติ)</div>`;
    } else {
      listContainer.innerHTML = layoffRows
        .map(
          r => `
        <div class="layoff-row-item" style="flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="font-family:var(--font-mono);color:var(--text-main);font-size:15px;">${r.number}</strong>
            <span class="${r.payoutPercent < 100 ? 'badge-50' : 'badge-100'}" style="font-size:10.5px;padding:1px 6px;margin-left:4px;">
              ${r.payoutPercent < 100 ? `🔒 อั้น ${r.payoutPercent}%` : '🟢 จ่ายเต็ม 100%'}
            </span>
            <span class="text-muted" style="font-size:11px;margin-left:4px;">(${r.typeDesc})</span>
            <span style="font-size:12px;color:var(--success);margin-left:6px;font-weight:600;">
              คงเหลืออยู่ที่เรา: ${r.newPendingAmt.toLocaleString()}฿
            </span>
            ${
              r.alreadySentAmt > 0
                ? `<span class="text-muted" style="font-size:11px;margin-left:4px;">(เคยส่งเจ้ามือไปแล้ว ${r.alreadySentAmt.toLocaleString()}฿)</span>`
                : ''
            }
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:12px;color:var(--success);">🏠 เหลือเก็บที่เรา: <strong>${r.keepTotal.toLocaleString()}฿</strong></span>
            <div style="display:flex;align-items:center;gap:4px;">
              <span style="font-size:12px;color:var(--info);">📤 ส่งเจ้ามือรอบนี้:</span>
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
      ? linesToSend.map(
          r => `${r.number} = ${r.sendTotal} บ. (${r.typeDesc} | ${r.payoutPercent < 100 ? `อั้น ${r.payoutPercent}%` : 'จ่ายเต็ม 100%'})`
        )
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
                <strong style="margin-left:6px;">📤 ${escapeHtml(l.dealerName)}</strong>
                <span class="text-muted" style="font-size:11.5px;margin-left:6px;">(${formatThaiDateTime(l.createdAt)})</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="font-size:12px;color:var(--success);">🏠 เก็บเอง: ${(l.totalKeptMoney || 0).toLocaleString()}฿</span>
                <strong style="color:var(--primary);font-family:var(--font-mono);">📤 ส่งเจ้ามือ: ${(l.totalLayoffMoney || 0).toLocaleString()}฿</strong>
                <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="exportSavedLayoffRoundExcel('${escapeJsArg(l.id)}')">📊 โหลด Excel รอบนี้</button>
                <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="exportSavedLayoffRoundCsv('${escapeJsArg(l.id)}')">📄 โหลด CSV รอบนี้</button>
                <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:11px;" onclick="undoLayoffRound('${escapeJsArg(l.id)}')">ยกเลิกรอบนี้</button>
              </div>
            </div>
            <div style="font-size:12px;color:var(--text-muted);">
              รายการในรอบนี้: ${(l.items || [])
                .map(it => `${escapeHtml(it.number)} (ส่ง ${it.sendTotal}฿ / เก็บ ${it.keepTotal || 0}฿)`)
                .join(' • ')}
            </div>
          </div>
        `
            )
            .join('');
  }
}

async function copyAndSaveLayoff(downloadFormat = 'excel') {
  const format =
    downloadFormat === true
      ? 'excel'
      : downloadFormat === false
      ? 'text_only'
      : downloadFormat || 'excel';

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

  const rowsForExport = buildCurrentRoundLayoffRows();
  const s = appState.summary || {};
  const nextRound = s.nextLayoffRound || ((appState.layoffs || []).length + 1);
  const drawTitle = appState.currentDraw?.title || 'งวดวันที่ 16/11';

  try {
    await navigator.clipboard.writeText(text);
  } catch {}

  const itemsPayload = selectedItems
    .map(item => {
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
        typeDesc: buildLayoffTypeSummary(item).typeDesc
      };
    })
    .filter(it => it.sendTotal > 0);

  if (itemsPayload.length === 0) {
    showToast('กรุณาติ๊กเลือกตัวเลขและระบุยอดที่จะส่งเจ้ามือมากกว่า 0 บาทครับ');
    return;
  }

  const res = await fetch('/api/layoffs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drawId: appState.currentDrawId,
      dealerName,
      formattedText: text,
      items: itemsPayload
    })
  });

  const savedData = await res.json().catch(() => ({}));
  const confirmedRoundNumber = savedData?.layoff?.roundNumber || nextRound;
  const confirmedCreatedAt = savedData?.layoff?.createdAt || new Date().toISOString();

  if (format === 'excel') {
    generateDealerLayoffExcelFile({
      roundNumber: confirmedRoundNumber,
      dealerName,
      drawTitle,
      createdAt: confirmedCreatedAt,
      rows: rowsForExport
    });
  } else if (format === 'csv') {
    generateDealerLayoffCsvFile({
      roundNumber: confirmedRoundNumber,
      dealerName,
      rows: rowsForExport
    });
  }

  selectedLayoffKeys.clear();
  customLayoffAmounts = {};
  await fetchAppState();

  if (format === 'excel') {
    showToast('✅ ยืนยันตัดยอดส่งเจ้ามือรอบนี้ + ล็อกยอด + ดาวน์โหลดไฟล์ Excel เรียบร้อย!');
  } else if (format === 'csv') {
    showToast('✅ ยืนยันตัดยอดส่งเจ้ามือรอบนี้ + ล็อกยอด + ดาวน์โหลดไฟล์ CSV เรียบร้อย!');
  } else {
    showToast('✅ ยืนยันตัดยอดส่งเจ้ามือรอบนี้ + ล็อกยอด + คัดลอกข้อความใบโพยเรียบร้อย!');
  }
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

    const { typeDesc } = buildLayoffTypeSummary(item);

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

  generateDealerLayoffCsvFile({
    roundNumber: nextRound,
    dealerName,
    rows
  });
}

function exportSavedLayoffRoundCsv(layoffId) {
  const lf = (appState.layoffs || []).find(l => l.id === layoffId);
  if (!lf) return;

  generateDealerLayoffCsvFile({
    roundNumber: lf.roundNumber || 1,
    dealerName: lf.dealerName || 'เจ้ามือสายใหญ่',
    rows: (lf.items || []).map(it => ({
      number: it.number,
      typeDesc: it.typeDesc || (String(it.number).length === 2 ? '2 ตัวบน' : '3 ตัวบน'),
      payoutPercent: it.payoutPercent || 100,
      sendTotal: Number(it.sendTotal) || 0,
      keepTotal: Number(it.keepTotal) || 0
    }))
  });
}

function generateDealerLayoffCsvFile({ roundNumber, dealerName, rows }) {
  const rowsToSend = rows.filter(r => r.sendTotal > 0);
  const targetRows = rowsToSend.length > 0 ? rowsToSend : rows;

  const csvLines = [
    ['ลำดับ', 'ตัวเลข', 'ประเภท', 'เรทจ่าย', 'ยอดส่งเจ้ามือ (บาท)', 'เก็บไว้ที่เรา (บาท)'].join(',')
  ];

  let totalSend = 0;
  let totalKeep = 0;
  targetRows.forEach((r, idx) => {
    totalSend += Number(r.sendTotal) || 0;
    totalKeep += Number(r.keepTotal) || 0;
    // Use ="072" format so Excel preserves leading zeros in CSV
    csvLines.push(
      [
        idx + 1,
        `="${r.number}"`,
        `"${r.typeDesc || ''}"`,
        `"${r.payoutPercent < 100 ? `เลขอั้น ${r.payoutPercent}%` : 'ปกติ 100%'}"`,
        r.sendTotal,
        r.keepTotal || 0
      ].join(',')
    );
  });
  csvLines.push(['', 'รวมทั้งสิ้น', '', '', totalSend, totalKeep].join(','));

  const safeDealer = (dealerName || 'เจ้ามือสายใหญ่').replace(/[^\u0E00-\u0E7Fa-zA-Z0-9_-]/g, '_');
  const fileName = `ใบส่งเจ้ามือ_${safeDealer}_รอบที่_${roundNumber}.csv`;
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
  const totalTop = list.reduce((sum, a) => sum + (a.digitCount === 2 ? (a.twoTopAmt || 0) : (a.threeStraightAmt || 0)), 0);
  const totalSecond = list.reduce((sum, a) => sum + (a.digitCount === 2 ? (a.twoBottomAmt || 0) : (a.threeToadAmt || 0)), 0);
  const totalPerm = list.reduce((sum, a) => sum + (a.threePermRawAmt || 0), 0);
  const total100 = list.reduce((sum, a) => sum + (a.fullPayout100Amt || 0), 0);
  const total50 = list.reduce((sum, a) => sum + (a.halfPayout50Amt || 0), 0);
  const totalSent = list.reduce((sum, a) => sum + (a.alreadySentAmt || 0), 0);
  const totalKept = list.reduce((sum, a) => sum + Math.max(0, (a.totalAmt || 0) - (a.alreadySentAmt || 0)), 0);

  const rowsHtml = list
    .map((item, idx) => {
      const topAmt = item.digitCount === 2 ? item.twoTopAmt : item.threeStraightAmt;
      const secondAmt = item.digitCount === 2 ? item.twoBottomAmt : item.threeToadAmt;
      const permAmt = item.threePermRawAmt || 0;
      const runners = Array.from(new Set(item.contributors.map(c => c.customerName))).join(', ');
      const sentAmt = item.alreadySentAmt || 0;
      const netKeptAmt = Math.max(0, (item.totalAmt || 0) - sentAmt);

      return `
        <tr>
          <td style="text-align:center;border:1px solid #cbd5e1;padding:5px;">${idx + 1}</td>
          <td style="text-align:center;border:1px solid #cbd5e1;padding:5px;font-weight:bold;font-size:13pt;mso-number-format:'\\@';">${item.number}</td>
          <td style="text-align:center;border:1px solid #cbd5e1;padding:5px;">${item.isRestricted ? 'เลขอั้น 50%' : 'ปกติ 100%'}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;">${topAmt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;">${secondAmt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#2563eb;">${permAmt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;font-weight:bold;background:#fef3c7;">${item.totalAmt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#059669;">${item.fullPayout100Amt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#d97706;">${item.halfPayout50Amt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#059669;font-weight:bold;">${netKeptAmt}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:5px;color:#2563eb;font-weight:bold;">${sentAmt}</td>
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
          <td colspan="12" style="font-size:15pt;font-weight:bold;background:#1e293b;color:#ffffff;padding:10px;text-align:center;">
            สรุปยอดรวมเลขหวยทั้งหมด — ${escapeHtml(drawTitle)}
          </td>
        </tr>
        <tr style="background:#334155;color:#ffffff;font-weight:bold;">
          <th style="border:1px solid #cbd5e1;padding:6px;">ลำดับ</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เลข</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">สถานะ</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เต็ง/บน</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">โต๊ด/ล่าง</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ชุดกลับ (×6/×3)</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ยอดรวมเงินเดียว</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ส่งก่อนอั้น (100%)</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ส่งหลังอั้น (50%)</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เก็บไว้เอง (บาท)</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ส่งเจ้ามือแล้ว (บาท)</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">สายเด็กโพย</th>
        </tr>
        ${rowsHtml}
        <tr style="background:#1e293b;color:#ffffff;font-weight:bold;">
          <td colspan="3" style="text-align:right;border:1px solid #cbd5e1;padding:8px;">รวมทั้งงวด:</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;">${totalTop}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;">${totalSecond}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#93c5fd;">${totalPerm}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#fbbf24;">${totalAll}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#6ee7b7;">${total100}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#fdba74;">${total50}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#6ee7b7;">${totalKept}</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#93c5fd;">${totalSent}</td>
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
  const res = await fetch(`/api/layoffs/${encodeURIComponent(layoffId)}`, { method: 'DELETE' });
  if (!res.ok) {
    showToast(`❌ ${await readApiError(res, 'ไม่สามารถยกเลิกรอบนี้ได้')}`);
    return;
  }
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
    currentInspectedSlipId = null;
    currentInspectorRunner = '';
    sidebarEl.innerHTML = `<div class="text-muted" style="padding:16px;text-align:center;">ไม่มีบิลในงวดนี้</div>`;
    const metaEl = document.getElementById('inspectorMetaText');
    if (metaEl) metaEl.textContent = 'ยังไม่มีบิลโพยในงวดนี้';
    const imgEl = document.getElementById('inspectorImage');
    if (imgEl) {
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
    }
    const emptyPhotoEl = document.getElementById('inspectorPhotoEmpty');
    if (emptyPhotoEl) {
      emptyPhotoEl.classList.remove('hidden');
      emptyPhotoEl.textContent = '📷 ยังไม่มีรูปโพยกระดาษในงวดนี้';
    }
    const markersEl = document.getElementById('photoIssueMarkers');
    if (markersEl) markersEl.innerHTML = '';
    document.getElementById('gridOverlay4x30')?.classList.add('hidden');
    const banner = document.getElementById('validationSummaryBanner');
    if (banner) {
      banner.className = 'validation-banner';
      banner.innerHTML = `<div>ยังไม่มีบิลโพยในงวดนี้ — กดปุ่ม <strong>"+ เพิ่มโพย"</strong> เพื่ออัปโหลดรูปโพยหรือรับโพยทาง LINE ได้เลยครับ</div>`;
    }
    const paperGrid = document.getElementById('paperGridContainer');
    if (paperGrid) {
      paperGrid.style.gridTemplateColumns = '1fr';
      paperGrid.innerHTML = `<div class="text-muted" style="padding:36px 16px;text-align:center;">ยังไม่มีรายการตัวเลขในงวดนี้</div>`;
    }
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
          let statusBadgeHtml = '';
          if (s.status === 'pending_antigravity') {
            statusBadgeHtml = `<span class="badge-ai" style="padding:1px 7px;font-size:10.5px;" title="กำลังรอ Antigravity Agent อ่านลายมือโพยใบนี้">⏳ รอ Antigravity อ่าน...</span>`;
          } else if (hasWarn) {
            statusBadgeHtml = `<span class="badge-50" style="padding:1px 7px;font-size:10.5px;" title="AI พบจุดที่ควรตรวจสอบเทียบกับรูปกระดาษ">⚠️ รอเช็ค ${s.reviewCount} จุด</span>`;
          } else if (s.humanApproved) {
            statusBadgeHtml = `<span class="badge-100" style="padding:1px 7px;font-size:10.5px;" title="คนตรวจและกดยืนยันแล้วโดย ${escapeHtml(s.approvedBy || 'แอดมิน')}">✅ คนยืนยันแล้ว</span>`;
          } else {
            statusBadgeHtml = `<span class="badge-ai" style="padding:1px 7px;font-size:10.5px;" title="AI อ่านและตรวจกฎคณิตศาสตร์ผ่านอัตโนมัติ (รอคนกดปุ่มยืนยัน)">🤖 AI อ่านผ่าน</span>`;
          }
          return `
            <div class="round-list-item ${isCurrent ? 'active' : ''}" onclick="selectSlipForInspection('${s.id}')">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <strong style="color:${isCurrent ? 'var(--primary)' : 'var(--text-main)'};font-size:13px;">
                  📌 รอบที่ ${rNum}
                </strong>
                ${statusBadgeHtml}
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;font-size:11.5px;">
                <span class="text-muted">${formatThaiDateTime(s.createdAt)} (${s.totalItems} รายการ)</span>
                <strong style="font-family:var(--font-mono);color:var(--text-main);">${s.totalMoney.toLocaleString()} ฿</strong>
              </div>
              ${
                !hasWarn && s.humanApproved && s.approvedBy
                  ? `<div style="font-size:10.5px;color:var(--success);margin-top:3px;">👤 ยืนยันโดย: ${escapeHtml(s.approvedBy)}${s.approvedAt ? ` (${formatThaiDateTime(s.approvedAt)})` : ''}</div>`
                  : ''
              }
            </div>
          `;
        })
        .join('');

      return `
        <div class="runner-sidebar-group">
          <div class="runner-sidebar-header">
            <span>👤 ${escapeHtml(runnerName)}</span>
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
  const emptyPhotoEl = document.getElementById('inspectorPhotoEmpty');
  if (slip.imageUrl) {
    imgEl.src = slip.imageUrl;
    imgEl.style.display = '';
    if (emptyPhotoEl) emptyPhotoEl.classList.add('hidden');
  } else {
    imgEl.removeAttribute('src');
    imgEl.style.display = 'none';
    if (emptyPhotoEl) {
      emptyPhotoEl.classList.remove('hidden');
      emptyPhotoEl.textContent = '💬 บิลนี้ส่งมาเป็นข้อความ LINE (ไม่มีรูปกระดาษต้นฉบับ)';
    }
  }
  document.getElementById('inspectorMetaText').textContent =
    `👤 ${slip.customerName} | 📌 รอบที่ ${slip.roundNumber || 1} (${formatThaiDateTime(slip.createdAt)}) | ยอดบิล: ${slip.totalMoney.toLocaleString()}฿`;

  const banner = document.getElementById('validationSummaryBanner');
  const warnItems = (slip.items || []).filter(
    i => i.needsReview || (i.warnings && i.warnings.length > 0)
  );
  if (slip.status === 'pending_antigravity') {
    banner.className = 'validation-banner ai';
    banner.innerHTML = `
      <div>
        <strong>🤖 บิลนี้อยู่ในคิวรอ Antigravity Agent อ่านลายมือ... (หน้าเว็บจะอัปเดตตัวเลขอัตโนมัติทันทีที่อ่านเสร็จ)</strong>
      </div>
      <span style="font-family:var(--font-mono);font-weight:700;white-space:nowrap;">⏳ กำลังรอคิว Antigravity Priority #1</span>
    `;
  } else if (warnItems.length > 0) {
    banner.className = 'validation-banner warn';
    const warnDesc = warnItems
      .map(w => {
        const msg =
          w.warnings && w.warnings.length > 0
            ? w.warnings.join(', ')
            : w.note || 'ตรวจพบรอยขีดฆ่า/ตัวเลขไม่ชัดเจน กรุณาตรวจสอบกับรูปจริง';
        return `<span style="cursor:pointer;text-decoration:underline;font-weight:700;" onclick="focusInspectorCell(${Number(w.col) || 1}, ${Number(w.row) || 1})">📍 คอลัมน์ ${Number(w.col) || 1} แถว ${Number(w.row) || 1} (${escapeHtml(w.numText)}=${escapeHtml(w.amtText)}): ${escapeHtml(msg)} (คลิกเพื่อชี้จุด)</span>`;
      })
      .join(' | ');
    banner.innerHTML = `
      <div>
        <strong>⚠️ พบจุดที่ควรเช็คเทียบกับรูปกระดาษ ${warnItems.length} จุด:</strong>
        <div style="margin-top:3px;">${warnDesc}</div>
      </div>
      <span style="font-family:var(--font-mono);font-weight:700;white-space:nowrap;">ยอดรวมใบนี้: ${slip.totalMoney.toLocaleString()} ฿</span>
    `;
  } else if (slip.humanApproved) {
    banner.className = 'validation-banner ok';
    banner.innerHTML = `
      <div>
        <strong>✅ คนตรวจยืนยันความถูกต้องแล้ว (Human Approved โดย ${escapeHtml(slip.approvedBy || 'แอดมิน')}${slip.approvedAt ? ` เมื่อ ${formatThaiDateTime(slip.approvedAt)}` : ''}) — ผ่านกฎคณิตศาสตร์ครบทุกแถว (${slip.totalItems} รายการ):</strong>
        กฎ ×6 (เลขไม่ซ้ำ/หาร 6 ลงตัว) • กฎ ×3 (เลขเบิ้ล/หาร 3 ลงตัว) • กฎพหูคูณ 11 บาท ถูกต้อง 100%
      </div>
      <span style="font-family:var(--font-mono);font-weight:700;white-space:nowrap;">ยอดรวมใบนี้: ${slip.totalMoney.toLocaleString()} ฿</span>
    `;
  } else {
    banner.className = 'validation-banner ai';
    banner.innerHTML = `
      <div>
        <strong>🤖 AI อ่านและตรวจกฎคณิตศาสตร์ 4 ชั้นผ่านอัตโนมัติครบ ${slip.totalItems} รายการ:</strong>
        (ยังไม่ได้กดยืนยันโดยคน — กรุณาตรวจทานแล้วกดปุ่ม <strong>"✅ ยืนยันยอดบิลรอบนี้"</strong> ด้านบน)
      </div>
      <span style="font-family:var(--font-mono);font-weight:700;white-space:nowrap;">ยอดรวมใบนี้: ${slip.totalMoney.toLocaleString()} ฿</span>
    `;
  }

  // วาดกรอบชี้ตำแหน่งที่มีปัญหาบนรูปกระดาษโพยต้นฉบับ (รองรับทั้งพิกัด box2d รายช่อง และ tableBox รายใบจาก Gemini 2.5 Pro)
  const markersEl = document.getElementById('photoIssueMarkers');
  if (markersEl) {
    // Apply per-image dynamic tableBox [ymin, xmin, ymax, xmax] (0-1000 scale) if available
    if (Array.isArray(slip.tableBox) && slip.tableBox.length === 4) {
      const [ymin, xmin, ymax, xmax] = slip.tableBox;
      markersEl.style.top = `${(ymin / 10).toFixed(2)}%`;
      markersEl.style.left = `${(xmin / 10).toFixed(2)}%`;
      markersEl.style.bottom = `${(100 - ymax / 10).toFixed(2)}%`;
      markersEl.style.right = `${(100 - xmax / 10).toFixed(2)}%`;
    } else {
      markersEl.style.top = '14.1%';
      markersEl.style.left = '14.2%';
      markersEl.style.bottom = '8.6%';
      markersEl.style.right = '2.5%';
    }

    const itemCols = (slip.items || []).map(i => Number(i.col) || 1);
    const totalCols = Math.max(slip.isGrid4x30 ? 4 : 1, ...itemCols, 1);

    if (slip.isGrid4x30 || totalCols >= 2) {
      const boxesHtml = warnItems.map(w => {
        const leftPct = (((w.col || 1) - 1) / totalCols) * 100;
        const widthPct = 100 / totalCols;
        const topPct = (((w.row || 1) - 1) / 30) * 100;
        const heightPct = 100 / 30;
        return `
          <div class="photo-issue-box"
            style="left:${leftPct}%;width:${widthPct}%;top:${topPct}%;height:${heightPct}%;"
            onclick="focusInspectorCell(${Number(w.col) || 1}, ${Number(w.row) || 1})"
            title="คลิกเพื่อเลื่อนไปยัง คอลัมน์ ${Number(w.col) || 1} แถว ${Number(w.row) || 1}">
            <span class="photo-issue-label">⬅️ แถว ${Number(w.row) || 1} (${escapeHtml(w.numText)}=${escapeHtml(w.amtText)})</span>
          </div>
        `;
      });
      markersEl.innerHTML = boxesHtml.join('') + `<div id="activeFocusPhotoBox"></div>`;
    } else {
      markersEl.innerHTML = '';
    }
  }

  const container = document.getElementById('paperGridContainer');
  const itemColNums = (slip.items || []).map(i => Number(i.col) || 1);
  const maxCol = Math.max(slip.isGrid4x30 ? 4 : 1, ...itemColNums, 1);
  const cols = Array.from({ length: maxCol }, (_, idx) => idx + 1);
  if (container) {
    container.style.gridTemplateColumns =
      maxCol > 4 ? 'repeat(auto-fit, minmax(175px, 1fr))' : '';
  }

  container.innerHTML = cols
    .map(colNum => {
      const colItems = (slip.items || []).filter(i => (i.col || 1) === colNum);
      const maxRowInCol = colItems.reduce((m, it) => Math.max(m, Number(it.row) || 1), 1);
      const maxRows = slip.isGrid4x30 && maxCol === 4 ? Math.max(30, maxRowInCol) : Math.max(maxRowInCol, colItems.length, 1);
      const sampleColItem = colItems.find(i => i.colHeader || i.categoryHint) || {};
      const colHeaderLabel = sampleColItem.colHeader
        ? sampleColItem.colHeader
        : sampleColItem.categoryHint === '3_toad'
          ? 'โต๊ด ห.ท.1'
          : sampleColItem.categoryHint === '2_bottom'
            ? '2 ล่าง'
            : sampleColItem.categoryHint === '2_bottom_top'
              ? 'ล.บ'
              : '3 ตัว/2 ตัว';
      const rowsHtml = [];
      let colTotal = 0;

      for (let rIdx = 1; rIdx <= maxRows; rIdx++) {
        const item = colItems.find(i => i.row === rIdx) || {
          col: colNum,
          row: rIdx,
          colHeader: sampleColItem.colHeader || '',
          categoryHint: sampleColItem.categoryHint || '3_top',
          numText: '',
          amtText: '',
          rowTotalMoney: 0,
          warnings: [],
          needsReview: false
        };
        colTotal += item.rowTotalMoney || 0;

        const hasIssue = Boolean(
          item.needsReview || (item.warnings && item.warnings.length > 0)
        );

        if (showWarningsOnlyInInspector && !hasIssue) continue;

        const isHighlighted = highlightCol === colNum && highlightRow === rIdx;
        const rowClass = hasIssue || isHighlighted ? 'row-warn' : '';
        const warnMessages =
          item.warnings && item.warnings.length > 0
            ? item.warnings
            : item.needsReview
              ? [item.note || 'ตรวจพบรอยขีดฆ่า/เขียนทับตรงกลางช่องจำนวนเงิน กรุณาตรวจสอบกับรูปจริง']
              : [];

        rowsHtml.push(`
          <div class="paper-row-item ${rowClass}" id="cell-${colNum}-${rIdx}">
            <span class="row-idx">${rIdx}</span>
            <input type="text" class="cell-input" data-col="${colNum}" data-row="${rIdx}" data-field="numText"
              data-col-header="${escapeHtml(item.colHeader || sampleColItem.colHeader || '')}"
              data-category-hint="${escapeHtml(item.categoryHint || sampleColItem.categoryHint || '3_top')}"
              value="${item.numText || ''}" placeholder="เลข"
              onfocus="highlightActivePhotoCell(${colNum}, ${rIdx}, '${item.numText || ''}', '${item.amtText || ''}')"
              onchange="onCellEdit(${colNum}, ${rIdx})" />
            <input type="text" class="cell-input" data-col="${colNum}" data-row="${rIdx}" data-field="amtText"
              value="${item.amtText || ''}" placeholder="ยอดเงิน"
              onfocus="highlightActivePhotoCell(${colNum}, ${rIdx}, '${item.numText || ''}', '${item.amtText || ''}')"
              onchange="onCellEdit(${colNum}, ${rIdx})" />
            ${
              warnMessages.length > 0
                ? `<div class="row-warn-note">⚠️ ${warnMessages.join(' | ')}</div>`
                : ''
            }
          </div>
        `);
      }

      return `
        <div class="paper-col-box">
          <div class="paper-col-header">
            <span>คอลัมน์ที่ ${colNum} (${escapeHtml(colHeaderLabel)})</span>
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

function highlightActivePhotoCell(col, row, numText = '', amtText = '') {
  const focusContainer = document.getElementById('activeFocusPhotoBox');
  if (!focusContainer) return;
  const allInspectableSlips = [...(appState.slips || []), ...(appState.trainingSlips || [])];
  const slip = allInspectableSlips.find(s => s.id === currentInspectedSlipId);
  const totalCols = Math.max(4, ...((slip?.items || []).map(i => Number(i.col) || 1)));
  const leftPct = ((col - 1) / totalCols) * 100;
  const widthPct = 100 / totalCols;
  const topPct = ((row - 1) / 30) * 100;
  const heightPct = 100 / 30;
  focusContainer.innerHTML = `
    <div class="photo-issue-box" id="currentActiveFocusMarker"
      style="left:${leftPct}%;width:${widthPct}%;top:${topPct}%;height:${heightPct}%;border-color:#3b82f6;background:rgba(59,130,246,0.18);box-shadow:0 0 10px rgba(59,130,246,0.85);">
      <span class="photo-issue-label" style="background:#2563eb;">📍 คอลัมน์ ${col} แถว ${row}</span>
    </div>
  `;

  // Auto-pan the zoomed photo viewport so the active column & row is centered in view!
  const viewport = document.getElementById('photoViewport');
  const wrap = document.getElementById('photoCanvasWrap');
  if (viewport && wrap) {
    const targetX = wrap.offsetWidth * (0.142 + ((col - 0.5) / totalCols) * 0.833);
    const targetY = wrap.offsetHeight * (0.141 + ((row - 0.5) / 30) * 0.773);
    viewport.scrollTo({
      left: Math.max(0, targetX - viewport.clientWidth / 2),
      top: Math.max(0, targetY - viewport.clientHeight / 2),
      behavior: 'smooth'
    });
  }
}

function focusInspectorCell(col, row) {
  highlightActivePhotoCell(col, row);
  const el = document.getElementById(`cell-${col}-${row}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const inp = el.querySelector('input');
    if (inp) inp.focus();
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
      colHeader: it.colHeader || '',
      categoryHint: it.categoryHint || '3_top',
      numText: it.numText,
      amtText: it.amtText,
      note: markVerified ? '' : it.note,
      clearedNote: markVerified
    });
  }

  numInputs.forEach(numEl => {
    const col = parseInt(numEl.getAttribute('data-col'), 10);
    const row = parseInt(numEl.getAttribute('data-row'), 10);
    const colHeader = numEl.getAttribute('data-col-header') || '';
    const categoryHint = numEl.getAttribute('data-category-hint') || '3_top';
    const amtEl = document.querySelector(`.cell-input[data-col="${col}"][data-row="${row}"][data-field="amtText"]`);
    const numText = numEl.value.trim();
    const amtText = amtEl ? amtEl.value.trim() : '';

    if (numText || amtText) {
      updatedMap.set(`${col}_${row}`, {
        col,
        row,
        colHeader,
        categoryHint,
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
          return `<button class="chip ${currentLearnedRunnerFilter === name ? 'active' : ''}" onclick="setLearnedRunnerFilter('${escapeJsArg(name)}')">👤 ${escapeHtml(name)} (${cnt})</button>`;
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
          <span class="badge-100" style="cursor:pointer;" onclick="jumpFromLearnedRule('${escapeJsArg(r.customerName)}', ${r.roundNumber || 1})">👤 ${escapeHtml(r.customerName)}</span>
          <span class="runner-rounds-badge" style="margin-left:0;cursor:pointer;" onclick="jumpFromLearnedRule('${escapeJsArg(r.customerName)}', ${r.roundNumber || 1})" title="คลิกเพื่อเปิดดูบิลรอบนี้">
            📌 รอบที่ ${r.roundNumber || 1} • 📅 ${formatThaiDateTime(r.learnedAt)} (คลิกดูบิล ➔)
          </span>
          <span>
            ช่อง${r.field === 'amtText' ? 'ยอดเงิน' : 'ตัวเลข'}: หากเขียนคล้าย
            <code style="color:var(--danger);font-weight:700;">${escapeHtml(r.wrongText)}</code>
            ➔ ให้แปลงเป็น
            <code style="color:var(--success);font-weight:700;">${escapeHtml(r.correctText)}</code>
          </span>
          <span class="text-muted">(${escapeHtml(r.reason || '')})</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="removeLearnedRule('${escapeJsArg(r.id)}')">ลบ</button>
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
  currentZoom = Math.min(3.0, Math.max(0.75, currentZoom + delta));
  const wrap = document.getElementById('photoCanvasWrap');
  if (wrap) {
    wrap.style.transform = 'none';
    wrap.style.width = `${Math.round(currentZoom * 100)}%`;
  }
  document.getElementById('zoomLevelText').textContent = `${Math.round(currentZoom * 100)}%`;
}

function resetZoom() {
  currentZoom = 1.0;
  const wrap = document.getElementById('photoCanvasWrap');
  if (wrap) {
    wrap.style.transform = 'none';
    wrap.style.width = '100%';
  }
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

async function rotateBase64Image90(dataUrl, degrees = 90) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const rad = (degrees * Math.PI) / 180;
      const isRightAngle = Math.abs(degrees) % 180 === 90;
      canvas.width = isRightAngle ? img.height : img.width;
      canvas.height = isRightAngle ? img.width : img.height;
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      resolve(canvas.toDataURL('image/jpeg', 0.94));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function renderUploadFullImagePreview() {
  const grid = document.getElementById('slicePreviewGrid');
  if (!grid || !uploadedBase64Image) return;
  grid.innerHTML = `
    <div class="slice-item" style="grid-column: 1 / -1; text-align:center;">
      <div style="margin-bottom:6px;font-weight:700;color:var(--text-main);">📄 ภาพโพยความละเอียดสูงเต็มใบ (รองรับ 2, 4, 5 และ 8 คอลัมน์อัตโนมัติ)</div>
      <img src="${uploadedBase64Image}" style="max-width:100%;max-height:280px;object-fit:contain;border-radius:6px;border:1px solid var(--border);" />
    </div>
  `;
}

async function rotateUploadPreviewImage(degrees) {
  if (!uploadedBase64Image) {
    showToast('กรุณาเลือกรูปโพยก่อนกดหมุนภาพครับ');
    return;
  }
  uploadedBase64Image = await rotateBase64Image90(uploadedBase64Image, degrees);
  uploadedColumnSlices = null;
  renderUploadFullImagePreview();
  showToast(`🔄 หมุนรูปโพย ${degrees > 0 ? 'ขวา 90°' : 'ซ้าย 90°'} เรียบร้อย พร้อมส่งให้ AI อ่าน`);
}

let currentInspectorRotation = 0;
async function rotateInspectorImage(degrees) {
  const imgEl = document.getElementById('inspectorImage');
  if (!imgEl) return;
  if (imgEl.src) {
    const rotated = await rotateBase64Image90(imgEl.src, degrees);
    if (rotated && rotated.startsWith('data:image/')) {
      imgEl.src = rotated;
      showToast(`🔄 หมุนรูปโพยต้นฉบับ ${degrees > 0 ? 'ขวา 90°' : 'ซ้าย 90°'} เรียบร้อย`);
      return;
    }
  }
  currentInspectorRotation = (currentInspectorRotation + degrees) % 360;
  imgEl.style.transform = `rotate(${currentInspectorRotation}deg)`;
  showToast(`🔄 หมุนรูปโพยต้นฉบับ ${degrees > 0 ? 'ขวา 90°' : 'ซ้าย 90°'} เรียบร้อย`);
}

async function previewUploadImage(inputEl) {
  const file = inputEl.files?.[0];
  if (!file) return;

  uploadedBase64Image = await fileToBase64(file);
  // Send full high-resolution image directly to Gemini 2.5 Pro so 2, 4, 5, and 8-column slips and sideways photos are never sliced through numbers
  uploadedColumnSlices = null;
  renderUploadFullImagePreview();
  showToast('📸 โหลดรูปโพยความละเอียดสูงเต็มใบพร้อมส่งให้ AI อ่านแล้ว (กดหมุนภาพได้หากรูปตะแคง)');
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
      if (data.queuedForAntigravity || data.slip.status === 'pending_antigravity') {
        showToast(
          `🤖 ส่งรูปโพยเข้าคิว Antigravity Agent (Priority #1) แล้ว! หน้าเว็บจะอัปเดตตัวเลขอัตโนมัติทันทีที่อ่านเสร็จ`
        );
      } else {
        showToast(
          isTrainingOnly
            ? `🧠 โหลดโพยเก่าเข้าโหมดฝึกสอนสำเร็จ! แก้ไขตัวเลขที่เพี้ยนในตารางเพื่อให้ AI จำลายมือได้เลย (ไม่รวมในยอดเงินงวดปัจจุบัน)`
            : `✅ อ่านโพยสำเร็จ (${data.slip.totalItems} รายการ รวม ${data.slip.totalMoney.toLocaleString()} บาท)`
        );
      }
    }
  } catch (err) {
    showToast(`❌ เกิดข้อผิดพลาด: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 เริ่มอ่านลายมือในโพยด้วย AI (Gemini 2.5 Pro)';
  }
}

// ============================================================================
// แท็บที่ 6: ดึงผลสลากกินแบ่งรัฐบาล (กองสลาก) & ตรวจเช็คคนถูกรางวัล
// ============================================================================
function onFirstPrizeInput(val) {
  const clean = String(val || '').replace(/[^\d]/g, '').slice(0, 6);
  if (clean.length === 6) {
    document.getElementById('winThreeTopInput').value = clean.slice(-3);
    document.getElementById('winTwoTopInput').value = clean.slice(-2);
  }
}

async function fetchLatestGloLotteryResult() {
  showToast('🔄 กำลังดึงผลสลากกินแบ่งรัฐบาลล่าสุดจากกองสลาก...');
  const res = await fetch('/api/draws/winning-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drawId: appState.currentDrawId,
      action: 'fetch_glo'
    })
  });
  if (!res.ok) {
    showToast(`❌ ${await readApiError(res, 'ไม่สามารถดึงผลรางวัลได้')}`);
    return;
  }
  const data = await res.json();
  await fetchAppState();
  const w = data.winningResult || {};
  showToast(`🏆 ดึงผลกองสลากสำเร็จ! รางวัลที่ 1: ${w.firstPrize} (3 ตัวบน: ${w.threeTop} | 2 ตัวล่าง: ${w.twoBottom})`);
}

async function applySampleWinningNumbers(firstPrize, threeTop, twoTop, twoBottom) {
  document.getElementById('winFirstPrizeInput').value = firstPrize;
  document.getElementById('winThreeTopInput').value = threeTop;
  document.getElementById('winTwoTopInput').value = twoTop;
  document.getElementById('winTwoBottomInput').value = twoBottom;
  await saveManualWinningResult();
}

async function saveManualWinningResult() {
  const firstPrize = document.getElementById('winFirstPrizeInput').value.trim();
  const threeTop = document.getElementById('winThreeTopInput').value.trim();
  const twoTop = document.getElementById('winTwoTopInput').value.trim();
  const twoBottom = document.getElementById('winTwoBottomInput').value.trim();

  const res = await fetch('/api/draws/winning-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drawId: appState.currentDrawId,
      action: 'manual',
      firstPrize,
      threeTop,
      twoTop,
      twoBottom
    })
  });
  if (!res.ok) {
    showToast(`❌ ${await readApiError(res, 'ไม่สามารถบันทึกผลรางวัลได้')}`);
    return;
  }

  await fetchAppState();
  showToast('🎯 คำนวณตรวจเช็คคนถูกรางวัลครบทุกบิลเรียบร้อยแล้ว!');
}

function renderWinnersTab() {
  const wc = appState.winnerCheck;
  if (!wc) return;

  const win = wc.winningResult || {};
  const fin = wc.financialSummary || {};
  const tickets = wc.winningTickets || [];
  const runners = wc.winnersByRunner || [];
  const claims = wc.dealerClaims || [];

  const fpEl = document.getElementById('winFirstPrizeInput');
  if (fpEl) {
    fpEl.value = win.firstPrize || '945583';
    document.getElementById('winThreeTopInput').value = win.threeTop || '583';
    document.getElementById('winTwoTopInput').value = win.twoTop || '83';
    document.getElementById('winTwoBottomInput').value = win.twoBottom || '21';
  }

  const srcEl = document.getElementById('winResultSourceText');
  if (srcEl) {
    srcEl.textContent = `${win.source || 'ผลรางวัลปัจจุบัน'} • 3 ตัวบน: ${win.threeTop} (โต๊ด: ${(win.threeTopPerms || []).join(', ')}) • 2 ตัวบน: ${win.twoTop} • 2 ตัวล่าง: ${win.twoBottom}`;
  }

  const kpiCnt = document.getElementById('winKpiTicketCount');
  if (kpiCnt) {
    kpiCnt.textContent = `${tickets.length} รายการ`;
    document.getElementById('winKpiRunnerCount').textContent = `จากเด็กโพย ${runners.length} คน`;
    document.getElementById('winKpiTotalPayout').textContent = `${(fin.totalCustomerPayout || 0).toLocaleString()} ฿`;
    document.getElementById('winKpiSaved50').textContent =
      fin.totalSavedBy50Cutoff > 0
        ? `ประหยัดจากกติกาเลขอั้น 50% ได้ถึง ${fin.totalSavedBy50Cutoff.toLocaleString()} ฿!`
        : `ไม่มีรายการที่ติดหัก 50%`;
    document.getElementById('winKpiDealerRecovery').textContent = `${(fin.totalDealerRecovery || 0).toLocaleString()} ฿`;
    document.getElementById('winKpiNetOutPocket').textContent = `${(fin.netOutOfPocketPayout || 0).toLocaleString()} ฿`;
  }

  const tbody = document.getElementById('winningTicketsTableBody');
  if (tbody) {
    if (tickets.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted);">ไม่มีรายการที่ถูกรางวัลสำหรับเลขชุดนี้</td></tr>`;
    } else {
      tbody.innerHTML = tickets
        .map(t => {
          const is100 = t.payoutPercent === 100;
          return `
            <tr>
              <td>
                <div style="font-weight:700;color:var(--text-main);">👤 ${escapeHtml(t.customerName)}</div>
                <div class="text-muted" style="font-size:11.5px;">📌 รอบที่ ${t.roundNumber} (${formatThaiDateTime(t.createdAt)})</div>
              </td>
              <td>
                <code style="color:var(--primary);font-weight:700;">${t.originalWrite}</code>
                <div class="text-muted" style="font-size:11px;">คอลัมน์ ${t.col} • แถวที่ ${t.row}</div>
              </td>
              <td>
                <span class="number-pill" style="min-width:42px;font-size:13.5px;">${t.winNumber}</span>
                <span style="margin-left:6px;font-weight:600;">${t.winType}</span>
              </td>
              <td class="num-col" style="font-weight:700;">${t.betAmount.toLocaleString()} ฿</td>
              <td>
                ${
                  is100
                    ? `<span class="badge-100">🟢 ส่งก่อนอั้น (100%)</span>`
                    : `<span class="badge-50">🔒 ส่งหลังอั้น (${t.payoutPercent}%)</span>`
                }
              </td>
              <td class="num-col">×${t.effectiveRate.toLocaleString()}</td>
              <td class="num-col" style="color:var(--primary);font-weight:700;font-size:15px;">
                ${t.actualPrize.toLocaleString()} ฿
                ${
                  t.savedAmt > 0
                    ? `<div style="font-size:10.5px;color:var(--success);">(ประหยัดไป ${t.savedAmt.toLocaleString()}฿)</div>`
                    : ''
                }
              </td>
              <td style="text-align:right;">
                <button class="btn btn-outline btn-sm" onclick="jumpToSlipInspector('${escapeJsArg(t.slipId)}', ${Number(t.col) || 1}, ${Number(t.row) || 1})">
                  🔍 ดูในโพย
                </button>
              </td>
            </tr>
          `;
        })
        .join('');
    }
  }

  const runnerWrap = document.getElementById('winnersByRunnerContainer');
  if (runnerWrap) {
    runnerWrap.innerHTML =
      runners.length === 0
        ? `<div class="text-muted" style="padding:12px;text-align:center;">ไม่มีเด็กโพยถูกรางวัล</div>`
        : runners
            .map(
              rw => `
          <div class="contributor-item" style="margin-bottom:8px;">
            <div>
              <strong style="color:var(--text-main);font-size:14.5px;">👤 ${rw.customerName}</strong>
              <div class="text-muted">ถูกรางวัลรวม ${rw.winCount} รายการ</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:11px;color:var(--text-muted);">ยอดจ่ายเงินรางวัลรวม</div>
              <strong style="font-family:var(--font-mono);font-size:17px;color:var(--primary);">${rw.totalPrize.toLocaleString()} ฿</strong>
            </div>
          </div>
        `
            )
            .join('');
  }

  const claimWrap = document.getElementById('dealerClaimsContainer');
  if (claimWrap) {
    claimWrap.innerHTML =
      claims.length === 0
        ? `<div class="text-muted" style="padding:12px;text-align:center;">ไม่มีเลขที่ส่งเจ้ามือตรงกับรางวัลในรอบนี้</div>`
        : claims
            .map(
              c => `
          <div class="contributor-item" style="margin-bottom:8px;">
            <div>
              <span class="badge-100">ใบส่งเจ้ามือ รอบที่ ${c.roundNumber}</span>
              <strong style="margin-left:6px;">เลข ${c.number} (${c.matchType})</strong>
              <div class="text-muted" style="margin-top:2px;">ส่งออกให้ ${c.dealerName}: ${c.sentAmount.toLocaleString()} ฿</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:11px;color:var(--text-muted);">เคลมเงินคืนจากเจ้ามือ</div>
              <strong style="font-family:var(--font-mono);font-size:16px;color:var(--success);">+${c.claimPrize.toLocaleString()} ฿</strong>
            </div>
          </div>
        `
            )
            .join('');
  }
}

function exportWinnersExcel() {
  const wc = appState.winnerCheck;
  const tickets = wc?.winningTickets || [];
  if (tickets.length === 0) {
    showToast('ไม่มีรายการผู้ถูกรางวัลให้ส่งออกครับ');
    return;
  }

  const win = wc.winningResult || {};
  const drawTitle = appState.currentDraw?.title || 'งวดวันที่ 16/11';
  const totalPrize = tickets.reduce((s, t) => s + (t.actualPrize || 0), 0);

  const rowsHtml = tickets
    .map(
      (t, idx) => `
      <tr>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;">${idx + 1}</td>
        <td style="border:1px solid #cbd5e1;padding:6px;font-weight:bold;">${escapeHtml(t.customerName)} (รอบที่ ${t.roundNumber})</td>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;">คอลัมน์ ${t.col} แถว ${t.row} (${escapeHtml(t.originalWrite)})</td>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;font-weight:bold;mso-number-format:'\\@';">${t.winNumber}</td>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;">${escapeHtml(t.winType)}</td>
        <td style="text-align:right;border:1px solid #cbd5e1;padding:6px;">${t.betAmount}</td>
        <td style="text-align:center;border:1px solid #cbd5e1;padding:6px;">${t.payoutPercent === 100 ? 'จ่ายเต็ม 100%' : `เลขอั้น ${t.payoutPercent}%`}</td>
        <td style="text-align:right;border:1px solid #cbd5e1;padding:6px;">${t.effectiveRate}</td>
        <td style="text-align:right;border:1px solid #cbd5e1;padding:6px;font-weight:bold;background:#fef3c7;">${t.actualPrize}</td>
      </tr>
    `
    )
    .join('');

  const html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="UTF-8"></head>
    <body style="font-family:'Tahoma',sans-serif;">
      <table style="border-collapse:collapse;width:100%;">
        <tr>
          <td colspan="9" style="font-size:15pt;font-weight:bold;background:#1e293b;color:#ffffff;padding:10px;text-align:center;">
            สรุปรายชื่อผู้ถูกรางวัล — ${escapeHtml(drawTitle)} (3 ตัวบน: ${win.threeTop} | 2 ตัวล่าง: ${win.twoBottom})
          </td>
        </tr>
        <tr style="background:#334155;color:#ffffff;font-weight:bold;">
          <th style="border:1px solid #cbd5e1;padding:6px;">ลำดับ</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เด็กโพย & รอบบิล</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">จุดที่เขียนในโพย</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เลขที่ถูก</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ประเภทรางวัล</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">ยอดซื้อ (บาท)</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">สถานะอั้น</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เรทจ่าย</th>
          <th style="border:1px solid #cbd5e1;padding:6px;">เงินรางวัล (บาท)</th>
        </tr>
        ${rowsHtml}
        <tr style="background:#1e293b;color:#ffffff;font-weight:bold;">
          <td colspan="8" style="text-align:right;border:1px solid #cbd5e1;padding:8px;">รวมยอดเงินรางวัลที่ต้องจ่ายทั้งสิ้น:</td>
          <td style="text-align:right;border:1px solid #cbd5e1;padding:8px;color:#fbbf24;">${totalPrize}</td>
        </tr>
      </table>
    </body>
    </html>
  `;

  downloadBlobFile(html, `สรุปผู้ถูกรางวัล_${drawTitle.replace(/\s+/g, '_')}.xls`, 'application/vnd.ms-excel;charset=utf-8');
  showToast('📊 ดาวน์โหลดไฟล์ Excel รายชื่อคนถูกรางวัลเรียบร้อย!');
}

// ============================================================================
// แท็บที่ 7: ตั้งค่าระบบ (แยกหมวดย่อย 6 หมวด) & พิมพ์กระดาษโพย 4×30
// ============================================================================
function switchSettingsSubTab(subTabId) {
  document.querySelectorAll('.settings-subpanel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.settings-subbtn, .subnav-btn').forEach(b => b.classList.remove('active'));

  const target = document.getElementById(subTabId);
  if (target) target.classList.add('active');

  const btn = document.querySelector(`[data-subtab="${subTabId}"]`);
  if (btn) btn.classList.add('active');

  const sheet = document.getElementById('printableSheet');
  if (sheet) {
    sheet.classList.toggle('show-preview', subTabId === 'sub-print');
  }
}

function switchSettingsSubtab(subTabId) {
  return switchSettingsSubTab(subTabId);
}

async function addUserAccount() {
  const username = (document.getElementById('newUsernameInput')?.value || '').trim();
  const password = (document.getElementById('newPasswordInput')?.value || '').trim();
  const displayName = (document.getElementById('newDisplayNameInput')?.value || username).trim();
  const role = document.getElementById('newRoleSelect')?.value || 'staff';

  if (!username) {
    showToast('กรุณาระบุชื่อผู้ใช้ (Username)');
    return;
  }
  if (password.length < 6) {
    showToast('กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร');
    return;
  }

  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add',
      username,
      password,
      displayName,
      role
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    showToast(`❌ ${data.error || 'ไม่สามารถเพิ่มบัญชีได้'}`);
    return;
  }

  document.getElementById('newUsernameInput').value = '';
  document.getElementById('newPasswordInput').value = '';
  document.getElementById('newDisplayNameInput').value = '';
  await fetchAppState();
  showToast(`✅ เพิ่มบัญชีผู้ใช้งาน "${displayName}" (@${username}) เรียบร้อย`);
}

async function submitChangePassword() {
  const currentPassword = (document.getElementById('changeCurrentPasswordInput')?.value || '').trim();
  const newPassword = (document.getElementById('changeNewPasswordInput')?.value || '').trim();
  const confirmPassword = (document.getElementById('changeConfirmPasswordInput')?.value || '').trim();

  if (!currentPassword) {
    showToast('กรุณากรอกรหัสผ่านปัจจุบัน');
    return;
  }
  if (newPassword.length < 6) {
    showToast('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('❌ รหัสผ่านใหม่ทั้ง 2 ช่องไม่ตรงกัน');
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showToast(`❌ ${data.error || 'ไม่สามารถเปลี่ยนรหัสผ่านได้'}`);
      return;
    }

    document.getElementById('changeCurrentPasswordInput').value = '';
    document.getElementById('changeNewPasswordInput').value = '';
    document.getElementById('changeConfirmPasswordInput').value = '';
    await fetchAppState();
    showToast('🔑 เปลี่ยนรหัสผ่านใหม่เรียบร้อยแล้ว');
  } catch (err) {
    showToast(`❌ เกิดข้อผิดพลาดในการเปลี่ยนรหัสผ่าน: ${err.message}`);
  }
}

async function removeUserAccount(userId) {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', id: userId })
  });
  if (res.ok) {
    await fetchAppState();
    showToast('🗑️ ลบบัญชีผู้ใช้งานเรียบร้อย');
  }
}

function renderUsersAndAuditLogs() {
  const usersWrap = document.getElementById('usersListContainer');
  if (usersWrap) {
    const users = appState.users || [];
    usersWrap.innerHTML = users
      .map(u => {
        const isCurrent = currentUser?.username === u.username;
        return `
          <div class="contributor-item" style="margin-bottom:8px;border-color:${isCurrent ? 'var(--primary)' : 'var(--border)'};">
            <div>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <strong style="font-size:14px;">${u.role === 'admin' ? '👑' : '👤'} ${escapeHtml(u.displayName)}</strong>
                <span class="badge-100">@${escapeHtml(u.username)}</span>
                ${isCurrent ? `<span class="badge-50">กำลังใช้งานอยู่</span>` : ''}
              </div>
              <div class="text-muted" style="font-size:11.5px;margin-top:2px;">
                สิทธิ์: ${u.role === 'admin' ? 'เจ้าของระบบ (Admin)' : 'พนักงานคีย์โพย (Staff)'}
              </div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${
                u.username !== 'admin' && !isCurrent
                  ? `<button type="button" class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="removeUserAccount('${escapeJsArg(u.id)}')">ลบ</button>`
                  : ''
              }
            </div>
          </div>
        `;
      })
      .join('');
  }

  const auditTbody = document.getElementById('auditLogsTableBody');
  if (auditTbody) {
    const logs = appState.auditLogs || [];
    if (logs.length === 0) {
      auditTbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted);">ยังไม่มีประวัติการใช้งาน</td></tr>`;
    } else {
      auditTbody.innerHTML = logs
        .map(
          l => `
          <tr>
            <td style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">${formatThaiDateTime(l.timestamp)}</td>
            <td><strong style="color:var(--text-main);">👤 ${escapeHtml(l.actorName || l.actor || 'แอดมิน')}</strong></td>
            <td><span class="badge-100">${escapeHtml(l.actionType || 'ทำรายการ')}</span></td>
            <td style="white-space:normal;max-width:440px;">${escapeHtml(l.detail || '')}</td>
          </tr>
        `
        )
        .join('');
    }
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

const MASKED_SECRET_SENTINEL = '••••••••••••••••••••••••';

function clearMaskedSecretOnFocus(el) {
  if (el && el.value === MASKED_SECRET_SENTINEL) {
    el.value = '';
  }
}

function restoreMaskedSecretOnBlur(el) {
  if (el && !el.value.trim() && el.dataset.hasSaved === '1') {
    el.value = MASKED_SECRET_SENTINEL;
  }
}

function populateSettingsForm() {
  const s = appState.settings || {};
  if (document.getElementById('settingOcrPriorityMode')) {
    document.getElementById('settingOcrPriorityMode').value = s.ocrPriorityMode || 'auto_hybrid';
  }
  document.getElementById('settingGeminiModel').value = s.geminiModel || 'gemini-2.5-pro';
  document.getElementById('settingPermMode').value = s.permutationMode || 'expand';
  document.getElementById('settingCheck11').checked = s.checkMultiplesOf11 !== false;
  if (document.getElementById('settingDrawCutoffTime')) {
    document.getElementById('settingDrawCutoffTime').value = s.drawCutoffTime || '14:30';
    document.getElementById('settingNextDrawOpenTime').value = s.nextDrawOpenTime || '17:00';
    document.getElementById('settingAfterCutoffAction').value = s.afterCutoffAction || 'reject_until_open';
  }

  const secretFields = [
    {
      inputId: 'settingGeminiKey',
      badgeId: 'badgeGeminiKeyStatus',
      isSaved: Boolean(s.hasGeminiApiKey),
      savedPlaceholder: `บันทึกคีย์ไว้แล้ว (${s.geminiApiKeyMasked}) — พิมพ์ทับเพื่อเปลี่ยนคีย์ใหม่`,
      emptyPlaceholder: 'วางรหัส AIzaSy... ที่นี่'
    },
    {
      inputId: 'settingLineToken',
      badgeId: 'badgeLineTokenStatus',
      isSaved: Boolean(s.hasLineToken),
      savedPlaceholder: 'บันทึก Channel Access Token ไว้แล้ว — พิมพ์ทับเพื่อเปลี่ยนใหม่',
      emptyPlaceholder: 'วาง Channel Access Token ของ LINE OA'
    },
    {
      inputId: 'settingLineSecret',
      badgeId: 'badgeLineSecretStatus',
      isSaved: Boolean(s.hasLineSecret),
      savedPlaceholder: 'บันทึก Channel Secret ไว้แล้ว — พิมพ์ทับเพื่อเปลี่ยนใหม่',
      emptyPlaceholder: 'วาง Channel Secret ของ LINE OA'
    }
  ];

  for (const cfg of secretFields) {
    const el = document.getElementById(cfg.inputId);
    const badge = document.getElementById(cfg.badgeId);
    if (el) {
      el.dataset.hasSaved = cfg.isSaved ? '1' : '0';
      el.value = cfg.isSaved ? MASKED_SECRET_SENTINEL : '';
      el.placeholder = cfg.isSaved ? cfg.savedPlaceholder : cfg.emptyPlaceholder;
    }
    if (badge) {
      if (cfg.isSaved) {
        badge.className = 'badge-100';
        badge.textContent = '✅ บันทึกแล้ว';
      } else {
        badge.className = 'hidden';
        badge.textContent = '';
      }
    }
  }
}

function isSubmittedRealSecret(val) {
  return Boolean(val && !val.includes('•') && !/^\*+$/.test(val));
}

async function saveSettingsFromForm() {
  const payload = {
    ocrPriorityMode: document.getElementById('settingOcrPriorityMode')?.value || 'auto_hybrid',
    geminiModel: document.getElementById('settingGeminiModel').value,
    permutationMode: document.getElementById('settingPermMode').value,
    checkMultiplesOf11: document.getElementById('settingCheck11').checked,
    drawCutoffTime: document.getElementById('settingDrawCutoffTime')?.value || '14:30',
    nextDrawOpenTime: document.getElementById('settingNextDrawOpenTime')?.value || '17:00',
    afterCutoffAction: document.getElementById('settingAfterCutoffAction')?.value || 'reject_until_open'
  };

  const newGeminiKey = document.getElementById('settingGeminiKey').value.trim();
  if (isSubmittedRealSecret(newGeminiKey)) payload.geminiApiKey = newGeminiKey;

  const newLineToken = document.getElementById('settingLineToken').value.trim();
  if (isSubmittedRealSecret(newLineToken)) payload.lineChannelAccessToken = newLineToken;

  const newLineSecret = document.getElementById('settingLineSecret').value.trim();
  if (isSubmittedRealSecret(newLineSecret)) payload.lineChannelSecret = newLineSecret;

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    showToast(`❌ ${await readApiError(res, 'ไม่สามารถบันทึกการตั้งค่าได้')}`);
    return;
  }

  await fetchAppState();
  showToast('✅ บันทึกการตั้งค่าและคำนวณยอดรวมใหม่เรียบร้อยแล้ว');
}

async function resetDemoDatabase() {
  const res = await fetch('/api/reset', { method: 'POST' });
  if (!res.ok) {
    showToast(`❌ ${await readApiError(res, 'ไม่สามารถรีเซ็ตข้อมูลได้')}`);
    return;
  }
  selectedLayoffKeys.clear();
  customLayoffAmounts = {};
  selectedCustomerFilter = null;
  await fetchAppState();
  showToast('🔄 รีเซ็ตข้อมูลตัวอย่างเริ่มต้นเรียบร้อยแล้ว');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsArg(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}
