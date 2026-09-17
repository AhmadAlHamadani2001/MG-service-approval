// MG Service Approval — frontend. Plain JS, no build step. State lives in
// one object; every render replaces #app's innerHTML; a single delegated
// listener handles all clicks/submits so we don't re-bind after each render.

const { t } = I18N;

const STATUS_CLASS = {
  PENDING_SALES_APPROVAL: 'chip-pending',
  PENDING_FINANCE_APPROVAL: 'chip-pending',
  UNDER_AFTER_SALES_ESTIMATION: 'chip-estimation',
  RETURNED_TO_SALES: 'chip-return',
  RETURNED_TO_AFTERSALES: 'chip-return',
  APPROVED_IN_AFTER_SALES: 'chip-approved',
  REJECTED: 'chip-rejected',
  CLOSED: 'chip-closed',
};

const state = {
  token: localStorage.getItem('mg_token') || null,
  user: null,
  services: [],
  requests: [],
  demoAccounts: [],
  selectedRequestId: null,
  selectedRequestDetail: null,
  atTab: 'estimation',
  salesTab: 'new',
  catalogFormOpen: false,
  bulkImportOpen: false,
  editingServiceId: null,
  walkinFormOpen: false,
  reviewFilter: null,
  salesRequestsTab: null,
  atActiveSubtab: null,
  loginError: '',
  adminTab: 'catalog',
  branches: [],
  users: [],
  accountFormOpen: false,
  branchFormOpen: false,
  vehicles: [],
  vehicleFormOpen: false,
  editingVehicleId: null,
  vehicleBulkImportOpen: false,
  vehicleImportBusy: false,
  vehicleImportSummary: null,
  vehiclesPage: 1,
  vehiclesPageSize: 50,
  vehiclesTotal: 0,
  vehiclesTotalPages: 1,
  vehiclesSearch: '',
  vinCheckOpen: false,
  vinCheckResult: null,
  vinCheckError: '',
  vinBulkOpen: false,
  vinBulkBusy: false,
  vinBulkResult: null,
  changePasswordOpen: false,
  changePasswordBusy: false,
  changePasswordError: '',
};

// ---------------------------------------------------------------- helpers -

let vehiclesSearchTimer = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) { return Number(n || 0).toFixed(2) + ' SR'; }
function hrs(n) { return Number(n || 0).toFixed(1) + ' ' + t('common.labor_hours'); }
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const locale = I18N.getLang() === 'ar' ? 'ar' : undefined;
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}
function statusChip(status) {
  const cls = STATUS_CLASS[status] || 'chip-pending';
  return `<span class="chip ${cls} shrink-0">${t('status.' + status)}</span>`;
}
function q(sel) { return document.querySelector(sel); }
function qa(sel) { return Array.from(document.querySelectorAll(sel)); }

// Every submit/resubmit action can land at either PENDING_SALES_APPROVAL or
// PENDING_FINANCE_APPROVAL depending on the request's history (see the
// server-side destination logic in requests.js) — so the confirmation toast
// has to reflect where it actually landed rather than assuming Finance.
function submissionToast(status) {
  return status === 'PENDING_FINANCE_APPROVAL' ? t('toast.submitted_finance') : t('toast.submitted_sales_manager');
}

function toast(message, type = 'info') {
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 3900);
}

async function api(path, opts = {}) {
  // A FormData body (used for the vehicle file upload — see
  // handleVehicleBulkImportFile) must NOT get a JSON Content-Type: the
  // browser sets its own multipart boundary header when it sees the body is
  // a FormData instance, and overriding it here would break the upload.
  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers = isFormData ? {} : { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const code = data && data.code;
    const msg = code && I18N.has(`errors.${code}`) ? t(`errors.${code}`) : (data && data.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ------------------------------------------------------------------ boot -

async function boot() {
  try {
    const d = await api('/api/auth/demo-accounts');
    state.demoAccounts = d.accounts;
  } catch (e) { /* non-fatal */ }

  if (!state.token) { render(); return; }
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    await loadCommon();
  } catch (e) {
    state.token = null;
    localStorage.removeItem('mg_token');
  }
  render();
}

// The vehicle table can hold a full dealer-management-system export
// (hundreds of thousands of rows), so this never fetches the whole thing —
// only the current page + search term, mirroring the server's own
// pagination in GET /api/vehicles.
async function loadVehiclesPage() {
  const params = new URLSearchParams({
    page: String(state.vehiclesPage),
    pageSize: String(state.vehiclesPageSize),
  });
  if (state.vehiclesSearch) params.set('search', state.vehiclesSearch);
  const data = await api(`/api/vehicles?${params.toString()}`);
  state.vehicles = data.vehicles;
  state.vehiclesTotal = data.total;
  state.vehiclesTotalPages = data.totalPages;
  state.vehiclesPage = data.page;
}

async function loadCommon() {
  const role = state.user.role;
  if (role === 'AFTER_SALES_ADMIN') {
    const [svc, branches, users] = await Promise.all([
      api('/api/services?includeInactive=true'),
      api('/api/branches'),
      api('/api/users'),
      loadVehiclesPage(),
    ]);
    state.services = svc.services;
    state.branches = branches.branches;
    state.users = users.users;
    state.requests = [];
  } else {
    const [svc, reqs] = await Promise.all([api('/api/services'), api('/api/requests')]);
    state.services = svc.services;
    state.requests = reqs.requests;
  }
  if (state.selectedRequestId) {
    try {
      const d = await api(`/api/requests/${state.selectedRequestId}`);
      state.selectedRequestDetail = d.request;
    } catch (e) {
      state.selectedRequestId = null;
      state.selectedRequestDetail = null;
    }
  }
}

async function refreshAll() {
  await loadCommon();
  render();
}

async function selectRequest(id) {
  state.selectedRequestId = id;
  try {
    const d = await api(`/api/requests/${id}`);
    state.selectedRequestDetail = d.request;
  } catch (e) {
    toast(e.message, 'error');
  }
  render();
}

function clearSelection() {
  state.selectedRequestId = null;
  state.selectedRequestDetail = null;
}

// ------------------------------------------------------------------ auth -

async function login(email, password) {
  state.loginError = '';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    state.token = data.token;
    state.user = data.user;
    resetDashboardUiState();
    localStorage.setItem('mg_token', data.token);
    await loadCommon();
    render();
  } catch (e) {
    state.loginError = e.message;
    render();
  }
}

// UI-only state that's scoped to a particular role's dashboard (which tab is
// open, which stat tile is filtering the list, an open form, etc.) — reset
// whenever the signed-in account changes, so a leftover value from one
// role's page never gets read by a different role's page (e.g. a Finance
// stat-tile key like "estimation" is meaningless — and was crashing —  on
// the Sales Manager dashboard, which doesn't have that stat).
function resetDashboardUiState() {
  state.atTab = 'estimation';
  state.salesTab = 'new';
  state.catalogFormOpen = false;
  state.bulkImportOpen = false;
  state.editingServiceId = null;
  state.walkinFormOpen = false;
  state.reviewFilter = null;
  state.salesRequestsTab = null;
  state.atActiveSubtab = null;
  state.adminTab = 'catalog';
  state.accountFormOpen = false;
  state.branchFormOpen = false;
  state.vehicleFormOpen = false;
  state.editingVehicleId = null;
  state.vehicleBulkImportOpen = false;
  state.vehicleImportBusy = false;
  state.vehicleImportSummary = null;
  state.vehiclesPage = 1;
  state.vehiclesSearch = '';
  state.vinCheckOpen = false;
  state.vinCheckResult = null;
  state.vinCheckError = '';
  state.vinBulkOpen = false;
  state.vinBulkBusy = false;
  state.vinBulkResult = null;
  state.changePasswordOpen = false;
  state.changePasswordBusy = false;
  state.changePasswordError = '';
}

function logout() {
  state.token = null;
  state.user = null;
  state.requests = [];
  state.services = [];
  state.branches = [];
  state.users = [];
  state.vehicles = [];
  clearSelection();
  resetDashboardUiState();
  localStorage.removeItem('mg_token');
  render();
}

// ---------------------------------------------------------------- shell --

function langToggleHtml() {
  const lang = I18N.getLang();
  return `
    <div class="flex rounded-full bg-surface-container p-1 text-[11px] font-semibold">
      <button data-action="set-lang" data-lang="en" class="px-2.5 py-1 rounded-full transition-all ${lang === 'en' ? 'bg-white text-mgred-dark shadow-sm' : 'text-ink/50 hover:text-ink'}">EN</button>
      <button data-action="set-lang" data-lang="ar" class="px-2.5 py-1 rounded-full transition-all ${lang === 'ar' ? 'bg-white text-mgred-dark shadow-sm' : 'text-ink/50 hover:text-ink'}">AR</button>
    </div>
  `;
}

function initials(name) {
  return String(name || '').trim().split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function shellHtml(content) {
  const role = state.user.role;
  return `
    <header class="sticky top-0 z-20 bg-surface/85 backdrop-blur-xl border-b border-black/[0.06] shadow-[0_1px_10px_rgba(20,21,26,0.04)]">
      <div class="max-w-7xl mx-auto px-g4 sm:px-g5 py-g3 flex items-center justify-between gap-g3">
        <div class="flex items-center gap-g3 min-w-0">
          <div class="w-10 h-10 rounded-xl bg-white p-1 flex items-center justify-center overflow-hidden shrink-0 shadow-sm border border-black/[0.06]">
            <img src="/assets/mg-octagon-logo.jpg" alt="MG" class="w-full h-full object-contain rounded-lg">
          </div>
          <div class="leading-tight min-w-0">
            <strong class="font-display font-bold text-[15px] block truncate" style="color:var(--ink)">${t('app.name')}</strong>
            <span class="text-[11px] text-soft block truncate">${t('topbar.workspace_' + role)}</span>
          </div>
        </div>
        <div class="flex items-center gap-g2 sm:gap-g3 shrink-0">
          ${langToggleHtml()}
          <div class="hidden md:flex items-center gap-2 bg-surface-container-low rounded-full ps-1.5 pe-3.5 py-1.5 whitespace-nowrap">
            <span class="avatar-circle">${esc(initials(state.user.fullName))}</span>
            <span class="text-[12.5px] leading-tight" style="color:var(--ink)">${esc(state.user.fullName)}<br><span class="text-[10.5px] text-soft">${t('role.' + role)}</span></span>
          </div>
          <button data-action="toggle-vin-check" class="flex items-center gap-1.5 text-[12.5px] font-semibold rounded-full px-3.5 py-2 transition-colors whitespace-nowrap ${state.vinCheckOpen ? 'bg-mgred text-white' : 'bg-surface-container hover:bg-surface-container-high'}" style="${state.vinCheckOpen ? '' : 'color:var(--ink)'}">
            <span class="material-symbols-outlined text-[16px]">directions_car</span>
            <span class="hidden sm:inline">${t('vin.button')}</span>
          </button>
          <button data-action="open-change-password" class="flex items-center gap-1.5 text-[12.5px] font-semibold bg-surface-container rounded-full px-3.5 py-2 hover:bg-surface-container-high transition-colors whitespace-nowrap" style="color:var(--ink)">
            <span class="material-symbols-outlined text-[16px]">key</span>
            <span class="hidden sm:inline">${t('account.change_password')}</span>
          </button>
          <button data-action="logout" class="flex items-center gap-1.5 text-[12.5px] font-semibold bg-surface-container rounded-full px-3.5 py-2 hover:bg-surface-container-high transition-colors whitespace-nowrap" style="color:var(--ink)">
            <span class="material-symbols-outlined text-[16px]">logout</span>
            <span class="hidden sm:inline">${t('common.logout')}</span>
          </button>
        </div>
      </div>
    </header>
    <main class="max-w-7xl mx-auto px-g4 sm:px-g5 py-g5 animate-in">${content}</main>
  `;
}

function loginHtml() {
  const lang = I18N.getLang();
  const accounts = state.demoAccounts.map(a => `
    <button class="w-full text-start flex items-center gap-3 px-g3 py-g3 rounded-xl border border-black/[0.07] bg-surface-container-low hover:border-mgred/50 hover:bg-mgred/[0.06] transition-all mb-2" type="button" data-action="demo-login" data-email="${esc(a.email)}" data-password="${esc(a.password)}">
      <span class="avatar-circle">${esc(initials(a.fullName))}</span>
      <span class="text-[13px] flex-1 min-w-0">${esc(a.fullName)}<br><span class="text-[11.5px] text-ink/45">${esc(a.email)}</span></span>
      <span class="text-[10.5px] font-bold uppercase tracking-wide text-mgred-dark shrink-0">${t('role.' + a.role)}</span>
    </button>
  `).join('');
  return `
    <div class="min-h-screen flex items-center justify-center p-g4 relative">
      <div class="absolute top-g4 sm:top-g5 end-g4 sm:end-g5">
        <div class="flex rounded-full p-1 text-[11px] font-semibold" style="background:rgba(20,21,26,0.06);">
          <button data-action="set-lang" data-lang="en" class="px-2.5 py-1 rounded-full transition-colors ${lang === 'en' ? 'bg-mgred text-white' : 'text-ink/60'}">EN</button>
          <button data-action="set-lang" data-lang="ar" class="px-2.5 py-1 rounded-full transition-colors ${lang === 'ar' ? 'bg-mgred text-white' : 'text-ink/60'}">AR</button>
        </div>
      </div>
      <div class="w-full max-w-md glass glow-border rounded-xl2 p-g6 animate-in-pop">
        <div class="flex items-center gap-3 mb-g5">
          <div class="w-12 h-12 rounded-xl bg-white p-1 shrink-0 border border-black/[0.06] shadow-sm">
            <img src="/assets/mg-octagon-logo.jpg" alt="MG" class="w-full h-full object-contain rounded-lg">
          </div>
          <div>
            <strong class="font-display font-bold text-[16px] block">${t('app.name')}</strong>
            <span class="text-[12px] text-soft">${t('app.tagline')}</span>
          </div>
        </div>
        <h1 class="font-display text-[20px] font-bold mb-1">${t('login.title')}</h1>
        <p class="text-[13.5px] text-soft mb-g5">${t('login.subtitle')}</p>
        ${state.loginError ? `<div class="bg-rose-50 text-rose-700 border border-rose-200 rounded-lg px-3 py-2.5 text-[13px] mb-g4">${esc(state.loginError)}</div>` : ''}
        <form data-action="login-submit" class="space-y-g3">
          <div>
            <label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('login.email')}</label>
            <input type="email" id="login-email" required autocomplete="username" class="field-input" dir="ltr">
          </div>
          <div>
            <label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('login.password')}</label>
            <input type="password" id="login-password" required autocomplete="current-password" class="field-input" dir="ltr">
          </div>
          <button class="btn btn-primary w-full" type="submit">
            <span>${t('login.signin')}</span>
            <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
          </button>
        </form>
        <div class="mt-g5 pt-g4 border-t border-black/10">
          <div class="text-[11px] uppercase tracking-wide text-soft font-semibold mb-g3">${t('login.demo_hint')}</div>
          <div class="stagger">${accounts}</div>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------- shared bits --

function panelOpen(title, sub) {
  return `<div class="mb-g4"><div class="font-display font-semibold text-[15px]">${title}</div>${sub ? `<div class="text-[12px] text-soft mt-0.5">${sub}</div>` : ''}</div>`;
}

function renderTimeline(history) {
  if (!history || !history.length) return '';
  const rows = history.slice().reverse().map((h, idx) => `
    <div class="flex gap-2.5 py-1.5 ${idx !== history.length - 1 ? 'border-s-2 border-black/10 ms-[3px] ps-3' : 'ps-3 ms-[3px]'} relative">
      <div class="absolute -start-[5px] top-2 w-2 h-2 rounded-full ${idx === 0 ? 'bg-mgred' : 'bg-black/20'}"></div>
      <div class="text-[12px] text-soft">
        <strong class="text-[13px]" style="color:var(--glass-text)">${esc(h.action.replace(/_/g, ' '))}</strong>
        ${t('common.by')} ${esc(h.actor ? h.actor.fullName : 'system')}${h.actor ? ` <span class="text-[10.5px] text-soft/70">(${esc(t('role.' + h.actor.role))})</span>` : ''}
        ${h.comment ? '— ' + esc(h.comment) : ''}
        <span class="block text-[11px] text-soft/70 mt-0.5">${fmtDate(h.createdAt)}</span>
      </div>
    </div>
  `).join('');
  return `<div class="mt-g4"><div class="text-[11px] font-semibold uppercase tracking-wide text-soft mb-g2">${t('common.activity')}</div>${rows}</div>`;
}

function renderComments(request) {
  const comments = request.comments || [];
  const rows = comments.map(c => `
    <div class="text-[12.5px] py-2 border-b border-black/10 last:border-0">
      <span class="font-semibold" style="color:var(--glass-text)">${esc(c.author ? c.author.fullName : '—')}</span>
      ${c.author ? `<span class="text-[10.5px] text-soft/70"> · ${esc(t('role.' + c.author.role))}</span>` : ''}
      <span class="text-soft"> · ${fmtDate(c.createdAt)}</span>
      <div class="text-soft mt-0.5">${esc(c.text)}</div>
    </div>
  `).join('');
  return `
    <div class="mt-g4 pt-g4 border-t border-black/10">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-soft mb-g2">${t('common.comments')} ${comments.length ? `(${comments.length})` : ''}</div>
      ${rows}
      <div class="flex gap-2 mt-g3">
        <input type="text" id="new-comment-text" placeholder="${t('common.comment_placeholder')}" class="field-input flex-1">
        <button class="btn btn-ghost btn-sm shrink-0" data-action="add-comment" data-id="${request.id}">${t('common.add_comment')}</button>
      </div>
    </div>
  `;
}

function catalogChecklist(prefix, activeServices, checkedMap) {
  checkedMap = checkedMap || {};
  return activeServices.map(s => {
    const searchText = esc(`${s.description} ${s.serviceCode} ${s.category || ''}`.toLowerCase());
    return `
    <label class="catalog-row" data-service-row="${s.id}" data-search="${searchText}">
      <input type="checkbox" class="${prefix}-check" data-service-id="${s.id}" data-price="${s.price}" data-hours="${s.laborHours}" ${checkedMap[s.id] ? 'checked' : ''}>
      <span class="flex-1 min-w-0">
        <span class="block text-[13px]">${esc(s.description)}</span>
        <span class="block text-[11px] text-soft">${esc(s.serviceCode)} · ${esc(s.category || 'General')}</span>
      </span>
      <input type="number" class="${prefix}-qty w-14 rounded-lg border border-black/10 bg-black/[0.03] text-center text-[12px] py-1" data-service-id="${s.id}" value="${checkedMap[s.id] || 1}" min="1" style="display:${checkedMap[s.id] ? 'block' : 'none'};">
      <span class="text-[13px] font-semibold whitespace-nowrap">${money(s.price)}</span>
    </label>
  `;
  }).join('');
}

// Live client-side filter — hides non-matching rows without touching state
// or triggering a re-render, so the search input never loses focus/keystrokes.
function filterRowsBySearch(containerId, rowSelector, query) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const q = query.trim().toLowerCase();
  container.querySelectorAll(rowSelector).forEach(row => {
    const hay = row.dataset.search || '';
    row.classList.toggle('hidden', !!q && !hay.includes(q));
  });
}

// Renders one request line item. Removed/deleted lines (e.g. an item the
// Aftersales Team took off during estimation) stay visible but greyed out
// with a "Deleted" label instead of disappearing, so everyone reviewing the
// request can see what changed.
function renderItemRow(i) {
  const removed = i.itemStatus === 'REMOVED';
  if (removed) {
    return `
      <div class="flex items-start justify-between gap-3 py-2.5 border-b border-black/10 last:border-0 opacity-40">
        <div class="flex-1 min-w-0">
          <div class="text-[13px] line-through">${esc(i.service.description)} <span class="text-soft text-[11.5px]">${esc(i.service.serviceCode)} × ${i.quantity}</span></div>
          <div class="text-[10.5px] font-semibold uppercase tracking-wide text-rose-500 mt-0.5">${t('common.deleted')}</div>
        </div>
        <span class="tabular-nums text-[13px] shrink-0 line-through">${money(i.lineTotal)}</span>
      </div>`;
  }
  return `
    <div class="flex justify-between text-[12.5px] py-1.5 border-b border-black/10 last:border-0">
      <span>${esc(i.service.description)} <span class="text-soft">${esc(i.service.serviceCode)} × ${i.quantity}</span>${i.source !== 'ORIGINAL' ? `<span class="ms-1.5 text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-300">${esc(i.source.replace(/_/g, ' '))}</span>` : ''}</span>
      <span class="tabular-nums">${money(i.lineTotal)}</span>
    </div>`;
}

// A closed-out case (successfully delivered, or rejected along the way) is
// "history" — done, not something anyone needs to act on or track anymore.
const HISTORY_STATUSES = ['CLOSED', 'REJECTED'];

// A small provenance tag — only meaningful on the Aftersales Team page,
// where a case in front of them might be a regular Sales request or one
// they created themselves as a walk-in.
function originNote(r) {
  return `<span class="text-[9.5px] font-semibold uppercase tracking-wide text-ink/40 shrink-0">${r.origin === 'WALK_IN' ? t('at.created_by_aftersales') : t('at.created_by_sales')}</span>`;
}

// A small "submitted by X" tag — relevant wherever a case list now spans a
// whole branch team rather than just one person's own submissions, so it's
// clear at a glance whose request each row is.
function submitterNote(r) {
  return `<span class="text-[9.5px] font-semibold uppercase tracking-wide text-ink/40 shrink-0">${t('common.by')} ${esc(r.submittedBy ? r.submittedBy.fullName : '')}</span>`;
}

// One row in a shared case list ("Branch Requests", "Active Cases").
// leadWithVin matches the VIN-first convention used elsewhere on the
// Aftersales Team page. showOrigin adds the "Created by: Sales/Aftersales"
// note, relevant only where a list can mix both origins. showSubmitter adds
// the "by <name>" tag, relevant only where a list can mix multiple people's
// submissions (a branch-wide list rather than one person's own).
function caseRow(r, { leadWithVin = false, showOrigin = false, showSubmitter = false } = {}) {
  const lead = leadWithVin ? r.vin : r.requestNumber;
  const trail = leadWithVin ? r.requestNumber : r.vin;
  return `
    <div class="flex items-center gap-3 p-3 rounded-xl border flex-wrap ${r.id === state.selectedRequestId ? 'border-mgred bg-mgred/10' : 'border-black/10 bg-black/[0.02] hover:border-black/20'} cursor-pointer transition-all hover:-translate-y-0.5" data-action="select-request" data-id="${r.id}" data-search="${esc((r.vin + ' ' + r.requestNumber).toLowerCase())}">
      <span class="font-mono ${leadWithVin ? 'text-[12.5px] font-semibold' : 'text-[12px]'} w-32 shrink-0 truncate">${esc(lead)}</span>
      <span class="font-mono text-[11px] text-soft w-24 shrink-0 truncate">${esc(trail)}</span>
      <span class="text-[12px] text-soft flex-1 min-w-0 truncate">${esc(r.vehicleModel || '')}</span>
      ${showSubmitter ? submitterNote(r) : ''}
      ${showOrigin ? originNote(r) : ''}
      ${statusChip(r.status)}
    </div>`;
}

// Splits a case list into three status-based tabs, same shape wherever a
// page shows "cases relevant to this viewer": cases waiting on this
// person's own action first, everything else still in progress next, and
// closed-out cases last — as tabs rather than stacked sections, so a long
// list stays readable instead of crowding the panel. needsActionFilter
// decides the first bucket — a predicate rather than a bare status list, so
// a shared branch-wide list can require both a status AND that this viewer
// is the one who can actually act on it (see renderSales()).
function caseSectionsHtml(list, { needsActionFilter, needsActionLabel, activeTab, tabChangeAction, emptyText, leadWithVin = false, showOrigin = false, showSubmitter = false }) {
  const needsAction = list.filter(needsActionFilter);
  const history = list.filter(r => HISTORY_STATUSES.includes(r.status));
  const inProgress = list.filter(r => !needsActionFilter(r) && !HISTORY_STATUSES.includes(r.status));

  if (!needsAction.length && !inProgress.length && !history.length) {
    return `<div class="text-center text-soft text-[13px] py-g6">${emptyText}</div>`;
  }

  const tabs = [
    { key: 'needs', label: needsActionLabel, items: needsAction },
    { key: 'progress', label: t('common.in_progress'), items: inProgress },
    { key: 'history', label: t('common.cases_history'), items: history },
  ];
  const effective = tabs.find(tb => tb.key === activeTab) ? activeTab : (needsAction.length ? 'needs' : inProgress.length ? 'progress' : 'history');

  const tabBar = `
    <div class="tab-pill-wrap mb-g3">
      ${tabs.map(tb => `<button type="button" class="tab-btn ${effective === tb.key ? 'active' : ''}" data-action="${tabChangeAction}" data-subtab="${tb.key}">${esc(tb.label)} (${tb.items.length})</button>`).join('')}
    </div>`;

  const activeItems = tabs.find(tb => tb.key === effective).items;
  const body = activeItems.length
    ? `<div class="space-y-2 stagger">${activeItems.map(r => caseRow(r, { leadWithVin, showOrigin, showSubmitter })).join('')}</div>`
    : `<div class="text-center text-soft text-[12.5px] py-g5">${t('common.no_cases_in_tab')}</div>`;

  return tabBar + body;
}

// -------------------------------------------------------------- sales UI --

function renderSales() {
  const activeServices = state.services.filter(s => s.isActive);
  // state.requests is already scoped server-side to this account's branch
  // (see canView() in requests.js) — every Sales Rep on the same branch team
  // sees the same list here, not just their own submissions.
  const branchRequests = state.requests;
  const myOwnRequests = branchRequests.filter(r => r.submittedBy && r.submittedBy.id === state.user.id);
  // Approving submitted requests is the Sales Manager's job now — a Sales
  // Rep's "pending with me" queue is just their own requests that were sent
  // back for correction. Resubmitting stays owner-only even though viewing
  // is now branch-wide, so this list is deliberately myOwnRequests, not
  // branchRequests.
  const pendingWithMe = myOwnRequests.filter(r => r.status === 'RETURNED_TO_SALES')
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const catalogRows = catalogChecklist('nr', activeServices);

  const sel = state.selectedRequestDetail;
  let detailPanel = '';
  if (sel && sel.status === 'RETURNED_TO_SALES' && sel.submittedBy && sel.submittedBy.id === state.user.id) {
    detailPanel = renderResubmitForm(sel, activeServices);
  } else if (sel && branchRequests.some(r => r.id === sel.id)) {
    detailPanel = renderReadOnlyDetail(sel);
  }

  const tabsBar = `
    <div class="tab-pill-wrap mb-g4">
      <button class="tab-btn ${state.salesTab !== 'my' ? 'active' : ''}" data-action="sales-tab" data-tab="new">${t('sales.tab_new')}</button>
      <button class="tab-btn ${state.salesTab === 'my' ? 'active' : ''}" data-action="sales-tab" data-tab="my">${t('sales.tab_my', { n: branchRequests.length })}</button>
    </div>
  `;

  return tabsBar + (state.salesTab === 'my'
    ? renderSalesMyRequestsTab(branchRequests, detailPanel)
    : renderSalesNewRequestTab(catalogRows, pendingWithMe, detailPanel));
}

function renderSalesNewRequestTab(catalogRows, pendingWithMe, detailPanel) {
  const pendingRows = pendingWithMe.length ? pendingWithMe.map(r => `
    <div class="flex items-center gap-3 p-3 rounded-xl border flex-wrap ${r.id === state.selectedRequestId ? 'border-mgred bg-mgred/10' : 'border-black/10 bg-black/[0.02] hover:border-black/20'} cursor-pointer transition-all hover:-translate-y-0.5" data-action="select-request" data-id="${r.id}">
      <span class="font-mono text-[12px] w-32 shrink-0">${esc(r.requestNumber)}</span>
      <span class="font-mono text-[11px] text-soft w-24 shrink-0 truncate">${esc(r.vin)}</span>
      <span class="text-[12px] text-soft flex-1 min-w-0 truncate">${esc(r.vehicleModel || '')}</span>
      ${statusChip(r.status)}
    </div>
  `).join('') : `<div class="text-center text-soft text-[13px] py-g5">${t('sales.no_pending')}</div>`;

  return `
    <div class="grid grid-cols-1 lg:grid-cols-[38.2%_1fr] gap-g5 lg-grid-2">
      <div class="glass glow-border rounded-xl2 p-g5">
        ${panelOpen(t('sales.new_request_title'), t('sales.new_request_sub'))}
        <div class="space-y-g3">
          <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('common.vin')}</label><input type="text" id="nr-vin" dir="ltr" class="field-input uppercase"></div>
          <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.vehicle_model')}</label><input type="text" id="nr-model" class="field-input"></div>
          <div>
            <label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.services')}</label>
            <input type="text" id="nr-search" data-search-target="nr-catalog" class="field-input mb-1.5" placeholder="${t('sales.search_services_placeholder')}">
            <div class="flex flex-col gap-1.5 max-h-72 overflow-y-auto pe-1" id="nr-catalog">${catalogRows}</div>
          </div>
          <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.notes')}</label><textarea id="nr-notes" placeholder="${t('sales.notes_placeholder')}" class="field-input w-full min-h-[64px]"></textarea></div>
        </div>
        <div class="flex justify-between items-center mt-g3 pt-g3 border-t border-dashed border-black/10" id="nr-totals"></div>
        <button class="btn btn-primary w-full mt-g4" data-action="submit-new-request">${t('sales.submit_btn')}<span class="material-symbols-outlined text-[16px]">arrow_forward</span></button>
      </div>
      <div class="space-y-g5">
        <div class="glass glow-border rounded-xl2 p-g5">
          ${panelOpen(t('sales.pending_title'), t('sales.pending_sub'))}
          <div class="space-y-2 stagger">${pendingRows}</div>
        </div>
        ${detailPanel}
      </div>
    </div>
  `;
}

// branchRequests spans everyone on this account's branch, not just their
// own submissions (see renderSales()) — so "needs your action" has to check
// ownership too, not just status, or a teammate's returned request would
// show up in a bucket this viewer can't actually act on.
function renderSalesMyRequestsTab(branchRequests, detailPanel) {
  const listHtml = caseSectionsHtml(branchRequests, {
    needsActionFilter: r => r.status === 'RETURNED_TO_SALES' && r.submittedBy && r.submittedBy.id === state.user.id,
    needsActionLabel: t('common.needs_your_action'),
    activeTab: state.salesRequestsTab,
    tabChangeAction: 'sales-requests-subtab',
    emptyText: t('sales.no_requests'),
    showSubmitter: true,
  });

  return `
    <div class="grid grid-cols-1 lg:grid-cols-[38.2%_1fr] gap-g5 lg-grid-2">
      <div class="glass glow-border rounded-xl2 p-g5">
        ${panelOpen(t('sales.my_requests'), t('sales.my_requests_sub', { n: branchRequests.length }))}
        <input type="text" id="my-requests-search" data-search-target="my-requests-list" class="field-input mb-g3" placeholder="${t('sales.search_vin_placeholder')}">
        <div id="my-requests-list">${listHtml}</div>
      </div>
      <div>${detailPanel || `<div class="glass glow-border rounded-xl2 p-g5"><div class="text-center text-soft text-[13px] py-g6">${t('sales.select_hint')}</div></div>`}</div>
    </div>
  `;
}

function renderReadOnlyDetail(r) {
  return `
    <div class="glass glow-border rounded-xl2 p-g5">
      <div class="flex items-center justify-between mb-1"><span class="font-display font-semibold text-[15px]">${esc(r.requestNumber)}</span>${statusChip(r.status)}</div>
      <div class="text-[12px] text-soft mb-g3">${esc(r.vin)} ${r.vehicleModel ? '· ' + esc(r.vehicleModel) : ''}</div>
      ${r.items.map(renderItemRow).join('')}
      <div class="flex justify-between text-[13px] pt-2 font-semibold"><span>${t('common.total')} · ${hrs(r.totalLaborHours)}</span><span class="tabular-nums">${money(r.totalPrice)}</span></div>
      ${renderTimeline(r.history)}
      ${renderComments(r)}
    </div>
  `;
}

function renderResubmitForm(r, activeServices) {
  const currentServiceIds = {};
  r.items.filter(i => i.itemStatus === 'ACTIVE').forEach(i => { currentServiceIds[i.service.id] = i.quantity; });
  const rows = catalogChecklist('rs', activeServices, currentServiceIds);
  return `
    <div class="glass glow-border rounded-xl2 p-g5">
      ${panelOpen(`${t('sales.correct_title')} ${esc(r.requestNumber)}`)}
      <div class="text-[12.5px] mb-g3" style="color:#b8590c;">${t('sales.finance_said')}: "${esc(r.returnReason || '')}"</div>
      <div class="space-y-g3">
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('common.vin')}</label><input type="text" id="rs-vin" value="${esc(r.vin)}" dir="ltr" class="field-input uppercase"></div>
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.vehicle_model')}</label><input type="text" id="rs-model" value="${esc(r.vehicleModel || '')}" class="field-input"></div>
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.services')}</label><div class="flex flex-col gap-1.5 max-h-72 overflow-y-auto pe-1" id="rs-catalog">${rows}</div></div>
      </div>
      <div class="flex justify-between items-center mt-g3 pt-g3 border-t border-dashed border-black/10" id="rs-totals"></div>
      <button class="btn btn-primary w-full mt-g4" data-action="submit-resubmit" data-id="${r.id}">${t('sales.submit_btn')}<span class="material-symbols-outlined text-[16px]">arrow_forward</span></button>
    </div>
  `;
}

// ------------------------------------------------------- sales manager UI --

const SALES_MANAGER_STAT_STATUSES = {
  pending: ['PENDING_SALES_APPROVAL'],
  with_finance: ['PENDING_FINANCE_APPROVAL'],
  returned: ['RETURNED_TO_SALES', 'RETURNED_TO_AFTERSALES'],
  approved: ['APPROVED_IN_AFTER_SALES', 'CLOSED'],
};

function renderSalesManager() {
  const pending = state.requests.filter(r => r.status === 'PENDING_SALES_APPROVAL');
  const withFinance = state.requests.filter(r => r.status === 'PENDING_FINANCE_APPROVAL');
  const returned = state.requests.filter(r => r.status === 'RETURNED_TO_SALES' || r.status === 'RETURNED_TO_AFTERSALES');
  const approved = state.requests.filter(r => r.status === 'APPROVED_IN_AFTER_SALES' || r.status === 'CLOSED');

  const filterKey = state.reviewFilter;
  const isReviewing = filterKey && filterKey !== 'pending';
  const listSource = isReviewing
    ? state.requests.filter(r => (SALES_MANAGER_STAT_STATUSES[filterKey] || []).includes(r.status))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    : pending;

  const rows = listSource.length ? listSource.map(r => `
    <div class="flex items-center gap-3 p-3 rounded-xl border flex-wrap ${r.id === state.selectedRequestId ? 'border-mgred bg-mgred/10' : 'border-black/10 bg-black/[0.02] hover:border-black/20'} cursor-pointer transition-all hover:-translate-y-0.5" data-action="select-request" data-id="${r.id}">
      <span class="font-mono text-[12px] w-32 shrink-0">${esc(r.requestNumber)}</span>
      <span class="font-mono text-[11px] text-soft w-24 shrink-0 truncate">${esc(r.vin)}</span>
      <span class="text-[12px] text-soft flex-1 min-w-0 truncate">${esc(r.vehicleModel || '')} · ${esc(r.submittedBy ? r.submittedBy.fullName : '')}</span>
      ${isReviewing ? statusChip(r.status) : ''}
      ${r.branch ? `<span class="text-[9.5px] font-semibold uppercase tracking-wide text-ink/40 shrink-0 font-mono">${esc(r.branch.code)}</span>` : ''}
      <span class="text-[10px] font-bold uppercase tracking-wide ${r.origin === 'WALK_IN' ? 'text-amber-300' : 'text-ink/40'} shrink-0">${r.origin === 'WALK_IN' ? t('finance.origin_walkin') : ''}</span>
      <span class="text-[12.5px] font-semibold tabular-nums shrink-0">${money(r.totalPrice)}</span>
    </div>
  `).join('') : `<div class="text-center text-soft text-[13px] py-g6">${t('finance.empty_queue')}</div>`;

  const sel = state.selectedRequestDetail;
  const detail = sel && sel.status === 'PENDING_SALES_APPROVAL' && !isReviewing
    ? renderSalesManagerDetail(sel)
    : sel && listSource.some(r => r.id === sel.id)
      ? renderReadOnlyDetail(sel)
      : `<div class="glass glow-border rounded-xl2 p-g5"><div class="text-center text-soft text-[13px] py-g6">${t('finance.select_hint')}</div></div>`;

  return `
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-g5 stagger">
      ${statTile('pending', pending.length, t('sm.stat_pending'), filterKey)}
      ${statTile('with_finance', withFinance.length, t('sm.stat_with_finance'), filterKey)}
      ${statTile('returned', returned.length, t('finance.stat_returned'), filterKey)}
      ${statTile('approved', approved.length, t('finance.stat_approved'), filterKey)}
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-[38.2%_1fr] gap-g5 lg-grid-2">
      <div class="glass glow-border rounded-xl2 p-g5">
        ${panelOpen(isReviewing ? t('common.reviewing_cases') : t('sm.queue_title'), isReviewing ? '' : t('sm.queue_sub'))}
        ${isReviewing ? `<button class="btn btn-ghost btn-sm mb-g3" data-action="stat-filter" data-key="pending">${t('common.back_to_queue')}</button>` : ''}
        <div class="space-y-2 stagger">${rows}</div>
      </div>
      <div>${detail}</div>
    </div>
  `;
}

function renderSalesManagerDetail(r) {
  const isWalkIn = r.origin === 'WALK_IN';
  const activeCount = r.items.filter(i => i.itemStatus === 'ACTIVE').length;
  const finalApproval = r.approvalLevel === 'SALES_MANAGER';
  return `
    <div class="glass glow-border rounded-xl2 p-g5">
      <div class="flex items-center justify-between mb-1 flex-wrap gap-2">
        <span class="font-display font-semibold text-[15px]">${esc(r.requestNumber)} · ${esc(r.vin)}</span>
        <span class="text-[10.5px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${isWalkIn ? 'bg-amber-400/15 text-amber-300' : 'bg-black/[0.05] text-ink/60'}">${isWalkIn ? t('finance.origin_walkin') : t('finance.origin_sales')}</span>
      </div>
      <div class="text-[12px] text-soft mb-g3">${t('finance.submitted_by')} ${esc(r.submittedBy ? r.submittedBy.fullName : '—')}${r.branch ? ' · ' + esc(r.branch.code) + ' ' + esc(r.branch.name) : ''} · ${activeCount} item(s)</div>
      <div class="text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-lg inline-block mb-g3 ${finalApproval ? 'bg-emerald-400/15 text-emerald-600' : 'bg-amber-400/15 text-amber-600'}">${finalApproval ? t('sm.final_approval') : t('sm.needs_finance')}</div>
      ${r.items.map(renderItemRow).join('')}
      <div class="flex justify-between text-[13px] pt-2 font-semibold"><span>${t('common.total')} · ${hrs(r.totalLaborHours)}</span><span class="tabular-nums">${money(r.totalPrice)}</span></div>
      <div class="mt-g3"><textarea id="sm-note" placeholder="${t('finance.note_label')}" class="field-input w-full min-h-[64px]"></textarea></div>
      <div class="flex flex-wrap gap-2 mt-g3">
        <button class="btn btn-approve" data-action="sm-approve" data-id="${r.id}"><span class="material-symbols-outlined text-[16px]">check</span>${t('sales.approve')}</button>
        <button class="btn btn-warn" data-action="sm-return" data-id="${r.id}"><span class="material-symbols-outlined text-[16px]">assignment_return</span>${isWalkIn ? t('sales.return_aftersales') : t('sales.return_sales')}</button>
        <button class="btn btn-danger" data-action="sm-reject" data-id="${r.id}"><span class="material-symbols-outlined text-[16px]">close</span>${t('sales.reject')}</button>
      </div>
      ${renderTimeline(r.history)}
      ${renderComments(r)}
    </div>
  `;
}

// ------------------------------------------------------------ finance UI --

const FINANCE_STAT_STATUSES = {
  pending: ['PENDING_FINANCE_APPROVAL'],
  estimation: ['UNDER_AFTER_SALES_ESTIMATION'],
  returned: ['RETURNED_TO_SALES', 'RETURNED_TO_AFTERSALES'],
  approved: ['APPROVED_IN_AFTER_SALES', 'CLOSED'],
};

function statTile(key, count, label, activeFilter) {
  const active = activeFilter === key;
  const highlight = key === 'pending';
  return `<button type="button" class="card-light rounded-2xl p-g4 text-start transition-all ${highlight ? 'stat-accent' : ''} ${active ? 'ring-2 ring-mgred' : 'hover:-translate-y-0.5'}" data-action="stat-filter" data-key="${key}">
    <div class="font-display font-bold text-[24px] ${highlight ? 'text-mgred' : ''}" data-count="${count}">0</div>
    <div class="text-[11px] text-ink/50 uppercase tracking-wide mt-1">${label}</div>
  </button>`;
}

// Small count-up on stat tiles whenever render() paints them — a light
// touch of motion on numbers people check at a glance. Skipped entirely
// under prefers-reduced-motion (the CSS handles that for transitions/
// animations, but this is a JS-driven rAF loop so it needs its own check).
function animateCounts() {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  qa('[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10) || 0;
    if (reduceMotion || target === 0) { el.textContent = String(target); return; }
    const start = performance.now();
    const duration = 480;
    function tick(now) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(eased * target));
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function renderFinance() {
  const pending = state.requests.filter(r => r.status === 'PENDING_FINANCE_APPROVAL');
  const estimation = state.requests.filter(r => r.status === 'UNDER_AFTER_SALES_ESTIMATION');
  const returned = state.requests.filter(r => r.status === 'RETURNED_TO_SALES' || r.status === 'RETURNED_TO_AFTERSALES');
  const approved = state.requests.filter(r => r.status === 'APPROVED_IN_AFTER_SALES' || r.status === 'CLOSED');

  const filterKey = state.reviewFilter;
  const isReviewing = filterKey && filterKey !== 'pending';
  const listSource = isReviewing
    ? state.requests.filter(r => (FINANCE_STAT_STATUSES[filterKey] || []).includes(r.status))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    : pending;

  const rows = listSource.length ? listSource.map(r => `
    <div class="flex items-center gap-3 p-3 rounded-xl border flex-wrap ${r.id === state.selectedRequestId ? 'border-mgred bg-mgred/10' : 'border-black/10 bg-black/[0.02] hover:border-black/20'} cursor-pointer transition-all hover:-translate-y-0.5" data-action="select-request" data-id="${r.id}">
      <span class="font-mono text-[12px] w-32 shrink-0">${esc(r.requestNumber)}</span>
      <span class="font-mono text-[11px] text-soft w-24 shrink-0 truncate">${esc(r.vin)}</span>
      <span class="text-[12px] text-soft flex-1 min-w-0 truncate">${esc(r.vehicleModel || '')} · ${esc(r.submittedBy ? r.submittedBy.fullName : '')}</span>
      ${isReviewing ? statusChip(r.status) : ''}
      ${r.branch ? `<span class="text-[9.5px] font-semibold uppercase tracking-wide text-ink/40 shrink-0 font-mono">${esc(r.branch.code)}</span>` : ''}
      <span class="text-[10px] font-bold uppercase tracking-wide ${r.origin === 'WALK_IN' ? 'text-amber-300' : 'text-ink/40'} shrink-0">${r.origin === 'WALK_IN' ? t('finance.origin_walkin') : ''}</span>
      <span class="text-[12.5px] font-semibold tabular-nums shrink-0">${money(r.totalPrice)}</span>
    </div>
  `).join('') : `<div class="text-center text-soft text-[13px] py-g6">${t('finance.empty_queue')}</div>`;

  const sel = state.selectedRequestDetail;
  const detail = sel && sel.status === 'PENDING_FINANCE_APPROVAL' && !isReviewing
    ? renderFinanceDetail(sel)
    : sel && listSource.some(r => r.id === sel.id)
      ? renderReadOnlyDetail(sel)
      : `<div class="glass glow-border rounded-xl2 p-g5"><div class="text-center text-soft text-[13px] py-g6">${t('finance.select_hint')}</div></div>`;

  return `
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-g5 stagger">
      ${statTile('pending', pending.length, t('finance.stat_pending'), filterKey)}
      ${statTile('estimation', estimation.length, t('finance.stat_estimation'), filterKey)}
      ${statTile('returned', returned.length, t('finance.stat_returned'), filterKey)}
      ${statTile('approved', approved.length, t('finance.stat_approved'), filterKey)}
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-[38.2%_1fr] gap-g5 lg-grid-2">
      <div class="glass glow-border rounded-xl2 p-g5">
        ${panelOpen(isReviewing ? t('common.reviewing_cases') : t('finance.queue_title'), isReviewing ? '' : t('finance.queue_sub'))}
        ${isReviewing ? `<button class="btn btn-ghost btn-sm mb-g3" data-action="stat-filter" data-key="pending">${t('common.back_to_queue')}</button>` : ''}
        <div class="space-y-2 stagger">${rows}</div>
      </div>
      <div>${detail}</div>
    </div>
  `;
}

function renderFinanceDetail(r) {
  const isWalkIn = r.origin === 'WALK_IN';
  const activeCount = r.items.filter(i => i.itemStatus === 'ACTIVE').length;
  return `
    <div class="glass glow-border rounded-xl2 p-g5">
      <div class="flex items-center justify-between mb-1 flex-wrap gap-2">
        <span class="font-display font-semibold text-[15px]">${esc(r.requestNumber)} · ${esc(r.vin)}</span>
        <span class="text-[10.5px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${isWalkIn ? 'bg-amber-400/15 text-amber-300' : 'bg-black/[0.05] text-ink/60'}">${isWalkIn ? t('finance.origin_walkin') : t('finance.origin_sales')}</span>
      </div>
      <div class="text-[12px] text-soft mb-g3">${t('finance.submitted_by')} ${esc(r.submittedBy ? r.submittedBy.fullName : '—')}${r.branch ? ' · ' + esc(r.branch.code) + ' ' + esc(r.branch.name) : ''} · ${activeCount} item(s)</div>
      ${r.items.map(renderItemRow).join('')}
      <div class="flex justify-between text-[13px] pt-2 font-semibold"><span>${t('common.total')} · ${hrs(r.totalLaborHours)}</span><span class="tabular-nums">${money(r.totalPrice)}</span></div>
      <div class="mt-g3"><textarea id="finance-note" placeholder="${t('finance.note_label')}" class="field-input w-full min-h-[64px]"></textarea></div>
      <div class="flex flex-wrap gap-2 mt-g3">
        <button class="btn btn-approve" data-action="finance-approve" data-id="${r.id}"><span class="material-symbols-outlined text-[16px]">check</span>${t('finance.approve')}</button>
        <button class="btn btn-ghost" data-action="finance-delegate" data-id="${r.id}" ${isWalkIn ? 'disabled title="' + esc(t('errors.ALREADY_AFTERSALES_ORIGIN')) + '"' : ''}><span class="material-symbols-outlined text-[16px]">call_split</span>${t('finance.delegate')}</button>
        <button class="btn btn-warn" data-action="finance-return" data-id="${r.id}"><span class="material-symbols-outlined text-[16px]">assignment_return</span>${t('finance.return')}</button>
        <button class="btn btn-danger" data-action="finance-reject" data-id="${r.id}"><span class="material-symbols-outlined text-[16px]">close</span>${t('finance.reject')}</button>
      </div>
      ${renderTimeline(r.history)}
      ${renderComments(r)}
    </div>
  `;
}

// ------------------------------------------------------- aftersales team --

function renderAftersalesTeam() {
  const activeServices = state.services.filter(s => s.isActive);
  const myEstimates = state.requests.filter(r => r.origin === 'WALK_IN' && r.submittedBy && r.submittedBy.id === state.user.id);
  const catalogRows = catalogChecklist('wi', activeServices);

  const tabBody = state.atTab === 'estimation' ? renderEstimationTab()
    : state.atTab === 'execution' ? renderExecutionTab()
    : renderActiveCasesTab(myEstimates, activeServices);

  const walkinPanel = state.walkinFormOpen ? `
    <div class="glass glow-border rounded-xl2 p-g5">
      <div class="flex items-center justify-between mb-g4">
        ${panelOpen(t('at.walkin_title'), t('at.walkin_sub'))}
        <button class="btn btn-ghost btn-sm shrink-0" data-action="cancel-walkin-form">${t('common.cancel')}</button>
      </div>
      <div class="space-y-g3">
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('common.vin')}</label><input type="text" id="wi-vin" dir="ltr" class="field-input uppercase"></div>
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.vehicle_model')}</label><input type="text" id="wi-model" class="field-input"></div>
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.services')}</label><div class="flex flex-col gap-1.5 max-h-64 overflow-y-auto pe-1" id="wi-catalog">${catalogRows}</div></div>
        <div><textarea id="wi-comment" placeholder="${t('common.comment_placeholder')}" class="field-input w-full min-h-[52px]"></textarea></div>
      </div>
      <div class="flex justify-between items-center mt-g3 pt-g3 border-t border-dashed border-black/10" id="wi-totals"></div>
      <button class="btn btn-primary w-full mt-g4" data-action="submit-walkin">${t('at.submit_to_sales')}<span class="material-symbols-outlined text-[16px]">arrow_forward</span></button>
    </div>
  ` : `
    <button type="button" class="glass glow-border rounded-xl2 p-g5 w-full flex items-center justify-between gap-3 text-start hover:-translate-y-0.5 transition-transform" data-action="open-walkin-form">
      <span>
        <span class="font-display font-semibold text-[15px] block">${t('at.walkin_title')}</span>
        <span class="text-[12px] text-soft block mt-0.5">${t('at.walkin_sub')}</span>
      </span>
      <span class="btn btn-primary shrink-0"><span class="material-symbols-outlined text-[16px]">add</span>${t('at.walkin_title')}</span>
    </button>
  `;

  return `
    ${walkinPanel}
    <div class="tab-pill-wrap mb-g4 mt-g5">
      <button class="tab-btn ${state.atTab === 'estimation' ? 'active' : ''}" data-action="at-tab" data-tab="estimation">${t('at.tab_estimation')} · ${state.requests.filter(r => r.status === 'UNDER_AFTER_SALES_ESTIMATION').length}</button>
      <button class="tab-btn ${state.atTab === 'execution' ? 'active' : ''}" data-action="at-tab" data-tab="execution">${t('at.tab_execution')} · ${state.requests.filter(r => r.status === 'APPROVED_IN_AFTER_SALES').length}</button>
      <button class="tab-btn ${state.atTab === 'active' ? 'active' : ''}" data-action="at-tab" data-tab="active">${t('at.tab_active')} · ${myEstimates.length}</button>
    </div>
    ${tabBody}
  `;
}

// "Active Cases" — the walk-in estimates this Aftersales Team member
// created themselves, tracked end to end (their own personal queue,
// separate from the shared Estimation Queue / Approved Cases work lists).
function renderActiveCasesTab(myEstimates, activeServices) {
  const listHtml = caseSectionsHtml(myEstimates, {
    needsActionFilter: r => r.status === 'RETURNED_TO_AFTERSALES',
    needsActionLabel: t('common.needs_your_action'),
    activeTab: state.atActiveSubtab,
    tabChangeAction: 'at-active-subtab',
    emptyText: t('at.my_estimates_sub', { n: 0 }),
    leadWithVin: true,
    showOrigin: true,
  });

  const sel = state.selectedRequestDetail;
  let detailPanel = `<div class="glass glow-border rounded-xl2 p-g5"><div class="text-center text-soft text-[13px] py-g6">${t('sales.select_hint')}</div></div>`;
  if (sel && sel.status === 'RETURNED_TO_AFTERSALES' && sel.submittedBy && sel.submittedBy.id === state.user.id) {
    detailPanel = renderResubmitEstimateForm(sel, activeServices);
  } else if (sel && myEstimates.some(r => r.id === sel.id)) {
    detailPanel = renderReadOnlyDetail(sel);
  }

  return `
    <div class="grid grid-cols-1 lg:grid-cols-[38.2%_1fr] gap-g5 lg-grid-2">
      <div class="glass glow-border rounded-xl2 p-g5">
        ${panelOpen(t('at.my_estimates'), t('at.my_estimates_sub', { n: myEstimates.length }))}
        ${listHtml}
      </div>
      <div>${detailPanel}</div>
    </div>
  `;
}

function renderEstimationTab() {
  const list = state.requests.filter(r => r.status === 'UNDER_AFTER_SALES_ESTIMATION');
  const rows = list.length ? list.map(r => `
    <div class="flex items-center gap-3 p-3 rounded-xl border flex-wrap ${r.id === state.selectedRequestId ? 'border-mgred bg-mgred/10' : 'border-black/10 bg-black/[0.02] hover:border-black/20'} cursor-pointer transition-all hover:-translate-y-0.5" data-action="select-request" data-id="${r.id}">
      <span class="font-mono text-[12.5px] font-semibold w-40 shrink-0 truncate">${esc(r.vin)}</span>
      <span class="font-mono text-[11px] text-soft w-28 shrink-0 truncate">${esc(r.requestNumber)}</span>
      <span class="text-[12px] text-soft flex-1 min-w-0 truncate">${esc(r.vehicleModel || '')} · ${esc(r.submittedBy ? r.submittedBy.fullName : '')}</span>
      ${originNote(r)}
      ${statusChip(r.status)}
    </div>
  `).join('') : `<div class="text-center text-soft text-[13px] py-g6">${t('at.no_estimation')}</div>`;

  const r = state.selectedRequestDetail && state.selectedRequestDetail.status === 'UNDER_AFTER_SALES_ESTIMATION' ? state.selectedRequestDetail : null;
  let detail = `<div class="glass glow-border rounded-xl2 p-g5"><div class="text-center text-soft text-[13px] py-g6">${t('finance.select_hint')}</div></div>`;

  if (r) {
    const itemRows = r.items.map(i => {
      if (i.itemStatus === 'REMOVED') return renderItemRow(i);
      return `
      <div class="flex items-start justify-between gap-3 py-2.5 border-b border-black/10 last:border-0">
        <div class="flex-1 min-w-0">
          <div class="text-[13px]">${esc(i.service.description)} <span class="text-soft text-[11.5px]">${esc(i.service.serviceCode)}</span>${i.source !== 'ORIGINAL' ? `<span class="ms-1.5 text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-300">${esc(i.source.replace(/_/g, ' '))}</span>` : ''}</div>
          <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <input type="number" min="1" value="${i.quantity}" id="qty-${i.id}" class="w-14 rounded-lg border border-black/10 bg-black/[0.03] text-center text-[12px] py-1">
            <span class="text-[11px] text-soft">${t('common.qty')}</span>
            <input type="text" id="notes-${i.id}" value="${esc(i.notes || '')}" placeholder="note" class="field-input flex-1 min-w-[100px] !py-1 !text-[12px]">
            <button class="btn btn-ghost btn-sm" data-action="save-item" data-id="${i.id}" data-req="${r.id}">${t('common.save')}</button>
            <button class="btn btn-danger btn-sm" data-action="remove-item" data-id="${i.id}" data-req="${r.id}">×</button>
          </div>
        </div>
        <span class="tabular-nums text-[13px] shrink-0">${money(i.lineTotal)}</span>
      </div>
    `;
    }).join('');

    const addOptions = state.services.filter(s => s.isActive).map(s => `<option value="${s.id}">${esc(s.serviceCode)} — ${esc(s.description)} (${money(s.price)})</option>`).join('');

    detail = `
      <div class="glass glow-border rounded-xl2 p-g5">
        <div class="font-display font-semibold text-[15px]">${esc(r.vin)} · ${t('at.estimation_title')}</div>
        <div class="text-[12px] text-soft mb-g3">${esc(r.requestNumber)} ${r.vehicleModel ? '· ' + esc(r.vehicleModel) : ''}</div>
        ${itemRows}
        <div class="flex justify-between text-[13px] pt-2 font-semibold"><span>${t('common.total')} · ${hrs(r.totalLaborHours)}</span><span class="tabular-nums">${money(r.totalPrice)}</span></div>
        <div class="flex flex-wrap gap-2 items-end mt-g3 pt-g3 border-t border-black/10">
          <div class="flex-1 min-w-[160px]"><label class="block text-[11px] text-soft mb-1">${t('at.add_service')}</label><select id="add-service-select" class="field-input">${addOptions}</select></div>
          <div class="w-16"><label class="block text-[11px] text-soft mb-1">${t('common.qty')}</label><input type="number" id="add-service-qty" value="1" min="1" class="field-input"></div>
          <button class="btn btn-ghost btn-sm" data-action="add-item" data-req="${r.id}">+ ${t('common.select')}</button>
        </div>
        <button class="btn btn-primary w-full mt-g3" data-action="aftersales-resubmit" data-id="${r.id}">${t('at.resubmit_finance')}<span class="material-symbols-outlined text-[16px]">arrow_forward</span></button>
        ${renderTimeline(r.history)}
        ${renderComments(r)}
      </div>
    `;
  }

  return `<div class="grid grid-cols-1 lg:grid-cols-[38.2%_1fr] gap-g5 lg-grid-2"><div class="glass glow-border rounded-xl2 p-g5">${panelOpen(t('at.estimation_title'), t('at.estimation_sub'))}<div class="space-y-2 stagger">${rows}</div></div><div>${detail}</div></div>`;
}

function renderExecutionTab() {
  const list = state.requests.filter(r => r.status === 'APPROVED_IN_AFTER_SALES');
  if (!list.length) return `<div class="glass glow-border rounded-xl2 p-g5"><div class="text-center text-soft text-[13px] py-g6">${t('at.no_execution')}</div></div>`;
  const rows = list.map(r => `
    <div class="p-g4 rounded-xl border border-black/10 bg-black/[0.02]">
      <div class="flex items-center gap-3 flex-wrap">
        <span class="font-mono text-[12.5px] font-semibold w-40 shrink-0 truncate">${esc(r.vin)}</span>
        <span class="font-mono text-[11px] text-soft w-28 shrink-0 truncate">${esc(r.requestNumber)}</span>
        <span class="text-[12px] text-soft flex-1 min-w-0 truncate">${esc(r.vehicleModel || '')} · ${money(r.totalPrice)}</span>
        ${originNote(r)}
        <span class="chip chip-approved">${t('at.ready')}</span>
      </div>
      <div class="flex gap-2 mt-g3 flex-wrap items-end">
        <input type="text" id="close-comment-${r.id}" placeholder="${t('at.closing_comment')}" class="field-input flex-1 min-w-[140px] !py-1.5">
        <button class="btn btn-approve btn-sm" data-action="close-request" data-id="${r.id}"><span class="material-symbols-outlined text-[16px]">check_circle</span>${t('at.close_request')}</button>
      </div>
    </div>
  `).join('');
  return `<div class="glass glow-border rounded-xl2 p-g5">${panelOpen(t('at.execution_title'), t('at.execution_sub'))}<div class="space-y-3 stagger">${rows}</div></div>`;
}

function renderResubmitEstimateForm(r, activeServices) {
  const currentServiceIds = {};
  r.items.filter(i => i.itemStatus === 'ACTIVE').forEach(i => { currentServiceIds[i.service.id] = i.quantity; });
  const rows = catalogChecklist('re', activeServices, currentServiceIds);
  return `
    <div class="glass glow-border rounded-xl2 p-g5">
      ${panelOpen(`${t('at.correction_needed')} · ${esc(r.vin)}`, esc(r.requestNumber))}
      <div class="text-[12.5px] mb-g3" style="color:#b8590c;">${t('at.sales_said')}: "${esc(r.returnReason || '')}"</div>
      <div class="space-y-g3">
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('common.vin')}</label><input type="text" id="re-vin" value="${esc(r.vin)}" dir="ltr" class="field-input uppercase"></div>
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.vehicle_model')}</label><input type="text" id="re-model" value="${esc(r.vehicleModel || '')}" class="field-input"></div>
        <div><label class="block text-[11px] font-semibold uppercase tracking-wide text-soft mb-1.5">${t('sales.services')}</label><div class="flex flex-col gap-1.5 max-h-64 overflow-y-auto pe-1" id="re-catalog">${rows}</div></div>
      </div>
      <div class="flex justify-between items-center mt-g3 pt-g3 border-t border-dashed border-black/10" id="re-totals"></div>
      <button class="btn btn-primary w-full mt-g4" data-action="submit-resubmit-estimate" data-id="${r.id}">${t('at.resubmit_sales')}<span class="material-symbols-outlined text-[16px]">arrow_forward</span></button>
    </div>
  `;
}

// ------------------------------------------------------------ admin UI ---

function downloadServiceTemplate() {
  const header = 'serviceCode,description,category,laborHours,price,approvalLevel';
  const example = [
    'SVC-0601,Example Service Name,Mechanical,1.5,150,FINANCE',
    'SVC-0602,Another Service,Electrical,0.5,80,SALES_MANAGER',
  ];
  const csv = [header, ...example].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'service-catalog-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas
// or quotes, which is enough for the bulk-import template.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function handleBulkImportFile(file) {
  const resultEl = q('#bulk-import-result');
  try {
    const text = await file.text();
    const rows = parseCsv(text);
    const dataRows = rows.slice(1).filter(r => r.some(c => c.trim() !== ''));
    if (!dataRows.length) { toast(t('errors.NO_ROWS'), 'error'); return; }
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = {
      serviceCode: header.indexOf('servicecode'),
      description: header.indexOf('description'),
      category: header.indexOf('category'),
      laborHours: header.indexOf('laborhours'),
      price: header.indexOf('price'),
      approvalLevel: header.indexOf('approvallevel'),
    };
    const payloadRows = dataRows.map(r => ({
      serviceCode: idx.serviceCode >= 0 ? (r[idx.serviceCode] || '').trim() : '',
      description: idx.description >= 0 ? (r[idx.description] || '').trim() : '',
      category: idx.category >= 0 ? (r[idx.category] || '').trim() : '',
      laborHours: idx.laborHours >= 0 ? parseFloat(r[idx.laborHours]) : NaN,
      price: idx.price >= 0 ? parseFloat(r[idx.price]) : NaN,
      approvalLevel: idx.approvalLevel >= 0 ? (r[idx.approvalLevel] || '').trim() : '',
    }));
    const result = await api('/api/services/bulk-import', { method: 'POST', body: JSON.stringify({ rows: payloadRows }) });
    const summary = t('bulk.result', { created: result.created.length, skipped: result.skipped.length });
    const details = result.skipped.length
      ? '<ul class="mt-1 ps-4 list-disc text-ink/60">' + result.skipped.map(s => `<li>${esc(t('bulk.skipped_row', { row: s.row, code: s.serviceCode ? ` (${s.serviceCode})` : '', reason: s.reason }))}</li>`).join('') + '</ul>'
      : '';
    if (resultEl) resultEl.innerHTML = `<div class="font-semibold">${esc(summary)}</div>${details}`;
    toast(summary, result.created.length ? 'success' : 'error');
    await refreshAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderAdminCatalog() {
  const rows = state.services.map(s => {
    if (state.editingServiceId === s.id) {
      return `
        <tr class="border-b border-black/8">
          <td colspan="8" class="py-3">
            <div class="flex flex-wrap gap-2 items-end">
              <div class="w-28"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.code')}</label><input type="text" id="edit-code" value="${esc(s.serviceCode)}" class="field-input-light"></div>
              <div class="flex-1 min-w-[180px]"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.description')}</label><input type="text" id="edit-desc" value="${esc(s.description)}" class="field-input-light"></div>
              <div class="w-32"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.category')}</label><input type="text" id="edit-cat" value="${esc(s.category || '')}" class="field-input-light"></div>
              <div class="w-24"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.labor')}</label><input type="number" step="0.5" id="edit-hours" value="${s.laborHours}" class="field-input-light"></div>
              <div class="w-24"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.price')}</label><input type="number" step="1" id="edit-price" value="${s.price}" class="field-input-light"></div>
              <div class="w-40"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.approval_level')}</label>
                <select id="edit-approval-level" class="field-input-light">
                  <option value="FINANCE" ${s.approvalLevel === 'FINANCE' ? 'selected' : ''}>${t('role.FINANCE')}</option>
                  <option value="SALES_MANAGER" ${s.approvalLevel === 'SALES_MANAGER' ? 'selected' : ''}>${t('role.SALES_MANAGER')}</option>
                </select>
              </div>
              <button class="btn btn-primary btn-sm" data-action="save-service" data-id="${s.id}">${t('common.save')}</button>
              <button class="btn btn-ghost-light btn-sm" data-action="cancel-edit-service">${t('common.cancel')}</button>
            </div>
          </td>
        </tr>`;
    }
    return `
      <tr class="border-b border-black/8 ${s.isActive ? '' : 'opacity-45'}">
        <td class="py-2.5 pe-3 font-mono text-[12.5px]">${esc(s.serviceCode)}</td>
        <td class="py-2.5 pe-3">${esc(s.description)}</td>
        <td class="py-2.5 pe-3 text-ink/50">${esc(s.category || '—')}</td>
        <td class="py-2.5 pe-3 text-end tabular-nums">${hrs(s.laborHours)}</td>
        <td class="py-2.5 pe-3 text-end tabular-nums font-semibold">${money(s.price)}</td>
        <td class="py-2.5 pe-3"><span class="text-[10.5px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${s.approvalLevel === 'SALES_MANAGER' ? 'bg-emerald-400/15 text-emerald-600' : 'bg-amber-400/15 text-amber-600'}">${t('role.' + (s.approvalLevel || 'FINANCE'))}</span></td>
        <td class="py-2.5 pe-3"><span class="chip ${s.isActive ? 'chip-approved' : 'chip-pending'}">${s.isActive ? t('admin.active') : t('admin.inactive')}</span></td>
        <td class="py-2.5 whitespace-nowrap">
          <button class="text-[11.5px] border border-black/12 rounded-lg px-2.5 py-1 hover:border-mgred hover:text-mgred transition-colors" data-action="edit-service" data-id="${s.id}">${t('admin.edit')}</button>
          <button class="text-[11.5px] border border-black/12 rounded-lg px-2.5 py-1 hover:border-mgred hover:text-mgred transition-colors ms-1" data-action="toggle-service" data-id="${s.id}" data-active="${s.isActive}">${s.isActive ? t('admin.deactivate') : t('admin.reactivate')}</button>
          <button class="text-[11.5px] border border-black/12 rounded-lg px-2.5 py-1 hover:border-rose-600 hover:text-rose-600 transition-colors ms-1" data-action="delete-service" data-id="${s.id}" data-code="${esc(s.serviceCode)}">${t('admin.delete')}</button>
        </td>
      </tr>`;
  }).join('');

  const addForm = state.catalogFormOpen ? `
    <div class="card-light rounded-2xl p-g4 mb-g4">
      <div class="flex flex-wrap gap-2 items-end">
        <div class="w-28"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.code')}</label><input type="text" id="new-code" placeholder="SVC-0600" class="field-input-light"></div>
        <div class="flex-1 min-w-[180px]"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.description')}</label><input type="text" id="new-desc" class="field-input-light"></div>
        <div class="w-32"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.category')}</label><input type="text" id="new-cat" class="field-input-light"></div>
        <div class="w-24"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.labor')}</label><input type="number" step="0.5" id="new-hours" value="1" class="field-input-light"></div>
        <div class="w-24"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.price')}</label><input type="number" step="1" id="new-price" value="100" class="field-input-light"></div>
        <div class="w-40"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.approval_level')}</label>
          <select id="new-approval-level" class="field-input-light">
            <option value="FINANCE">${t('role.FINANCE')}</option>
            <option value="SALES_MANAGER">${t('role.SALES_MANAGER')}</option>
          </select>
        </div>
        <button class="btn btn-primary btn-sm" data-action="create-service">${t('admin.new_service')}</button>
        <button class="btn btn-ghost-light btn-sm" data-action="cancel-new-service">${t('common.cancel')}</button>
      </div>
    </div>` : '';

  const bulkPanel = state.bulkImportOpen ? `
    <div class="card-light rounded-2xl p-g4 mb-g4">
      <div class="text-[13px] font-semibold mb-1">${t('admin.bulk_title')}</div>
      <div class="text-[12px] text-ink/50 mb-g3">${t('admin.bulk_sub')}</div>
      <div class="flex flex-wrap gap-2 items-center">
        <button class="btn btn-ghost-light btn-sm" data-action="download-template">${t('admin.download_template')}</button>
        <button class="btn btn-primary btn-sm" data-action="trigger-bulk-file">${t('admin.choose_csv')}</button>
        <button class="btn btn-ghost-light btn-sm" data-action="cancel-bulk-import">${t('common.cancel')}</button>
        <input type="file" id="bulk-import-file" accept=".csv,text/csv" class="hidden">
      </div>
      <div id="bulk-import-result" class="text-[12.5px] mt-g3"></div>
    </div>` : '';

  return `
    ${addForm}
    ${bulkPanel}
    <div class="card-light rounded-2xl p-g5">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-g4">
        <div>
          <div class="font-display font-semibold text-[17px]">${t('admin.catalog_title')}</div>
          <div class="text-[12px] text-ink/50 mt-0.5">${t('admin.catalog_sub')}</div>
        </div>
        <div class="flex flex-wrap gap-2">
          ${state.bulkImportOpen ? '' : `<button class="btn btn-ghost-light btn-sm" data-action="open-bulk-import">${t('admin.bulk_import')}</button>`}
          ${state.catalogFormOpen ? '' : `<button class="btn btn-primary btn-sm" data-action="open-new-service">${t('admin.new_service')}</button>`}
        </div>
      </div>
      <div class="scrollbox"><table>
        <thead><tr class="border-b border-black/10 text-[11px] uppercase tracking-wide text-ink/50"><th class="py-2 pe-3 text-start">${t('admin.code')}</th><th class="py-2 pe-3 text-start">${t('admin.description')}</th><th class="py-2 pe-3 text-start">${t('admin.category')}</th><th class="py-2 pe-3 text-end">${t('admin.labor')}</th><th class="py-2 pe-3 text-end">${t('admin.price')}</th><th class="py-2 pe-3 text-start">${t('admin.approval_level')}</th><th class="py-2 pe-3 text-start">${t('admin.status')}</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
  `;
}

// The Aftersales Admin role now covers four things — the service catalog
// (above), sign-in accounts, the branch list, and vehicle data — presented
// as peer pill tabs, the same tab language used everywhere else in the app.
function renderAdmin() {
  const tabBar = `
    <div class="tab-pill-wrap mb-g4">
      <button class="tab-btn ${state.adminTab === 'catalog' ? 'active' : ''}" data-action="admin-tab" data-tab="catalog">${t('admin.tab_catalog')}</button>
      <button class="tab-btn ${state.adminTab === 'accounts' ? 'active' : ''}" data-action="admin-tab" data-tab="accounts">${t('admin.tab_accounts')} · ${state.users.length}</button>
      <button class="tab-btn ${state.adminTab === 'branches' ? 'active' : ''}" data-action="admin-tab" data-tab="branches">${t('admin.tab_branches')} · ${state.branches.length}</button>
      <button class="tab-btn ${state.adminTab === 'vehicles' ? 'active' : ''}" data-action="admin-tab" data-tab="vehicles">${t('admin.tab_vehicles')} · ${state.vehiclesTotal}</button>
    </div>`;
  const body = state.adminTab === 'accounts' ? renderAdminAccounts()
    : state.adminTab === 'branches' ? renderAdminBranches()
    : state.adminTab === 'vehicles' ? renderAdminVehicles()
    : renderAdminCatalog();
  return tabBar + body;
}

function renderAdminAccounts() {
  const roleOptions = ['SALES', 'SALES_MANAGER', 'FINANCE', 'AFTER_SALES_ADMIN', 'AFTERSALES_TEAM']
    .map(r => `<option value="${r}">${t('role.' + r)}</option>`).join('');
  const branchOptions = state.branches.map(b => `<option value="${b.id}">${esc(b.code)} · ${esc(b.name)}</option>`).join('');

  const rows = state.users.map(u => `
    <tr class="border-b border-black/8 ${u.isActive ? '' : 'opacity-45'}">
      <td class="py-2.5 pe-3">${esc(u.fullName)}<br><span class="text-[11px] text-ink/45">${esc(u.email)}</span></td>
      <td class="py-2.5 pe-3">${t('role.' + u.role)}</td>
      <td class="py-2.5 pe-3 text-ink/60">${u.branch ? `${esc(u.branch.code)} · ${esc(u.branch.name)}` : t('common.none')}</td>
      <td class="py-2.5 pe-3"><span class="chip ${u.isActive ? 'chip-approved' : 'chip-pending'}">${u.isActive ? t('admin.active') : t('admin.inactive')}</span></td>
      <td class="py-2.5 whitespace-nowrap">
        <button class="text-[11.5px] border border-black/12 rounded-lg px-2.5 py-1 hover:border-mgred hover:text-mgred transition-colors" data-action="toggle-user-active" data-id="${u.id}" data-active="${u.isActive}">${u.isActive ? t('admin.deactivate') : t('admin.reactivate')}</button>
      </td>
    </tr>`).join('');

  const form = state.accountFormOpen ? `
    <div class="card-light rounded-2xl p-g4 mb-g4">
      <div class="flex flex-wrap gap-2 items-end">
        <div class="flex-1 min-w-[160px]"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.full_name')}</label><input type="text" id="new-acc-name" class="field-input-light"></div>
        <div class="flex-1 min-w-[190px]"><label class="block text-[11px] text-ink/50 mb-1">${t('login.email')}</label><input type="email" id="new-acc-email" dir="ltr" class="field-input-light"></div>
        <div class="w-44"><label class="block text-[11px] text-ink/50 mb-1">${t('login.password')}</label><input type="text" id="new-acc-password" dir="ltr" class="field-input-light"></div>
        <div class="w-52"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.role')}</label>
          <select id="new-acc-role" class="field-input-light" data-action="account-role-change">${roleOptions}</select>
        </div>
        <div class="w-56" id="new-account-branch-wrap"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.branch')}</label>
          <select id="new-acc-branch" class="field-input-light">${branchOptions}</select>
        </div>
        <button class="btn btn-primary btn-sm" data-action="create-account">${t('admin.create_account')}</button>
        <button class="btn btn-ghost-light btn-sm" data-action="cancel-new-account">${t('common.cancel')}</button>
      </div>
      <div class="text-[11px] text-ink/40 mt-2">${t('admin.password_hint')} · ${t('admin.branch_hint')}</div>
    </div>` : '';

  return `
    ${form}
    <div class="card-light rounded-2xl p-g5">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-g4">
        <div>
          <div class="font-display font-semibold text-[17px]">${t('admin.accounts_title')}</div>
          <div class="text-[12px] text-ink/50 mt-0.5">${t('admin.accounts_sub')}</div>
        </div>
        ${state.accountFormOpen ? '' : `<button class="btn btn-primary btn-sm" data-action="open-new-account">${t('admin.create_account')}</button>`}
      </div>
      <div class="scrollbox"><table>
        <thead><tr class="border-b border-black/10 text-[11px] uppercase tracking-wide text-ink/50"><th class="py-2 pe-3 text-start">${t('admin.full_name')}</th><th class="py-2 pe-3 text-start">${t('admin.role')}</th><th class="py-2 pe-3 text-start">${t('admin.branch')}</th><th class="py-2 pe-3 text-start">${t('admin.status')}</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
  `;
}

function renderAdminBranches() {
  const rows = state.branches.map(b => `
    <tr class="border-b border-black/8">
      <td class="py-2.5 pe-3 font-mono text-[12.5px]">${esc(b.code)}</td>
      <td class="py-2.5 pe-3">${esc(b.name)}</td>
      <td class="py-2.5 whitespace-nowrap">
        <button class="text-[11.5px] border border-black/12 rounded-lg px-2.5 py-1 hover:border-rose-600 hover:text-rose-600 transition-colors" data-action="delete-branch" data-id="${b.id}" data-name="${esc(b.name)}">${t('admin.delete')}</button>
      </td>
    </tr>`).join('');

  const form = state.branchFormOpen ? `
    <div class="card-light rounded-2xl p-g4 mb-g4">
      <div class="flex flex-wrap gap-2 items-end">
        <div class="w-32"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.branch_code')}</label><input type="text" id="new-branch-code" dir="ltr" class="field-input-light"></div>
        <div class="flex-1 min-w-[220px]"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.branch_name')}</label><input type="text" id="new-branch-name" class="field-input-light"></div>
        <button class="btn btn-primary btn-sm" data-action="create-branch">${t('admin.add_branch')}</button>
        <button class="btn btn-ghost-light btn-sm" data-action="cancel-new-branch">${t('common.cancel')}</button>
      </div>
    </div>` : '';

  return `
    ${form}
    <div class="card-light rounded-2xl p-g5">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-g4">
        <div>
          <div class="font-display font-semibold text-[17px]">${t('admin.branches_title')}</div>
          <div class="text-[12px] text-ink/50 mt-0.5">${t('admin.branches_sub')}</div>
        </div>
        ${state.branchFormOpen ? '' : `<button class="btn btn-primary btn-sm" data-action="open-new-branch">${t('admin.add_branch')}</button>`}
      </div>
      <div class="scrollbox"><table>
        <thead><tr class="border-b border-black/10 text-[11px] uppercase tracking-wide text-ink/50"><th class="py-2 pe-3 text-start">${t('admin.branch_code')}</th><th class="py-2 pe-3 text-start">${t('admin.branch_name')}</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
  `;
}

function downloadVehicleTemplate() {
  const header = 'vin,ata,purchaseDate,warrantyStartDate';
  const example = [
    'WMWXP7C05N2099999,2026-01-01,2026-02-01,',
    'SALFA2A2X9H099999,2025-05-01,2025-05-10,2025-05-10',
  ];
  const csv = [header, ...example].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vehicle-data-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Vehicle import goes through a real file upload (multipart FormData), not
// client-side CSV parsing + a JSON body — the file can be a real dealer
// export with hundreds of thousands of rows, and the server (routes/
// vehicles.js) does the parsing and header-mapping (it accepts this app's
// own simple template OR a real export's "Vehicle VIN" / "ATA" /
// "Purchase Date" columns). Never build a giant in-browser array here.
async function handleVehicleBulkImportFile(file) {
  state.vehicleImportBusy = true;
  state.vehicleImportSummary = null;
  render();
  try {
    const formData = new FormData();
    formData.append('file', file);
    const result = await api('/api/vehicles/bulk-import-file', { method: 'POST', body: formData });
    state.vehicleImportSummary = result;
    toast(t('bulk.result_vehicles', { created: result.createdCount, skipped: result.skippedCount }), result.createdCount ? 'success' : 'error');
    state.vehiclesPage = 1;
    state.vehiclesSearch = '';
    state.vehicleImportBusy = false;
    await refreshAll();
  } catch (e) {
    state.vehicleImportBusy = false;
    toast(e.message, 'error');
    render();
  }
}

function vehicleImportSummaryHtml() {
  const s = state.vehicleImportSummary;
  if (!s) return '';
  const summary = t('bulk.result_vehicles', { created: s.createdCount, skipped: s.skippedCount });
  const skippedList = s.skippedSample && s.skippedSample.length
    ? '<ul class="mt-1 ps-4 list-disc text-ink/60 max-h-48 overflow-y-auto">' +
        s.skippedSample.map(row => `<li>${esc(t('bulk.skipped_row', { row: row.row, code: row.vin ? ` (${row.vin})` : '', reason: row.reason }))}</li>`).join('') +
      '</ul>'
    : '';
  const truncatedNote = s.skippedTruncated
    ? `<div class="text-[11px] text-ink/40 mt-1">${t('admin.vehicle_import_more_skipped', { n: s.skippedCount - s.skippedSample.length })}</div>`
    : '';
  return `
    <div class="text-[12.5px] mt-g3 border-t border-black/8 pt-g3">
      <div class="font-semibold">${esc(summary)}</div>
      <div class="text-ink/50 mt-0.5">${t('admin.vehicle_import_total_rows', { n: s.totalRows })}</div>
      ${skippedList}${truncatedNote}
    </div>`;
}

function renderAdminVehicles() {
  const rows = state.vehicles.map(v => {
    if (state.editingVehicleId === v.id) {
      return `
        <tr class="border-b border-black/8">
          <td colspan="5" class="py-3">
            <div class="flex flex-wrap gap-2 items-end">
              <div class="w-44"><label class="block text-[11px] text-ink/50 mb-1">${t('common.vin')}</label><input type="text" id="edit-vehicle-vin" dir="ltr" value="${esc(v.vin)}" class="field-input-light"></div>
              <div class="w-40"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.ata')}</label><input type="date" id="edit-vehicle-ata" dir="ltr" value="${esc(v.ata)}" class="field-input-light"></div>
              <div class="w-40"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.purchase_date')}</label><input type="date" id="edit-vehicle-purchase" dir="ltr" value="${esc(v.purchaseDate)}" class="field-input-light"></div>
              <div class="w-40"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.warranty_start_date')}</label><input type="date" id="edit-vehicle-warranty" dir="ltr" value="${esc(v.warrantyStartDate || '')}" class="field-input-light"></div>
              <button class="btn btn-primary btn-sm" data-action="save-vehicle" data-id="${v.id}">${t('common.save')}</button>
              <button class="btn btn-ghost-light btn-sm" data-action="cancel-edit-vehicle">${t('common.cancel')}</button>
            </div>
          </td>
        </tr>`;
    }
    return `
      <tr class="border-b border-black/8">
        <td class="py-2.5 pe-3 font-mono text-[12.5px]">${esc(v.vin)}</td>
        <td class="py-2.5 pe-3 tabular-nums">${esc(v.ata)}</td>
        <td class="py-2.5 pe-3 tabular-nums">${esc(v.purchaseDate)}</td>
        <td class="py-2.5 pe-3 tabular-nums text-ink/60">${esc(v.warrantyStartDate || '—')}</td>
        <td class="py-2.5 whitespace-nowrap">
          <button class="text-[11.5px] border border-black/12 rounded-lg px-2.5 py-1 hover:border-mgred hover:text-mgred transition-colors" data-action="edit-vehicle" data-id="${v.id}">${t('admin.edit')}</button>
          <button class="text-[11.5px] border border-black/12 rounded-lg px-2.5 py-1 hover:border-rose-600 hover:text-rose-600 transition-colors ms-1" data-action="delete-vehicle" data-id="${v.id}" data-vin="${esc(v.vin)}">${t('admin.delete')}</button>
        </td>
      </tr>`;
  }).join('');

  const addForm = state.vehicleFormOpen ? `
    <div class="card-light rounded-2xl p-g4 mb-g4">
      <div class="flex flex-wrap gap-2 items-end">
        <div class="w-44"><label class="block text-[11px] text-ink/50 mb-1">${t('common.vin')}</label><input type="text" id="new-vehicle-vin" dir="ltr" class="field-input-light"></div>
        <div class="w-40"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.ata')}</label><input type="date" id="new-vehicle-ata" dir="ltr" class="field-input-light"></div>
        <div class="w-40"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.purchase_date')}</label><input type="date" id="new-vehicle-purchase" dir="ltr" class="field-input-light"></div>
        <div class="w-40"><label class="block text-[11px] text-ink/50 mb-1">${t('admin.warranty_start_date')}</label><input type="date" id="new-vehicle-warranty" dir="ltr" class="field-input-light"></div>
        <button class="btn btn-primary btn-sm" data-action="create-vehicle">${t('admin.add_vehicle')}</button>
        <button class="btn btn-ghost-light btn-sm" data-action="cancel-new-vehicle">${t('common.cancel')}</button>
      </div>
      <div class="text-[11px] text-ink/40 mt-2">${t('admin.warranty_start_hint')}</div>
    </div>` : '';

  const bulkPanel = state.vehicleBulkImportOpen ? `
    <div class="card-light rounded-2xl p-g4 mb-g4">
      <div class="text-[13px] font-semibold mb-1">${t('admin.vehicle_bulk_title')}</div>
      <div class="text-[12px] text-ink/50 mb-g3">${t('admin.vehicle_bulk_sub')}</div>
      <div class="flex flex-wrap gap-2 items-center">
        <button class="btn btn-ghost-light btn-sm" data-action="download-vehicle-template">${t('admin.download_template')}</button>
        <button class="btn btn-primary btn-sm" data-action="trigger-vehicle-bulk-file" ${state.vehicleImportBusy ? 'disabled' : ''}>${t('admin.choose_file')}</button>
        <button class="btn btn-ghost-light btn-sm" data-action="cancel-vehicle-bulk-import">${t('common.cancel')}</button>
        <input type="file" id="vehicle-bulk-import-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden">
      </div>
      ${state.vehicleImportBusy ? `
        <div class="text-[12.5px] text-ink/60 mt-g3 flex items-center gap-2">
          <span class="inline-block w-3.5 h-3.5 border-2 border-mgred border-t-transparent rounded-full animate-spin"></span>
          ${t('admin.vehicle_import_processing')}
        </div>` : ''}
      ${vehicleImportSummaryHtml()}
    </div>` : '';

  // Server-side search + pagination — the table can hold a full dealer
  // management system export (hundreds of thousands of rows), so this only
  // ever asks for and renders the current page, never the whole dataset.
  const pageInfo = t('admin.vehicles_page_info', { page: state.vehiclesPage, totalPages: state.vehiclesTotalPages, total: state.vehiclesTotal });
  const searchAndPaging = `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-g3">
      <div class="w-64">
        <input type="text" id="vehicles-search-input" dir="ltr" placeholder="${t('admin.vehicles_search_placeholder')}" value="${esc(state.vehiclesSearch)}" class="field-input-light">
      </div>
      <div class="flex items-center gap-2 text-[12px] text-ink/50 whitespace-nowrap">
        <span>${esc(pageInfo)}</span>
        <button class="btn btn-ghost-light btn-sm" data-action="vehicles-page-prev" ${state.vehiclesPage <= 1 ? 'disabled' : ''}>${t('common.prev')}</button>
        <button class="btn btn-ghost-light btn-sm" data-action="vehicles-page-next" ${state.vehiclesPage >= state.vehiclesTotalPages ? 'disabled' : ''}>${t('common.next')}</button>
      </div>
    </div>`;

  return `
    ${addForm}
    ${bulkPanel}
    <div class="card-light rounded-2xl p-g5">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-g4">
        <div>
          <div class="font-display font-semibold text-[17px]">${t('admin.vehicles_title')}</div>
          <div class="text-[12px] text-ink/50 mt-0.5">${t('admin.vehicles_sub')}</div>
        </div>
        <div class="flex flex-wrap gap-2">
          ${state.vehicleBulkImportOpen ? '' : `<button class="btn btn-ghost-light btn-sm" data-action="open-vehicle-bulk-import">${t('admin.bulk_import')}</button>`}
          ${state.vehicleFormOpen ? '' : `<button class="btn btn-primary btn-sm" data-action="open-new-vehicle">${t('admin.add_vehicle')}</button>`}
        </div>
      </div>
      ${searchAndPaging}
      <div class="scrollbox"><table>
        <thead><tr class="border-b border-black/10 text-[11px] uppercase tracking-wide text-ink/50"><th class="py-2 pe-3 text-start">${t('common.vin')}</th><th class="py-2 pe-3 text-start">${t('admin.ata')}</th><th class="py-2 pe-3 text-start">${t('admin.purchase_date')}</th><th class="py-2 pe-3 text-start">${t('admin.warranty_start_date')}</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="py-6 text-center text-ink/40">${t('admin.vehicles_empty')}</td></tr>`}</tbody>
      </table></div>
    </div>
  `;
}

// ------------------------------------------------------------ VIN check --

function downloadVinBulkTemplate() {
  const header = 'vin,purchaseDate';
  const example = [
    'WMWXP7C05N2099999,2026-02-01',
    'SALFA2A2X9H099999,2025-05-10',
  ];
  const csv = [header, ...example].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vin-bulk-inquiry-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Same real-file-upload pattern as the admin vehicle bulk import: a real
// worksheet (this app's own template, or a real export's own VIN/Purchase
// Date columns) is posted as multipart form data and parsed server-side, so
// this works whether the person checking coverage has a handful of VINs or
// a couple thousand from their own tracking sheet.
async function handleVinBulkCheckFile(file) {
  state.vinBulkBusy = true;
  state.vinBulkResult = null;
  render();
  try {
    const formData = new FormData();
    formData.append('file', file);
    const result = await api('/api/vehicles/warranty-check-bulk', { method: 'POST', body: formData });
    state.vinBulkResult = result;
    state.vinBulkBusy = false;
    render();
  } catch (e) {
    state.vinBulkBusy = false;
    toast(e.message, 'error');
    render();
  }
}

function downloadVinBulkResultsCsv() {
  const r = state.vinBulkResult;
  if (!r || !r.results.length) return;

  // One column per special-period part (its own header), "Covered" /
  // "Not covered" per VIN — rather than a single packed "not covered" list
  // column. The part catalog is the same 14 parts for every vehicle, so the
  // labels/order are taken from the first successfully-checked row and
  // reused as the columns for every row; a row that couldn't be checked
  // (unknown VIN, bad date, etc.) just leaves those columns blank.
  const partLabels = (r.results.find(row => row.ok && row.parts) || {}).parts?.map(p => p.label) || [];

  const baseHeader = ['row', 'vin', 'status', 'ata', 'purchaseDateOnFile', 'enteredPurchaseDate', 'purchaseDateMismatch', 'warrantyStartDate', 'error'];
  const header = [...baseHeader, ...partLabels].map(csvCell).join(',');

  const lines = r.results.map(row => {
    if (!row.ok) {
      const base = [row.row, row.vin || '', 'ERROR', '', '', '', '', '', row.error];
      return [...base, ...partLabels.map(() => '')].map(csvCell).join(',');
    }
    const base = [
      row.row, row.vin, 'OK', row.ata, row.purchaseDateOnFile || '', row.enteredPurchaseDate,
      row.purchaseDateMismatch ? 'yes' : 'no', row.warrantyStartDate, '',
    ];
    // row.parts is in the same fixed order as partLabels (both come straight
    // from the server's PARTS list), so this lines up column-for-column.
    // "Covered" stays a plain label (nothing to explain), but "not covered"
    // cells carry the actual reason for THIS vehicle's dates — a flat
    // repeated "Not covered" across every row doesn't tell the dealer
    // anything they can act on.
    const partCells = (row.parts || []).map(p => p.covered ? 'Covered' : `Not covered — ${(p.reasons || []).join(' ')}`);
    return [...base, ...partCells].map(csvCell).join(',');
  });
  const csv = [header, ...lines].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vin-bulk-inquiry-results.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function vinBulkResultHtml() {
  const r = state.vinBulkResult;
  if (!r) return '';
  const okCount = r.results.filter(row => row.ok).length;
  const errorCount = r.results.length - okCount;
  const rows = r.results.map(row => {
    if (!row.ok) {
      return `
      <tr class="border-b border-black/8">
        <td class="py-2 pe-3 font-mono text-[12px]">${esc(row.vin || '—')}</td>
        <td class="py-2 pe-3" colspan="4"><span class="chip chip-rejected">${t('vin.bulk_error')}</span> <span class="text-ink/50 text-[12px]">${esc(row.error)}</span></td>
      </tr>`;
    }
    // The specific, per-VIN reason for each not-covered part (computed from
    // this vehicle's actual ATA/purchase/warranty-start dates) — not just
    // the part's name, so the "why" is visible here too, not only on the
    // single-VIN check screen.
    const notCoveredParts = (row.parts || []).filter(p => !p.covered);
    const notCovered = notCoveredParts.length
      ? `<ul class="ps-4 list-disc space-y-1">${notCoveredParts.map(p => `<li><span class="text-rose-700 font-medium">${esc(p.label)}</span> — <span class="text-ink/60">${esc((p.reasons || []).join(' '))}</span></li>`).join('')}</ul>`
      : `<span class="text-ink/40">${t('vin.bulk_all_covered')}</span>`;
    return `
      <tr class="border-b border-black/8">
        <td class="py-2 pe-3 font-mono text-[12px]">${esc(row.vin)}</td>
        <td class="py-2 pe-3 tabular-nums">${esc(row.warrantyStartDate)}</td>
        <td class="py-2 pe-3">${row.purchaseDateMismatch ? `<span class="chip chip-estimation">${t('vin.mismatch_chip')}</span>` : ''}</td>
        <td class="py-2 pe-3 tabular-nums">${row.coveredCount}/${row.coveredCount + row.notCoveredCount}</td>
        <td class="py-2 text-[12px]">${notCovered}</td>
      </tr>`;
  }).join('');

  return `
    <div class="mt-g3 border-t border-black/8 pt-g3">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-g2">
        <div class="text-[12.5px] font-semibold">${t('vin.bulk_summary', { ok: okCount, errors: errorCount })}</div>
        <button class="btn btn-ghost-light btn-sm" data-action="download-vin-bulk-results">${t('vin.bulk_download_results')}</button>
      </div>
      ${r.truncated ? `<div class="text-[11px] text-amber-700 mb-g2">${t('vin.bulk_truncated', { n: r.maxRows })}</div>` : ''}
      <div class="scrollbox max-h-96"><table>
        <thead><tr class="border-b border-black/10 text-[11px] uppercase tracking-wide text-ink/50">
          <th class="py-2 pe-3 text-start">${t('vin.vin_label')}</th>
          <th class="py-2 pe-3 text-start">${t('vin.warranty_start_label')}</th>
          <th class="py-2 pe-3 text-start"></th>
          <th class="py-2 pe-3 text-start">${t('vin.bulk_covered_col')}</th>
          <th class="py-2 pe-3 text-start">${t('vin.bulk_not_covered_col')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

function renderVinCheck() {
  const result = state.vinCheckResult;
  return `
    <div class="max-w-3xl mx-auto">
      <div class="flex items-center justify-between mb-g4">
        <div>
          <div class="font-display font-semibold text-[19px]">${t('vin.title')}</div>
          <div class="text-[12.5px] text-ink/50 mt-0.5">${t('vin.sub')}</div>
        </div>
        <div class="flex gap-2">
          ${state.vinBulkOpen ? '' : `<button class="btn btn-ghost-light btn-sm" data-action="open-vin-bulk-check">${t('vin.bulk_button')}</button>`}
          <button class="btn btn-ghost-light btn-sm" data-action="close-vin-check">${t('common.close')}</button>
        </div>
      </div>
      ${renderVinBulkPanel()}
      <div class="card-light rounded-2xl p-g5 mb-g4">
        <div class="flex flex-wrap gap-3 items-end">
          <div class="flex-1 min-w-[220px]">
            <label class="block text-[11px] font-semibold uppercase tracking-wide text-ink/50 mb-1.5">${t('vin.vin_label')}</label>
            <input type="text" id="vin-input" dir="ltr" placeholder="${t('vin.vin_placeholder')}" class="field-input" value="${result ? esc(result.vehicle.vin) : ''}">
          </div>
          <div class="w-56">
            <label class="block text-[11px] font-semibold uppercase tracking-wide text-ink/50 mb-1.5">${t('vin.purchase_date_label')}</label>
            <input type="date" id="vin-purchase-date" dir="ltr" class="field-input" value="${result ? esc(result.enteredPurchaseDate) : ''}">
          </div>
          <button class="btn btn-primary btn-sm" data-action="submit-vin-check">${t('vin.check_btn')}</button>
        </div>
        ${state.vinCheckError ? `<div class="bg-rose-50 text-rose-700 border border-rose-200 rounded-lg px-3 py-2.5 text-[13px] mt-g3">${esc(state.vinCheckError)}</div>` : ''}
      </div>
      ${result ? renderVinCheckResult(result) : ''}
    </div>
  `;
}

function renderVinBulkPanel() {
  if (!state.vinBulkOpen) return '';
  return `
    <div class="card-light rounded-2xl p-g4 mb-g4">
      <div class="text-[13px] font-semibold mb-1">${t('vin.bulk_title')}</div>
      <div class="text-[12px] text-ink/50 mb-g3">${t('vin.bulk_sub', { max: 2000 })}</div>
      <div class="flex flex-wrap gap-2 items-center">
        <button class="btn btn-ghost-light btn-sm" data-action="download-vin-bulk-template">${t('admin.download_template')}</button>
        <button class="btn btn-primary btn-sm" data-action="trigger-vin-bulk-file" ${state.vinBulkBusy ? 'disabled' : ''}>${t('admin.choose_file')}</button>
        <button class="btn btn-ghost-light btn-sm" data-action="cancel-vin-bulk-check">${t('common.cancel')}</button>
        <input type="file" id="vin-bulk-check-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden">
      </div>
      ${state.vinBulkBusy ? `
        <div class="text-[12.5px] text-ink/60 mt-g3 flex items-center gap-2">
          <span class="inline-block w-3.5 h-3.5 border-2 border-mgred border-t-transparent rounded-full animate-spin"></span>
          ${t('admin.vehicle_import_processing')}
        </div>` : ''}
      ${vinBulkResultHtml()}
    </div>`;
}

function renderVinCheckResult(r) {
  const mismatch = r.purchaseDateMismatch ? `
    <div class="rounded-xl border border-amber-300 bg-amber-50 text-amber-800 px-g4 py-g3 mb-g4">
      <div class="font-semibold text-[13px] mb-1">${t('vin.mismatch_title')}</div>
      <div class="text-[12.5px] leading-relaxed">${t('vin.mismatch_body')}</div>
      <div class="text-[12.5px] leading-relaxed mt-2 font-semibold">${t('vin.correction_docs_title')}</div>
      <div class="text-[12.5px]">${t('vin.correction_docs_body')}</div>
    </div>` : '';

  // This is only ever an inquiry result, never a stored change — so when the
  // 1-year-from-ATA rule is what set the warranty start date, the note is
  // phrased as a projection, not as something that has already happened. If
  // the entered date also disagrees with the vehicle's file (a correction is
  // needed), the date only takes effect once that correction is submitted
  // and approved by the manufacturer.
  const autoNote = r.warrantyStartAutoTriggered ? `<div class="text-[12px] text-amber-700 mt-1">${
    r.purchaseDateMismatch
      ? t('vin.warranty_start_auto_pending_correction', { date: r.warrantyStartDate, ata: r.vehicle.ata })
      : t('vin.warranty_start_auto', { date: r.warrantyStartDate, ata: r.vehicle.ata })
  }</div>` : '';

  const rows = r.parts.map(p => {
    const extraNotes = [
      p.ataWindowDays ? t('vin.ata_window_note', { n: p.ataWindowDays }) : '',
      p.minDaysAfterPurchase ? t('vin.min_days_note', { n: p.minDaysAfterPurchase }) : '',
    ].filter(Boolean).join(' · ');
    return `
    <tr class="border-b border-black/8">
      <td class="py-2.5 pe-3">${esc(p.label)}</td>
      <td class="py-2.5 pe-3 text-ink/60">${t('vin.months_unit', { n: p.months })} · ${Number(p.km).toLocaleString()} km${extraNotes ? ` · ${esc(extraNotes)}` : ''}</td>
      <td class="py-2.5 pe-3 tabular-nums">${esc(p.coverageEndsAt)}</td>
      <td class="py-2.5 pe-3"><span class="chip ${p.covered ? 'chip-approved' : 'chip-rejected'}">${p.covered ? t('vin.covered') : t('vin.not_covered')}</span></td>
      <td class="py-2.5 text-[11.5px] text-ink/50">${p.reasons.map(esc).join('<br>')}</td>
    </tr>`;
  }).join('');

  return `
    ${mismatch}
    <div class="card-light rounded-2xl p-g5">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-g4">
        <div>
          <div class="font-display font-semibold text-[15px]">${t('vin.result_title')}</div>
          <div class="text-[12px] text-ink/50 mt-0.5">${t('vin.warranty_start_label')}: <strong>${esc(r.warrantyStartDate)}</strong></div>
          ${autoNote}
        </div>
        <button class="btn btn-primary btn-sm" data-action="print-vin-disclosure">${t('vin.print_disclosure')}</button>
      </div>
      <div class="scrollbox"><table>
        <thead><tr class="border-b border-black/10 text-[11px] uppercase tracking-wide text-ink/50">
          <th class="py-2 pe-3 text-start">${t('vin.part_col')}</th>
          <th class="py-2 pe-3 text-start">${t('vin.window_col')}</th>
          <th class="py-2 pe-3 text-start">${t('vin.ends_col')}</th>
          <th class="py-2 pe-3 text-start">${t('vin.status_col')}</th>
          <th class="py-2 pe-3 text-start">${t('vin.reasons_label')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="text-[11px] text-ink/40 mt-g3">${t('vin.km_general_note')}</div>
    </div>
  `;
}

// A signed disclosure is a legal record the customer keeps, independent of
// whatever language the app happens to be in when it's printed — so unlike
// the rest of the UI, this document always carries both English and Arabic
// content together rather than switching with I18N.getLang(). The Arabic
// copy is a full second page (not a side-by-side translation), each with
// its own letterhead, so either page reads as a complete standalone record.
const DEALER_NAME_EN = 'Jiad Modern Motors';
const DEALER_NAME_AR = 'شركة جياد الحديثة للسيارات';

function buildDisclosureHtml(r) {
  const today = new Date().toISOString().slice(0, 10);
  const notCovered = r.parts.filter(p => !p.covered);

  const autoNoteEn = r.warrantyStartAutoTriggered
    ? (r.purchaseDateMismatch
        ? `If this correction is approved by the manufacturer, the warranty will start on ${esc(r.warrantyStartDate)} — one year after the ATA date (${esc(r.vehicle.ata)}), since the purchase date entered is more than a year after ATA.`
        : `The warranty start date shown was set one year after the ATA date (${esc(r.vehicle.ata)}), since the purchase date is more than a year after ATA.`)
    : '';
  const autoNoteAr = r.warrantyStartAutoTriggered
    ? (r.purchaseDateMismatch
        ? `في حال اعتماد الشركة المصنّعة لهذا التصحيح، سيبدأ الضمان بتاريخ ${esc(r.warrantyStartDate)} — أي بعد عام واحد من تاريخ ATA (${esc(r.vehicle.ata)})، وذلك لأن تاريخ الشراء المُدخل يتجاوز عامًا من تاريخ ATA.`
        : `تم تحديد تاريخ بدء الضمان بعد عام واحد من تاريخ ATA (${esc(r.vehicle.ata)})، لأن تاريخ الشراء يتجاوز عامًا من تاريخ ATA.`)
    : '';

  const notCoveredRowsEn = notCovered.length
    ? notCovered.map(p => `<tr><td>${esc(p.label)}</td><td>${esc((p.reasons || []).join(' '))}</td></tr>`).join('')
    : `<tr><td colspan="2" class="all-covered">All special-period items are currently covered as of ${esc(today)}.</td></tr>`;
  const notCoveredRowsAr = notCovered.length
    ? notCovered.map(p => `<tr><td>${esc(p.label)}</td><td>${esc((p.reasons || []).join(' '))}</td></tr>`).join('')
    : `<tr><td colspan="2" class="all-covered">جميع بنود فترة الضمان الخاصة مغطاة حاليًا حتى تاريخ ${esc(today)}.</td></tr>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Warranty Coverage Disclosure — ${esc(r.vehicle.vin)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #14151A; margin: 0; padding: 0; font-size: 13px; line-height: 1.55; background: #efeef2; }
  .page { max-width: 800px; margin: 0 auto 24px; padding: 30px 40px 40px; background: #fff; }
  .letterhead { border-bottom: 3px solid #E4022E; padding-bottom: 12px; margin-bottom: 18px; }
  .dealer-name { font-size: 20px; font-weight: 800; color: #B4001F; letter-spacing: 0.01em; }
  h1 { font-size: 16px; margin: 6px 0 2px; font-weight: 700; }
  h2 { font-size: 14px; margin: 24px 0 8px; border-bottom: 2px solid #E4022E; padding-bottom: 4px; }
  .subtitle { color: #666; font-size: 11.5px; }
  .meta { width: 100%; border-collapse: collapse; margin: 14px 0 6px; border: 1px solid #e3e2e7; border-radius: 6px; overflow: hidden; }
  .meta td { padding: 7px 10px; font-size: 12.5px; vertical-align: top; border-bottom: 1px solid #eee; }
  .meta tr:last-child td { border-bottom: none; }
  .meta td.label { color: #666; width: 200px; white-space: nowrap; background: #faf8fe; }
  table.parts { width: 100%; border-collapse: collapse; margin-top: 8px; page-break-inside: auto; }
  table.parts th, table.parts td { border: 1px solid #ccc; padding: 6px 8px; font-size: 12px; text-align: left; vertical-align: top; }
  table.parts th { background: #f4f3f8; }
  table.parts tr { page-break-inside: avoid; }
  .all-covered { text-align: center; color: #1e8e5a; font-style: italic; }
  .notice { background: #fdeef0; border: 1px solid #E4022E; border-radius: 6px; padding: 8px 12px; font-size: 12px; margin: 10px 0; }
  .ar { direction: rtl; text-align: right; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; }
  .ar .meta td.label { width: 210px; }
  .ar table.parts th, .ar table.parts td { text-align: right; }
  .ar-page { page-break-before: always; break-before: page; }
  .ack { margin-top: 14px; font-weight: 600; }
  .sig-section { margin-top: 30px; page-break-inside: avoid; }
  .sig-block { display: flex; gap: 40px; margin-top: 18px; }
  .sig-col { flex: 1; }
  .sig-line { border-bottom: 1px solid #333; height: 34px; margin-top: 22px; }
  .sig-caption { font-size: 11px; color: #555; margin-top: 4px; }
  .sig-title { font-weight: 700; font-size: 13px; margin-bottom: 2px; color: #B4001F; }
  .print-bar { max-width: 800px; margin: 0 auto; padding: 14px 40px 0; text-align: end; }
  .print-btn { padding: 9px 22px; background: #E4022E; color: #fff; border: none; border-radius: 999px; font-weight: 700; font-size: 13px; cursor: pointer; box-shadow: 0 6px 16px -6px rgba(228,2,46,0.6); }
  .print-btn:hover { background: #B4001F; }
  @media print {
    body { background: #fff; }
    .page { max-width: none; margin: 0; padding: 10mm 14mm; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="print-bar no-print"><button class="print-btn" onclick="window.print()">Print / طباعة</button></div>

  <div class="page">
    <div class="letterhead">
      <div class="dealer-name">${esc(DEALER_NAME_EN)}</div>
      <h1>Warranty Coverage Disclosure &amp; Acknowledgment</h1>
      <div class="subtitle">Printed ${esc(today)}</div>
    </div>

    <table class="meta">
      <tr><td class="label">VIN</td><td>${esc(r.vehicle.vin)}</td></tr>
      <tr><td class="label">ATA date</td><td>${esc(r.vehicle.ata)}</td></tr>
      <tr><td class="label">Purchase date entered</td><td>${esc(r.enteredPurchaseDate)}</td></tr>
      <tr><td class="label">Warranty start date</td><td><strong>${esc(r.warrantyStartDate)}</strong></td></tr>
    </table>
    ${autoNoteEn ? `<p class="notice">${autoNoteEn}</p>` : ''}

    <h2>Items not currently covered</h2>
    <table class="parts">
      <thead><tr><th style="width:32%">Part</th><th>Reason</th></tr></thead>
      <tbody>${notCoveredRowsEn}</tbody>
    </table>
    <p class="ack">I, the undersigned customer, acknowledge that the ${esc(DEALER_NAME_EN)} representative has informed me of the warranty start date and the items listed above as not currently covered under the special-period warranty, and that I understand this information.</p>
  </div>

  <div class="page ar-page ar">
    <div class="letterhead">
      <div class="dealer-name">${esc(DEALER_NAME_AR)}</div>
      <h1>إقرار الإفصاح عن تغطية الضمان</h1>
      <div class="subtitle">تمت الطباعة بتاريخ ${esc(today)}</div>
    </div>

    <table class="meta">
      <tr><td class="label">رقم الهيكل (VIN)</td><td>${esc(r.vehicle.vin)}</td></tr>
      <tr><td class="label">تاريخ ATA</td><td>${esc(r.vehicle.ata)}</td></tr>
      <tr><td class="label">تاريخ الشراء المُدخل</td><td>${esc(r.enteredPurchaseDate)}</td></tr>
      <tr><td class="label">تاريخ بدء الضمان</td><td><strong>${esc(r.warrantyStartDate)}</strong></td></tr>
    </table>
    ${autoNoteAr ? `<p class="notice">${autoNoteAr}</p>` : ''}

    <h2>البنود غير المغطاة حاليًا</h2>
    <table class="parts">
      <thead><tr><th style="width:32%">القطعة</th><th>السبب</th></tr></thead>
      <tbody>${notCoveredRowsAr}</tbody>
    </table>
    <p class="ack">أقرّ أنا الموقّع أدناه، بصفتي العميل، بأن ممثل ${esc(DEALER_NAME_AR)} قد أبلغني بتاريخ بدء الضمان وبالبنود المذكورة أعلاه كغير مغطاة حاليًا بموجب ضمان الفترة الخاصة، وبأنني على علم ودراية بهذه المعلومات.</p>

    <div class="sig-section">
      <h2>Signatures / التوقيعات</h2>
      <div class="sig-block">
        <div class="sig-col">
          <div class="sig-title">Customer / العميل</div>
          <div class="sig-caption">Name / الاسم</div>
          <div class="sig-line"></div>
          <div class="sig-caption">Signature / التوقيع</div>
          <div class="sig-line"></div>
          <div class="sig-caption">Date / التاريخ</div>
          <div class="sig-line"></div>
        </div>
        <div class="sig-col">
          <div class="sig-title">Sales Representative / مندوب المبيعات</div>
          <div class="sig-caption">Name / الاسم</div>
          <div class="sig-line"></div>
          <div class="sig-caption">Signature / التوقيع</div>
          <div class="sig-line"></div>
          <div class="sig-caption">Date / التاريخ</div>
          <div class="sig-line"></div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function printDisclosure() {
  const r = state.vinCheckResult;
  if (!r) return;
  const win = window.open('', '_blank');
  if (!win) {
    toast(t('vin.print_popup_blocked'), 'error');
    return;
  }
  win.document.open();
  win.document.write(buildDisclosureHtml(r));
  win.document.close();
  win.focus();
  // Give the new window a moment to lay out before invoking print — calling
  // it immediately (or before document.close()) can open a blank dialog in
  // some browsers.
  win.onload = () => { try { win.print(); } catch (e) { /* user can still use the on-page Print button */ } };
}

// ---------------------------------------------------------------- render -

function render() {
  const app = document.getElementById('app');
  if (!state.user) {
    app.innerHTML = loginHtml();
    return;
  }
  const role = state.user.role;
  const content = state.vinCheckOpen ? renderVinCheck()
    : role === 'SALES' ? renderSales()
    : role === 'SALES_MANAGER' ? renderSalesManager()
    : role === 'FINANCE' ? renderFinance()
    : role === 'AFTERSALES_TEAM' ? renderAftersalesTeam()
    : renderAdmin();
  app.innerHTML = shellHtml(content) + (state.changePasswordOpen ? changePasswordModalHtml() : '');
  wireTotals();
  animateCounts();
}

function changePasswordModalHtml() {
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-g4">
      <div class="card-light rounded-2xl p-g5 w-full max-w-sm">
        <div class="flex items-center justify-between mb-g4">
          <div class="font-display font-semibold text-[16px]">${t('account.change_password')}</div>
          <button class="btn btn-ghost-light btn-sm" data-action="close-change-password">${t('common.close')}</button>
        </div>
        <div class="flex flex-col gap-3">
          <div>
            <label class="block text-[11px] font-semibold uppercase tracking-wide text-ink/50 mb-1.5">${t('account.current_password')}</label>
            <input type="password" id="cp-current" dir="ltr" class="field-input" autocomplete="current-password">
          </div>
          <div>
            <label class="block text-[11px] font-semibold uppercase tracking-wide text-ink/50 mb-1.5">${t('account.new_password')}</label>
            <input type="password" id="cp-new" dir="ltr" class="field-input" autocomplete="new-password">
          </div>
          <div>
            <label class="block text-[11px] font-semibold uppercase tracking-wide text-ink/50 mb-1.5">${t('account.confirm_password')}</label>
            <input type="password" id="cp-confirm" dir="ltr" class="field-input" autocomplete="new-password">
          </div>
        </div>
        ${state.changePasswordError ? `<div class="bg-rose-50 text-rose-700 border border-rose-200 rounded-lg px-3 py-2.5 text-[13px] mt-g3">${esc(state.changePasswordError)}</div>` : ''}
        <div class="flex gap-2 mt-g4">
          <button class="btn btn-primary btn-sm flex-1" data-action="submit-change-password" ${state.changePasswordBusy ? 'disabled' : ''}>${state.changePasswordBusy ? t('common.saving') : t('common.save')}</button>
          <button class="btn btn-ghost-light btn-sm" data-action="close-change-password">${t('common.cancel')}</button>
        </div>
      </div>
    </div>`;
}

function wireTotals() {
  ['nr', 'rs', 'wi', 're'].forEach(recalcTotals);
}

function recalcTotals(prefix) {
  const totalsEl = document.getElementById(`${prefix}-totals`);
  if (!totalsEl) return;
  let count = 0, price = 0, hoursSum = 0;
  qa(`.${prefix}-check`).forEach(cb => {
    const row = cb.closest('.catalog-row');
    const qtyInput = row.querySelector(`.${prefix}-qty`);
    if (cb.checked) {
      row.classList.add('checked');
      qtyInput.style.display = 'block';
      const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
      count += 1;
      price += parseFloat(cb.dataset.price) * qty;
      hoursSum += parseFloat(cb.dataset.hours) * qty;
    } else {
      row.classList.remove('checked');
      qtyInput.style.display = 'none';
    }
  });
  totalsEl.innerHTML = `<span class="text-[12px] text-soft">${count} · ${hoursSum.toFixed(1)} ${t('common.labor_hours')}</span><strong class="font-display text-[17px]">${money(price)}</strong>`;
}

function collectCatalogSelection(prefix) {
  const items = [];
  qa(`.${prefix}-check`).forEach(cb => {
    if (cb.checked) {
      const row = cb.closest('.catalog-row');
      const qty = Math.max(1, parseInt(row.querySelector(`.${prefix}-qty`).value, 10) || 1);
      items.push({ serviceId: cb.dataset.serviceId, quantity: qty });
    }
  });
  return items;
}

// -------------------------------------------------------------- actions --

async function handleAction(action, el) {
  const id = el.dataset.id;
  try {
    switch (action) {
      case 'logout': logout(); return;
      case 'set-lang': I18N.setLang(el.dataset.lang); render(); return;

      case 'demo-login':
        await login(el.dataset.email, el.dataset.password);
        return;

      case 'submit-new-request': {
        const vin = q('#nr-vin').value.trim().toUpperCase();
        const items = collectCatalogSelection('nr');
        if (!items.length) { toast(t('toast.select_service_qty'), 'error'); return; }
        const created = await api('/api/requests', {
          method: 'POST',
          body: JSON.stringify({ vin, vehicleModel: q('#nr-model').value.trim(), items, comment: q('#nr-notes').value.trim() }),
        });
        toast(submissionToast(created.request.status), 'success');
        await refreshAll();
        return;
      }

      case 'submit-walkin': {
        const vin = q('#wi-vin').value.trim().toUpperCase();
        const items = collectCatalogSelection('wi');
        if (!items.length) { toast(t('toast.select_service_qty'), 'error'); return; }
        const created = await api('/api/requests/walk-in', {
          method: 'POST',
          body: JSON.stringify({ vin, vehicleModel: q('#wi-model').value.trim(), items, comment: q('#wi-comment').value.trim() }),
        });
        toast(submissionToast(created.request.status), 'success');
        state.walkinFormOpen = false;
        await refreshAll();
        return;
      }

      case 'select-request': await selectRequest(id); return;

      case 'submit-resubmit': {
        const vin = q('#rs-vin').value.trim().toUpperCase();
        const items = collectCatalogSelection('rs');
        if (!items.length) { toast(t('toast.select_service_qty'), 'error'); return; }
        const resubmitted = await api(`/api/requests/${id}/resubmit`, {
          method: 'PATCH',
          body: JSON.stringify({ vin, vehicleModel: q('#rs-model').value.trim(), items }),
        });
        toast(submissionToast(resubmitted.request.status), 'success');
        clearSelection(); await refreshAll();
        return;
      }

      case 'submit-resubmit-estimate': {
        const vin = q('#re-vin').value.trim().toUpperCase();
        const items = collectCatalogSelection('re');
        if (!items.length) { toast(t('toast.select_service_qty'), 'error'); return; }
        const resubmitted = await api(`/api/requests/${id}/resubmit-estimate`, {
          method: 'PATCH',
          body: JSON.stringify({ vin, vehicleModel: q('#re-model').value.trim(), items }),
        });
        toast(submissionToast(resubmitted.request.status), 'success');
        clearSelection(); await refreshAll();
        return;
      }

      case 'sm-approve':
        await api(`/api/requests/${id}/sales-manager-approve`, { method: 'POST', body: JSON.stringify({ comment: q('#sm-note')?.value }) });
        toast(t('toast.approved'), 'success');
        clearSelection(); await refreshAll(); return;

      case 'sm-reject': {
        const reason = q('#sm-note')?.value.trim();
        if (!reason) { toast(t('errors.REASON_REQUIRED'), 'error'); return; }
        await api(`/api/requests/${id}/sales-manager-reject`, { method: 'POST', body: JSON.stringify({ reason }) });
        toast(t('toast.rejected'), 'success');
        clearSelection(); await refreshAll(); return;
      }

      case 'sm-return': {
        const reason = q('#sm-note')?.value.trim();
        if (!reason) { toast(t('errors.REASON_REQUIRED'), 'error'); return; }
        await api(`/api/requests/${id}/sales-manager-return`, { method: 'POST', body: JSON.stringify({ reason }) });
        toast(t('toast.returned'), 'success');
        clearSelection(); await refreshAll(); return;
      }

      case 'stat-filter':
        state.reviewFilter = el.dataset.key === 'pending' ? null : el.dataset.key;
        clearSelection();
        render(); return;

      case 'open-walkin-form': state.walkinFormOpen = true; render(); return;
      case 'cancel-walkin-form': state.walkinFormOpen = false; render(); return;

      case 'sales-requests-subtab': state.salesRequestsTab = el.dataset.subtab; render(); return;
      case 'at-active-subtab': state.atActiveSubtab = el.dataset.subtab; render(); return;

      case 'finance-approve':
        await api(`/api/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ comment: q('#finance-note')?.value }) });
        toast(t('toast.approved'), 'success');
        clearSelection(); await refreshAll(); return;

      case 'finance-delegate':
        await api(`/api/requests/${id}/delegate`, { method: 'POST', body: JSON.stringify({ notes: q('#finance-note')?.value }) });
        toast(t('toast.delegated'), 'success');
        clearSelection(); await refreshAll(); return;

      case 'finance-return': {
        const reason = q('#finance-note')?.value.trim();
        if (!reason) { toast(t('errors.REASON_REQUIRED'), 'error'); return; }
        await api(`/api/requests/${id}/return`, { method: 'POST', body: JSON.stringify({ reason }) });
        toast(t('toast.returned'), 'success');
        clearSelection(); await refreshAll(); return;
      }

      case 'finance-reject': {
        const reason = q('#finance-note')?.value.trim();
        if (!reason) { toast(t('errors.REASON_REQUIRED'), 'error'); return; }
        await api(`/api/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
        toast(t('toast.rejected'), 'success');
        clearSelection(); await refreshAll(); return;
      }

      case 'at-tab':
        state.atTab = el.dataset.tab;
        clearSelection();
        render(); return;

      case 'sales-tab':
        state.salesTab = el.dataset.tab;
        clearSelection();
        render(); return;

      case 'open-new-service': state.catalogFormOpen = true; render(); return;
      case 'cancel-new-service': state.catalogFormOpen = false; render(); return;

      case 'open-bulk-import': state.bulkImportOpen = true; render(); return;
      case 'cancel-bulk-import': state.bulkImportOpen = false; render(); return;
      case 'download-template': downloadServiceTemplate(); return;
      case 'trigger-bulk-file': q('#bulk-import-file')?.click(); return;

      case 'create-service': {
        const body = {
          serviceCode: q('#new-code').value.trim(),
          description: q('#new-desc').value.trim(),
          category: q('#new-cat').value.trim(),
          laborHours: parseFloat(q('#new-hours').value),
          price: parseFloat(q('#new-price').value),
          approvalLevel: q('#new-approval-level').value,
        };
        await api('/api/services', { method: 'POST', body: JSON.stringify(body) });
        toast(t('toast.service_added'), 'success');
        state.catalogFormOpen = false;
        await refreshAll();
        return;
      }

      case 'edit-service': state.editingServiceId = id; render(); return;
      case 'cancel-edit-service': state.editingServiceId = null; render(); return;

      case 'save-service': {
        const body = {
          serviceCode: q('#edit-code').value.trim(),
          description: q('#edit-desc').value.trim(),
          category: q('#edit-cat').value.trim(),
          laborHours: parseFloat(q('#edit-hours').value),
          price: parseFloat(q('#edit-price').value),
          approvalLevel: q('#edit-approval-level').value,
        };
        await api(`/api/services/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast(t('toast.service_updated'), 'success');
        state.editingServiceId = null;
        await refreshAll();
        return;
      }

      case 'toggle-service': {
        const willBeActive = el.dataset.active !== 'true';
        await api(`/api/services/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: willBeActive }) });
        toast(willBeActive ? t('toast.service_activated') : t('toast.service_deactivated'), 'success');
        await refreshAll();
        return;
      }

      case 'delete-service': {
        const code = el.dataset.code || '';
        if (!confirm(t('admin.delete_confirm', { code }))) return;
        await api(`/api/services/${id}`, { method: 'DELETE' });
        toast(t('toast.service_deleted'), 'success');
        await refreshAll();
        return;
      }

      case 'save-item': {
        const reqId = el.dataset.req;
        const qty = parseInt(q(`#qty-${id}`).value, 10);
        const notes = q(`#notes-${id}`).value;
        await api(`/api/requests/${reqId}/estimation-items`, {
          method: 'PATCH',
          body: JSON.stringify({ items: [{ action: 'MODIFY', itemId: id, quantity: qty, notes }] }),
        });
        toast(t('toast.item_updated'), 'success');
        await refreshAll();
        return;
      }

      case 'remove-item': {
        const reqId = el.dataset.req;
        await api(`/api/requests/${reqId}/estimation-items`, {
          method: 'PATCH',
          body: JSON.stringify({ items: [{ action: 'REMOVE', itemId: id }] }),
        });
        toast(t('toast.item_removed'), 'success');
        await refreshAll();
        return;
      }

      case 'add-item': {
        const reqId = el.dataset.req;
        const serviceId = q('#add-service-select').value;
        const quantity = parseInt(q('#add-service-qty').value, 10) || 1;
        await api(`/api/requests/${reqId}/estimation-items`, {
          method: 'PATCH',
          body: JSON.stringify({ items: [{ action: 'ADD', serviceId, quantity }] }),
        });
        toast(t('toast.item_added'), 'success');
        await refreshAll();
        return;
      }

      case 'aftersales-resubmit':
        await api(`/api/requests/${id}/resubmit-to-finance`, { method: 'POST', body: JSON.stringify({}) });
        toast(t('toast.resubmitted_finance'), 'success');
        clearSelection(); await refreshAll();
        return;

      case 'close-request': {
        const commentEl = q(`#close-comment-${id}`);
        await api(`/api/requests/${id}/close`, { method: 'POST', body: JSON.stringify({ comment: commentEl?.value }) });
        toast(t('toast.request_closed'), 'success');
        await refreshAll();
        return;
      }

      case 'add-comment': {
        const input = q('#new-comment-text');
        const text = input?.value.trim();
        if (!text) { toast(t('errors.COMMENT_REQUIRED'), 'error'); return; }
        await api(`/api/requests/${id}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
        toast(t('toast.comment_added'), 'success');
        await refreshAll();
        return;
      }

      case 'admin-tab':
        state.adminTab = el.dataset.tab;
        render(); return;

      case 'open-new-account': state.accountFormOpen = true; render(); return;
      case 'cancel-new-account': state.accountFormOpen = false; render(); return;

      case 'create-account': {
        const role = q('#new-acc-role').value;
        const branchWrap = q('#new-account-branch-wrap');
        const branchVisible = !branchWrap || branchWrap.style.display !== 'none';
        const body = {
          fullName: q('#new-acc-name').value.trim(),
          email: q('#new-acc-email').value.trim(),
          password: q('#new-acc-password').value,
          role,
          branchId: branchVisible ? (q('#new-acc-branch')?.value || null) : null,
        };
        await api('/api/users', { method: 'POST', body: JSON.stringify(body) });
        toast(t('toast.account_created'), 'success');
        state.accountFormOpen = false;
        await refreshAll();
        return;
      }

      case 'toggle-user-active': {
        const willBeActive = el.dataset.active !== 'true';
        await api(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: willBeActive }) });
        toast(willBeActive ? t('toast.account_activated') : t('toast.account_deactivated'), 'success');
        await refreshAll();
        return;
      }

      case 'open-new-branch': state.branchFormOpen = true; render(); return;
      case 'cancel-new-branch': state.branchFormOpen = false; render(); return;

      case 'create-branch': {
        const body = {
          code: q('#new-branch-code').value.trim(),
          name: q('#new-branch-name').value.trim(),
        };
        await api('/api/branches', { method: 'POST', body: JSON.stringify(body) });
        toast(t('toast.branch_added'), 'success');
        state.branchFormOpen = false;
        await refreshAll();
        return;
      }

      case 'delete-branch': {
        const name = el.dataset.name || '';
        if (!confirm(t('admin.delete_branch_confirm', { name }))) return;
        await api(`/api/branches/${id}`, { method: 'DELETE' });
        toast(t('toast.branch_deleted'), 'success');
        await refreshAll();
        return;
      }

      case 'open-new-vehicle': state.vehicleFormOpen = true; render(); return;
      case 'cancel-new-vehicle': state.vehicleFormOpen = false; render(); return;

      case 'create-vehicle': {
        const body = {
          vin: q('#new-vehicle-vin').value.trim().toUpperCase(),
          ata: q('#new-vehicle-ata').value,
          purchaseDate: q('#new-vehicle-purchase').value,
          warrantyStartDate: q('#new-vehicle-warranty').value || undefined,
        };
        await api('/api/vehicles', { method: 'POST', body: JSON.stringify(body) });
        toast(t('toast.vehicle_added'), 'success');
        state.vehicleFormOpen = false;
        await refreshAll();
        return;
      }

      case 'edit-vehicle': state.editingVehicleId = id; render(); return;
      case 'cancel-edit-vehicle': state.editingVehicleId = null; render(); return;

      case 'save-vehicle': {
        const body = {
          vin: q('#edit-vehicle-vin').value.trim().toUpperCase(),
          ata: q('#edit-vehicle-ata').value,
          purchaseDate: q('#edit-vehicle-purchase').value,
          warrantyStartDate: q('#edit-vehicle-warranty').value || null,
        };
        await api(`/api/vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast(t('toast.vehicle_updated'), 'success');
        state.editingVehicleId = null;
        await refreshAll();
        return;
      }

      case 'delete-vehicle': {
        const vin = el.dataset.vin || '';
        if (!confirm(t('admin.delete_vehicle_confirm', { vin }))) return;
        await api(`/api/vehicles/${id}`, { method: 'DELETE' });
        toast(t('toast.vehicle_deleted'), 'success');
        await refreshAll();
        return;
      }

      case 'open-vehicle-bulk-import': state.vehicleBulkImportOpen = true; state.vehicleImportSummary = null; render(); return;
      case 'cancel-vehicle-bulk-import': state.vehicleBulkImportOpen = false; render(); return;
      case 'download-vehicle-template': downloadVehicleTemplate(); return;
      case 'trigger-vehicle-bulk-file': q('#vehicle-bulk-import-file')?.click(); return;

      case 'vehicles-page-prev':
        if (state.vehiclesPage > 1) { state.vehiclesPage -= 1; await loadVehiclesPage(); render(); }
        return;
      case 'vehicles-page-next':
        if (state.vehiclesPage < state.vehiclesTotalPages) { state.vehiclesPage += 1; await loadVehiclesPage(); render(); }
        return;

      case 'toggle-vin-check':
        state.vinCheckOpen = true;
        state.vinCheckResult = null;
        state.vinCheckError = '';
        render(); return;

      case 'close-vin-check':
        state.vinCheckOpen = false;
        render(); return;

      case 'submit-vin-check': {
        const vin = q('#vin-input')?.value.trim().toUpperCase();
        const purchaseDate = q('#vin-purchase-date')?.value;
        if (!vin || !purchaseDate) {
          state.vinCheckError = t('errors.VIN_REQUIRED');
          state.vinCheckResult = null;
          render();
          return;
        }
        try {
          const result = await api(`/api/vehicles/warranty-check?vin=${encodeURIComponent(vin)}&purchaseDate=${encodeURIComponent(purchaseDate)}`);
          state.vinCheckResult = result;
          state.vinCheckError = '';
        } catch (e) {
          state.vinCheckResult = null;
          state.vinCheckError = e.message;
        }
        render();
        return;
      }

      case 'print-vin-disclosure': printDisclosure(); return;

      case 'open-change-password':
        state.changePasswordOpen = true;
        state.changePasswordError = '';
        render(); return;

      case 'close-change-password':
        state.changePasswordOpen = false;
        state.changePasswordError = '';
        render(); return;

      case 'submit-change-password': {
        const currentPassword = q('#cp-current')?.value || '';
        const newPassword = q('#cp-new')?.value || '';
        const confirmPassword = q('#cp-confirm')?.value || '';
        if (!currentPassword || !newPassword || !confirmPassword) {
          state.changePasswordError = t('account.fields_required');
          render();
          return;
        }
        if (newPassword.length < 8) {
          state.changePasswordError = t('errors.WEAK_PASSWORD');
          render();
          return;
        }
        if (newPassword !== confirmPassword) {
          state.changePasswordError = t('account.password_mismatch');
          render();
          return;
        }
        state.changePasswordBusy = true;
        state.changePasswordError = '';
        render();
        try {
          await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword }),
          });
          state.changePasswordBusy = false;
          state.changePasswordOpen = false;
          state.changePasswordError = '';
          render();
          toast(t('account.password_changed'), 'success');
        } catch (e) {
          state.changePasswordBusy = false;
          state.changePasswordError = e.message;
          render();
        }
        return;
      }

      case 'open-vin-bulk-check': state.vinBulkOpen = true; state.vinBulkResult = null; render(); return;
      case 'cancel-vin-bulk-check': state.vinBulkOpen = false; render(); return;
      case 'download-vin-bulk-template': downloadVinBulkTemplate(); return;
      case 'trigger-vin-bulk-file': q('#vin-bulk-check-file')?.click(); return;
      case 'download-vin-bulk-results': downloadVinBulkResultsCsv(); return;

      default: return;
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ------------------------------------------------------------- listeners -

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.tagName === 'BUTTON') e.preventDefault();
  handleAction(el.dataset.action, el);
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-action="login-submit"]');
  if (!form) return;
  e.preventDefault();
  login(q('#login-email').value.trim(), q('#login-password').value);
});

document.addEventListener('change', (e) => {
  ['nr', 'rs', 'wi', 're'].forEach(p => {
    if (e.target.matches(`.${p}-check, .${p}-qty`)) recalcTotals(p);
  });
  if (e.target.id === 'bulk-import-file' && e.target.files && e.target.files[0]) {
    handleBulkImportFile(e.target.files[0]);
  }
  if (e.target.id === 'vehicle-bulk-import-file' && e.target.files && e.target.files[0]) {
    handleVehicleBulkImportFile(e.target.files[0]);
  }
  if (e.target.id === 'vin-bulk-check-file' && e.target.files && e.target.files[0]) {
    handleVinBulkCheckFile(e.target.files[0]);
  }
  // The "create account" form's branch field is only meaningful for Sales
  // Representative / Aftersales Team accounts, so it hides itself for every
  // other role as soon as the admin picks one.
  const roleSelect = e.target.closest('[data-action="account-role-change"]');
  if (roleSelect) {
    const wrap = document.getElementById('new-account-branch-wrap');
    if (wrap) wrap.style.display = ['SALES', 'AFTERSALES_TEAM'].includes(roleSelect.value) ? '' : 'none';
  }
});
document.addEventListener('input', (e) => {
  ['nr', 'rs', 'wi', 're'].forEach(p => {
    if (e.target.matches(`.${p}-qty`)) recalcTotals(p);
  });
  if (e.target.dataset && e.target.dataset.searchTarget) {
    filterRowsBySearch(e.target.dataset.searchTarget, e.target.dataset.searchSelector || '[data-search]', e.target.value);
  }
  // The vehicle table search is server-side (the table can hold hundreds of
  // thousands of rows, so this can't filter DOM rows the way the smaller
  // admin tables do) — debounce so we don't fire a request per keystroke.
  if (e.target.id === 'vehicles-search-input') {
    clearTimeout(vehiclesSearchTimer);
    const value = e.target.value;
    vehiclesSearchTimer = setTimeout(async () => {
      state.vehiclesSearch = value.trim();
      state.vehiclesPage = 1;
      await loadVehiclesPage();
      render();
      q('#vehicles-search-input')?.focus();
    }, 350);
  }
});

boot();
