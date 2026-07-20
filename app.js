/**
 * Piakarn Parking Space — Frontend Application
 * Single-Page App (vanilla JS, no build step)
 *
 * Requires in index.html (loaded before this file):
 *   - config.js  → window.APP_CONFIG
 *   - https://js.stripe.com/v3/
 *   - Google Maps JS API (loaded dynamically here)
 */

/* =====================================================
   0. CONFIG & CONSTANTS
===================================================== */
const CFG = window.APP_CONFIG || {};
const API_URL          = CFG.APPS_SCRIPT_API_URL   || '';
const STRIPE_PUB_KEY   = CFG.STRIPE_PUBLISHABLE_KEY || '';
const MAPS_KEY         = CFG.GOOGLE_MAPS_API_KEY    || '';

const BOOKING_AMOUNT   = 50;   // ฿ (ค่าบริการคงที่ตัวอย่าง)
const ETA_DEFAULT_SEC  = 45 * 60; // 45 minutes in seconds
const OWNER_POLL_INTERVAL_MS = 5000;
const DRIVER_POLL_INTERVAL_MS = 3000;
const OWNER_HEARTBEAT_INTERVAL_MS = 60000;
const MATCH_RETRY_ATTEMPTS = 5;
const MATCH_RETRY_INTERVAL_MS = 1500;

/* =====================================================
   1. STATE
===================================================== */
const state = {
  user:          null,    // { user_id, name, phone, role, ... }
  booking:       null,    // { booking_id, driver_id, owner_id, status, ... }
  ownerBooking:  null,    // pending booking waiting for owner to accept

  mapDriver:     null,    // google.maps.Map instance (driver)
  mapOwner:      null,    // google.maps.Map instance (owner)
  driverMarker:  null,
  driverPos:     null,    // { lat, lng }

  countdown:     null,    // setInterval handle
  countdownSec:  ETA_DEFAULT_SEC,
  countdownStarted: false,

  stripe:        null,    // Stripe instance
  stripeElements:null,
  paymentEl:     null,    // Stripe Payment Element
  clientSecret:  null,
  paymentBookingId: null,

  driverPoll:    null,
  driverPollBusy:false,
  ownerPoll:     null,
  ownerHeartbeat:null,
  ownerPos:      null,
  selectedRating: 0,
  passwordResetPhone: null,
  passwordResetCooldown: null,
};

/* =====================================================
   2. UTILITIES
===================================================== */

/** Show exactly one view by ID */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  requestAnimationFrame(refreshIcons);
}

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
  }
}

function setButtonLoading(button, label) {
  if (!button) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${label}</span>`;
}

function resetButton(button, html) {
  if (!button) return;
  button.disabled = false;
  button.removeAttribute('aria-busy');
  button.innerHTML = html;
  refreshIcons();
}

/** GET or POST to Apps Script Web App */
async function api(action, body = null) {
  if (!API_URL) throw new Error('กรุณาตั้งค่า APPS_SCRIPT_API_URL ใน config.js ก่อนใช้งาน');
  const url = `${API_URL}?action=${action}`;
  // ใช้ text/plain เพื่อหลีกเลี่ยง CORS preflight ที่ Apps Script ไม่รองรับ
  // Apps Script อ่าน JSON body ได้ผ่าน e.postData.contents อยู่แล้ว
  const opts = body
    ? { method: 'POST', body: JSON.stringify({ ...body, action }), headers: { 'Content-Type': 'text/plain;charset=utf-8' } }
    : { method: 'GET' };
  const res  = await fetch(url, opts);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'API error');
  return json;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findNearestOwnerWithRetry(bookingId) {
  let lastError = null;
  for (let attempt = 1; attempt <= MATCH_RETRY_ATTEMPTS; attempt++) {
    try {
      return await api('findNearestOwner', { booking_id: bookingId });
    } catch (err) {
      lastError = err;
      const retryable = err.message.includes('ยังไม่มีเจ้าของสิทธิ์ที่พร้อมรับงาน') ||
        err.message.includes('ระบบกำลังจับคู่คำขออื่น');
      if (!retryable || attempt === MATCH_RETRY_ATTEMPTS) throw err;
      await wait(MATCH_RETRY_INTERVAL_MS);
    }
  }
  throw lastError;
}

/** Persist session to localStorage */
function saveSession() {
  if (state.user) localStorage.setItem('pkn_user', JSON.stringify(state.user));
  else            localStorage.removeItem('pkn_user');
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem('pkn_user')); }
  catch { return null; }
}

function logout() {
  const previousUser = state.user;
  if (previousUser && previousUser.role === 'owner') {
    api('updateOwnerAvailability', {
      owner_id: previousUser.user_id,
      available: false
    }).catch(err => console.warn('Owner availability:', err.message));
  }
  state.user    = null;
  state.booking = null;
  resetPaymentState();
  clearCountdown(true);
  clearDriverPoll();
  clearOwnerPoll();
  saveSession();
  showView('view-login');
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) { console.error(`showError: element #${elId} not found`, msg); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(elId) {
  const el = document.getElementById(elId);
  if (el) el.classList.add('hidden');
}

function showForgotPasswordStep(step) {
  const requestStep = document.getElementById('forgot-step-request');
  const resetStep = document.getElementById('forgot-step-reset');
  if (requestStep) requestStep.classList.toggle('hidden', step !== 'request');
  if (resetStep) resetStep.classList.toggle('hidden', step !== 'reset');
  hideError('forgot-request-error');
  hideError('forgot-reset-error');
  requestAnimationFrame(refreshIcons);
}

function maskThaiPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('66')) digits = digits.slice(2);
  digits = digits.replace(/^0+/, '');
  if (digits.length !== 9) return String(phone || '');
  return `0${digits.slice(0, 2)} *** ${digits.slice(-4)}`;
}

function clearPasswordResetCooldown() {
  if (state.passwordResetCooldown) {
    clearInterval(state.passwordResetCooldown);
    state.passwordResetCooldown = null;
  }
  const button = document.getElementById('forgot-resend-code');
  const label = button && button.querySelector('span');
  if (button) button.disabled = false;
  if (label) label.textContent = 'ส่งรหัสอีกครั้ง';
}

function startPasswordResetCooldown(totalSeconds) {
  clearPasswordResetCooldown();
  const button = document.getElementById('forgot-resend-code');
  const label = button && button.querySelector('span');
  let remaining = Math.max(1, Number(totalSeconds) || 60);
  if (!button || !label) return;

  const render = () => {
    button.disabled = remaining > 0;
    label.textContent = remaining > 0 ? `ส่งใหม่ใน ${remaining} วินาที` : 'ส่งรหัสอีกครั้ง';
  };
  render();
  state.passwordResetCooldown = setInterval(() => {
    remaining--;
    render();
    if (remaining <= 0) clearPasswordResetCooldown();
  }, 1000);
}

/* =====================================================
   3. GOOGLE MAPS
===================================================== */

/** Dynamically load Maps JS API, then call callback */
function loadMapsApi(callback) {
  if (window.google && window.google.maps) { callback(); return; }
  if (!MAPS_KEY) { console.warn('GOOGLE_MAPS_API_KEY not set — map disabled'); return; }
  window.__mapsCallback = callback;
  const script   = document.createElement('script');
  script.src     = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&callback=__mapsCallback`;
  script.async   = true;
  script.defer   = true;
  document.head.appendChild(script);
}

function initDriverMap() {
  loadMapsApi(() => {
    const center = state.driverPos
      ? { lat: state.driverPos.lat, lng: state.driverPos.lng }
      : { lat: 13.7563, lng: 100.5018 }; // Bangkok default

    state.mapDriver = new google.maps.Map(document.getElementById('map-driver'), {
      center,
      zoom: 15,
      disableDefaultUI: true,
      styles: parkingMapStyle(),
    });

    if (state.driverPos) {
      state.driverMarker = new google.maps.Marker({
        position: center,
        map: state.mapDriver,
        title: 'ตำแหน่งของคุณ',
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10,
          fillColor: '#0B7465', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
      });
    }
  });
}

function initOwnerMap(driverLat, driverLng) {
  const container = document.getElementById('map-owner');
  if (!container) return;
  loadMapsApi(() => {
    const center = { lat: driverLat, lng: driverLng };
    state.mapOwner = new google.maps.Map(container, {
      center, zoom: 15,
      disableDefaultUI: true,
      styles: parkingMapStyle(),
    });
    new google.maps.Marker({ position: center, map: state.mapOwner,
      title: 'ตำแหน่งผู้ขับขี่',
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10,
        fillColor: '#E95D49', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
    });
  });
}

/** Quiet map styling keeps routes readable behind the booking panel. */
function parkingMapStyle() {
  return [
    { elementType: 'geometry', stylers: [{ color: '#e4ebe7' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#f7f9f8' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#65746d' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#d4ded9' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#f3e4bc' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#cbdde3' }] },
    { featureType: 'landscape.man_made', stylers: [{ color: '#edf1ef' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#d2e6d8' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  ];
}

/** Get current GPS position */
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation ไม่รองรับ'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(new Error('ไม่สามารถรับตำแหน่งได้: ' + err.message)),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

/* =====================================================
   4. COUNTDOWN TIMER
===================================================== */

const CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 (from SVG)

function startCountdown(totalSec) {
  state.countdownSec = totalSec;
  state.countdownStarted = true;
  const circle = document.getElementById('progress-circle');
  const minEl  = document.getElementById('countdown-min');
  const unitEl = document.querySelector('.countdown-unit');
  if (unitEl) unitEl.textContent = 'นาที';

  // Initialise stroke
  if (circle) {
    circle.style.strokeDasharray  = CIRCUMFERENCE;
    circle.style.strokeDashoffset = 0;
  }

  function tick() {
    const mins = Math.floor(state.countdownSec / 60);
    if (minEl) minEl.textContent = mins;

    // SVG progress bar (drains from full → empty)
    const progress = state.countdownSec / totalSec;
    if (circle) circle.style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);

    if (state.countdownSec <= 0) {
      clearCountdown();
      onCountdownEnd();
      return;
    }
    state.countdownSec--;
  }

  tick();
  state.countdown = setInterval(tick, 1000);
}

function clearCountdown(resetStarted = false) {
  if (state.countdown) { clearInterval(state.countdown); state.countdown = null; }
  if (resetStarted) state.countdownStarted = false;
}

function onCountdownEnd() {
  const btn  = document.getElementById('btn-proceed-payment');
  const note = document.getElementById('payment-note');
  if (btn) btn.disabled = true;
  if (note) note.textContent = 'ใช้เวลานานกว่าที่คาด ระบบยังรอเจ้าของสิทธิ์ยืนยันว่ามาถึงแล้ว';
}

/* =====================================================
   5. STRIPE
===================================================== */

async function initStripe(clientSecret) {
  if (!STRIPE_PUB_KEY) throw new Error('STRIPE_PUBLISHABLE_KEY ยังไม่ได้ตั้งค่าใน config.js');
  if (typeof window.Stripe !== 'function') throw new Error('โหลด Stripe.js ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต');
  if (!clientSecret) throw new Error('ไม่ได้รับ client secret จากระบบชำระเงิน');

  state.stripe = Stripe(STRIPE_PUB_KEY);
  state.stripeElements = state.stripe.elements({ clientSecret, appearance: stripeAppearance() });
  state.paymentEl      = state.stripeElements.create('payment');
  state.paymentEl.mount('#stripe-payment-element');
}

function resetPaymentState() {
  if (state.paymentEl) {
    try { state.paymentEl.destroy(); } catch { /* Element may already be detached. */ }
  }
  state.stripe = null;
  state.stripeElements = null;
  state.paymentEl = null;
  state.clientSecret = null;
  state.paymentBookingId = null;
  const container = document.getElementById('stripe-payment-element');
  if (container) container.innerHTML = '';
}

function renderPaymentAmount(amount) {
  const value = Number(amount);
  const formatted = Number.isFinite(value) ? value.toFixed(2) : BOOKING_AMOUNT.toFixed(2);
  document.getElementById('payment-amount-display').textContent = `฿${formatted}`;
  document.getElementById('payment-total-display').textContent = `฿${formatted}`;
}

function paymentStatusMessage(status) {
  const messages = {
    processing: 'Stripe กำลังประมวลผลรายการ กรุณารอสักครู่แล้วลองตรวจสอบอีกครั้ง',
    requires_action: 'กรุณายืนยันการชำระเงินตามขั้นตอนของธนาคาร',
    requires_payment_method: 'การชำระเงินไม่สำเร็จ กรุณาตรวจสอบข้อมูลหรือเลือกวิธีอื่น',
    canceled: 'รายการชำระเงินถูกยกเลิก กรุณากลับไปเริ่มใหม่'
  };
  return messages[status] || 'ยังไม่สามารถยืนยันการชำระเงินได้ กรุณาลองอีกครั้ง';
}

function stripeAppearance() {
  return {
    theme: 'stripe',
    variables: {
      colorPrimary:       '#0B7465',
      colorBackground:    '#FFFFFF',
      colorText:          '#17211E',
      colorDanger:        '#B83F30',
      fontFamily:         'IBM Plex Sans Thai, sans-serif',
      borderRadius:       '6px',
      spacingUnit:        '4px',
    },
  };
}

/* =====================================================
   6. HISTORY RENDERER
===================================================== */

function renderHistoryItems(bookings, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!bookings || bookings.length === 0) {
    el.innerHTML = '<p class="history-empty"><i data-lucide="inbox"></i><span>ยังไม่มีประวัติการให้บริการ</span></p>';
    refreshIcons();
    return;
  }
  el.innerHTML = bookings
    .slice()
    .sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at))
    .map(b => {
      const date = b.requested_at
        ? new Date(b.requested_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      return `
        <div class="history-item">
          <div class="history-item-left">
            <span class="history-item-id">ID: ${b.booking_id}</span>
            <span class="history-item-date">${date}</span>
          </div>
          <div class="history-item-right">
            <span class="badge badge-${b.status}">${statusLabel(b.status)}</span>
          </div>
        </div>`;
    })
    .join('');
  refreshIcons();
}

function statusLabel(s) {
  const MAP = { pending: 'รอจับคู่', matched: 'รอตอบรับ', waiting: 'กำลังเดินทาง', arrived: 'ถึงแล้ว', completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก' };
  return MAP[s] || s;
}

/* =====================================================
   7. BOOKING POLLING
===================================================== */

function showMatchingPanel(panel) {
  const panels = {
    searching: document.getElementById('matching-searching'),
    found: document.getElementById('matching-found'),
    error: document.getElementById('matching-error-state')
  };
  Object.entries(panels).forEach(([name, element]) => {
    if (element) element.classList.toggle('hidden', name !== panel);
  });
}

function showAwaitingOwnerResponse() {
  showMatchingPanel('searching');
  const kicker = document.getElementById('matching-kicker');
  const title = document.getElementById('matching-search-title');
  const desc = document.getElementById('matching-search-desc');
  if (kicker) kicker.textContent = 'ส่งคำขอแล้ว';
  if (title) title.innerHTML = 'กำลังรอเจ้าของสิทธิ์<br />ตอบรับคำขอ';
  if (desc) desc.innerHTML = '<span class="loading-dots"><span></span><span></span><span></span></span> ระบบจะอัปเดตทันทีเมื่อมีการตอบรับ';
}

function showOwnerTravelling(booking) {
  showMatchingPanel('found');
  const title = document.getElementById('matching-found-title');
  const ownerTitle = document.getElementById('owner-progress-title');
  const etaLabel = document.getElementById('eta-label');
  const paymentButton = document.getElementById('btn-proceed-payment');
  const paymentNote = document.getElementById('payment-note');
  if (title) title.innerHTML = 'เจ้าของสิทธิ์<br />กำลังเดินทางมา';
  if (ownerTitle) ownerTitle.textContent = 'กำลังมุ่งหน้ามาหาคุณ';
  if (etaLabel) etaLabel.textContent = `${Number(booking.eta_minutes) || 45} นาที`;
  if (paymentButton) paymentButton.disabled = true;
  if (paymentNote) paymentNote.textContent = 'ระบบจะเปิดการชำระเงินเมื่อเจ้าของสิทธิ์ยืนยันว่ามาถึงแล้ว';
  if (!state.countdownStarted) startCountdown((Number(booking.eta_minutes) || 45) * 60);
}

function showOwnerArrived() {
  showMatchingPanel('found');
  clearCountdown();
  const title = document.getElementById('matching-found-title');
  const ownerTitle = document.getElementById('owner-progress-title');
  const minEl = document.getElementById('countdown-min');
  const unitEl = document.querySelector('.countdown-unit');
  const paymentButton = document.getElementById('btn-proceed-payment');
  const paymentNote = document.getElementById('payment-note');
  if (title) title.innerHTML = 'เจ้าของสิทธิ์<br />มาถึงแล้ว';
  if (ownerTitle) ownerTitle.textContent = 'พร้อมส่งมอบสิทธิ์จอดให้คุณ';
  if (minEl) minEl.textContent = '0';
  if (unitEl) unitEl.textContent = 'ถึงแล้ว';
  if (paymentButton) paymentButton.disabled = false;
  if (paymentNote) paymentNote.textContent = 'ตรวจสอบสิทธิ์กับเจ้าของแล้วดำเนินการชำระเงิน';
}

function showMatchingFailure(message) {
  clearDriverPoll();
  clearCountdown(true);
  showMatchingPanel('error');
  const messageEl = document.getElementById('matching-error-message');
  if (messageEl) messageEl.textContent = message;
}

function startDriverPoll() {
  if (state.driverPoll) return;
  pollDriverBooking();
  state.driverPoll = setInterval(pollDriverBooking, DRIVER_POLL_INTERVAL_MS);
}

function clearDriverPoll() {
  if (state.driverPoll) {
    clearInterval(state.driverPoll);
    state.driverPoll = null;
  }
  state.driverPollBusy = false;
}

async function pollDriverBooking() {
  if (!state.booking || state.driverPollBusy) return;
  state.driverPollBusy = true;
  try {
    const res = await api(`listBookings&booking_id=${encodeURIComponent(state.booking.booking_id)}`);
    const booking = (res.data || []).find(item => String(item.booking_id) === String(state.booking.booking_id));
    if (!booking) return;
    state.booking = { ...state.booking, ...booking };

    if (booking.status === 'matched') showAwaitingOwnerResponse();
    if (booking.status === 'waiting') showOwnerTravelling(booking);
    if (booking.status === 'arrived') showOwnerArrived();
    if (booking.status === 'cancelled') {
      state.booking = null;
      showMatchingFailure('เจ้าของสิทธิ์ไม่สะดวกรับงาน กรุณาสร้างคำขอใหม่');
    }
    if (booking.status === 'completed') clearDriverPoll();
  } catch (err) {
    console.error('Driver poll error:', err.message);
  } finally {
    state.driverPollBusy = false;
  }
}

async function restoreDriverBooking() {
  if (!state.user || state.user.role !== 'driver') return;
  const res = await api(`listBookings&driver_id=${encodeURIComponent(state.user.user_id)}`);
  const active = (res.data || [])
    .filter(booking => ['matched', 'waiting', 'arrived'].includes(booking.status))
    .sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at))[0];
  if (!active) return;

  state.booking = active;
  state.countdownStarted = false;
  showView('view-matching');
  if (active.status === 'matched') showAwaitingOwnerResponse();
  if (active.status === 'waiting') showOwnerTravelling(active);
  if (active.status === 'arrived') showOwnerArrived();
  startDriverPoll();
}

async function updateOwnerAvailability(available) {
  if (!state.user || state.user.role !== 'owner') return;
  const body = {
    owner_id: state.user.user_id,
    available: available
  };
  if (state.ownerPos) {
    body.lat = state.ownerPos.lat;
    body.lng = state.ownerPos.lng;
  }
  return api('updateOwnerAvailability', body);
}

function startOwnerHeartbeat() {
  if (state.ownerHeartbeat) return;
  state.ownerHeartbeat = setInterval(() => {
    const toggle = document.getElementById('owner-available-toggle');
    if (toggle && toggle.checked) {
      updateOwnerAvailability(true).catch(err => console.warn('Owner heartbeat:', err.message));
    }
  }, OWNER_HEARTBEAT_INTERVAL_MS);
}

function startOwnerPoll() {
  if (state.ownerPoll) return;
  pollOwnerBookings(); // immediate first call
  state.ownerPoll = setInterval(pollOwnerBookings, OWNER_POLL_INTERVAL_MS);
  startOwnerHeartbeat();
}

function clearOwnerPoll() {
  if (state.ownerPoll) { clearInterval(state.ownerPoll); state.ownerPoll = null; }
  if (state.ownerHeartbeat) { clearInterval(state.ownerHeartbeat); state.ownerHeartbeat = null; }
}

async function pollOwnerBookings() {
  if (!state.user || state.user.role !== 'owner') return;
  try {
    const res = await api(`listBookings&owner_id=${state.user.user_id}`);
    const bookings = res.data || [];

    // Update history
    renderHistoryItems(bookings, 'owner-history-list');

    const incoming = bookings.find(b => b.status === 'matched');
    const active = bookings.find(b => b.status === 'waiting');
    if (active) {
      state.ownerBooking = active;
      document.getElementById('owner-incoming-card').classList.add('hidden');
      showActiveBookingCard(active);
    } else if (incoming) {
      state.ownerBooking = incoming;
      document.getElementById('owner-active-card').classList.add('hidden');
      showIncomingRequest(incoming);
    } else {
      state.ownerBooking = null;
      document.getElementById('owner-incoming-card').classList.add('hidden');
      document.getElementById('owner-active-card').classList.add('hidden');
    }
  } catch (err) {
    console.error('Owner poll error:', err.message);
  }
}

function showIncomingRequest(booking) {
  const card = document.getElementById('owner-incoming-card');
  const locEl = document.getElementById('incoming-location');
  const plateEl = document.getElementById('incoming-driver-plate');
  if (!card) return;
  card.classList.remove('hidden');
  if (plateEl) plateEl.textContent = booking.driver_plate || 'ไม่ระบุทะเบียนรถ';
  if (locEl) locEl.textContent = `พิกัด ${Number(booking.lat).toFixed(4)}, ${Number(booking.lng).toFixed(4)}`;
}

function showActiveBookingCard(booking) {
  const card = document.getElementById('owner-active-card');
  const plateEl = document.getElementById('active-driver-plate');
  const shouldInitMap = card && card.classList.contains('hidden');
  if (card) card.classList.remove('hidden');
  if (plateEl) plateEl.textContent = booking.driver_plate || 'ไม่ระบุทะเบียนรถ';
  if (shouldInitMap && booking.lat && booking.lng) initOwnerMap(Number(booking.lat), Number(booking.lng));
}

/* =====================================================
   8. EVENT HANDLERS — AUTH
===================================================== */

// Login form
document.getElementById('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('login-error');
  hideError('login-success');
  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  const phone    = document.getElementById('login-phone').value.trim();
  const password = document.getElementById('login-password').value;
  if (!phone || !password) { showError('login-error', 'กรุณากรอกข้อมูลให้ครบ'); return; }
  setButtonLoading(submitButton, 'กำลังเข้าสู่ระบบ');
  try {
    const res  = await api('login', { phone, password });
    state.user = res.user;
    saveSession();
    afterLogin();
  } catch (err) {
    showError('login-error', err.message);
  } finally {
    resetButton(submitButton, '<span>เข้าสู่ระบบ</span><i data-lucide="arrow-right"></i>');
  }
});

document.getElementById('go-forgot-password').addEventListener('click', e => {
  e.preventDefault();
  clearPasswordResetCooldown();
  state.passwordResetPhone = null;
  hideError('login-error');
  hideError('login-success');
  document.getElementById('form-forgot-request').reset();
  document.getElementById('form-forgot-reset').reset();
  document.getElementById('forgot-phone').value = document.getElementById('login-phone').value.trim();
  showForgotPasswordStep('request');
  showView('view-forgot-password');
});

document.getElementById('forgot-back').addEventListener('click', () => {
  clearPasswordResetCooldown();
  state.passwordResetPhone = null;
  showView('view-login');
});

document.getElementById('forgot-change-phone').addEventListener('click', () => {
  clearPasswordResetCooldown();
  state.passwordResetPhone = null;
  document.getElementById('form-forgot-reset').reset();
  showForgotPasswordStep('request');
  document.getElementById('forgot-phone').focus();
});

document.getElementById('form-forgot-request').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('forgot-request-error');
  const button = e.currentTarget.querySelector('button[type="submit"]');
  const phone = document.getElementById('forgot-phone').value.trim();
  if (!phone) {
    showError('forgot-request-error', 'กรุณากรอกเบอร์โทรศัพท์');
    return;
  }

  setButtonLoading(button, 'กำลังส่งรหัส');
  try {
    const res = await api('requestPasswordReset', { phone });
    state.passwordResetPhone = phone;
    document.getElementById('forgot-phone-display').textContent = maskThaiPhone(phone);
    showForgotPasswordStep('reset');
    startPasswordResetCooldown(res.retry_after || 60);
    requestAnimationFrame(() => document.getElementById('forgot-code').focus());
  } catch (err) {
    showError('forgot-request-error', err.message);
  } finally {
    resetButton(button, '<i data-lucide="message-square-more"></i><span>ส่งรหัสทาง SMS</span>');
  }
});

document.getElementById('forgot-resend-code').addEventListener('click', async e => {
  if (!state.passwordResetPhone) return;
  hideError('forgot-reset-error');
  const button = e.currentTarget;
  let retryAfter = 0;
  setButtonLoading(button, 'กำลังส่ง');
  try {
    const res = await api('requestPasswordReset', { phone: state.passwordResetPhone });
    retryAfter = res.retry_after || 60;
  } catch (err) {
    showError('forgot-reset-error', err.message);
  } finally {
    resetButton(button, '<i data-lucide="refresh-cw"></i><span>ส่งรหัสอีกครั้ง</span>');
  }
  if (retryAfter) startPasswordResetCooldown(retryAfter);
});

document.getElementById('form-forgot-reset').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('forgot-reset-error');
  const form = e.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const code = document.getElementById('forgot-code').value.trim();
  const password = document.getElementById('forgot-new-password').value;
  const confirmPassword = document.getElementById('forgot-confirm-password').value;

  if (!/^\d{6}$/.test(code)) {
    showError('forgot-reset-error', 'กรุณากรอกรหัสยืนยัน 6 หลัก');
    return;
  }
  if (password.length < 8) {
    showError('forgot-reset-error', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
    return;
  }
  if (password !== confirmPassword) {
    showError('forgot-reset-error', 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
    return;
  }
  if (!state.passwordResetPhone) {
    showError('forgot-reset-error', 'ไม่พบเบอร์โทรศัพท์ กรุณาขอรหัสใหม่');
    return;
  }

  setButtonLoading(button, 'กำลังบันทึกรหัสผ่าน');
  try {
    await api('resetPassword', {
      phone: state.passwordResetPhone,
      code,
      password,
    });
    const resetPhone = state.passwordResetPhone;
    clearPasswordResetCooldown();
    state.passwordResetPhone = null;
    document.getElementById('login-phone').value = resetPhone;
    document.getElementById('login-password').value = '';
    document.getElementById('login-success').textContent = 'ตั้งรหัสผ่านใหม่สำเร็จ กรุณาเข้าสู่ระบบ';
    document.getElementById('login-success').classList.remove('hidden');
    hideError('login-error');
    form.reset();
    showForgotPasswordStep('request');
    showView('view-login');
  } catch (err) {
    showError('forgot-reset-error', err.message);
  } finally {
    resetButton(button, '<i data-lucide="key-round"></i><span>บันทึกรหัสผ่านใหม่</span>');
  }
});

// Register form
document.getElementById('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('reg-error');
  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  const name     = document.getElementById('reg-name').value.trim();
  const phone    = document.getElementById('reg-phone').value.trim();
  const password = document.getElementById('reg-password').value;
  const role     = document.querySelector('input[name="role"]:checked')?.value || 'driver';
  const plate    = role === 'driver' ? document.getElementById('reg-plate').value.trim() : '';
  const permit   = role === 'owner' ? document.getElementById('reg-permit').value.trim() : '';
  if (!name || !phone || !password) { showError('reg-error', 'กรุณากรอกข้อมูลให้ครบ'); return; }
  if (password.length < 8)          { showError('reg-error', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'); return; }
  setButtonLoading(submitButton, 'กำลังสร้างบัญชี');
  try {
    const res  = await api('register', { name, phone, password, role, plate, permit_type: permit });
    state.user = res.user;
    saveSession();
    afterLogin();
  } catch (err) {
    showError('reg-error', err.message);
  } finally {
    resetButton(submitButton, '<span>สร้างบัญชี</span><i data-lucide="arrow-right"></i>');
  }
});

// Navigate between login/register
document.getElementById('go-register').addEventListener('click', e => { e.preventDefault(); showView('view-register'); });
document.getElementById('go-login').addEventListener('click', e => {
  e.preventDefault();
  hideError('login-success');
  showView('view-login');
});
document.getElementById('reg-back').addEventListener('click', () => {
  hideError('login-success');
  showView('view-login');
});

// Role toggle — show only the fields that belong to the selected role
document.querySelectorAll('input[name="role"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const driverFields = document.getElementById('driver-fields');
    const ownerFields = document.getElementById('owner-fields');
    const selectedRole = document.querySelector('input[name="role"]:checked')?.value || 'driver';
    driverFields.classList.toggle('hidden', selectedRole !== 'driver');
    ownerFields.classList.toggle('hidden', selectedRole !== 'owner');
  });
});

function afterLogin() {
  if (state.user.role === 'owner') {
    const ownerNameEl = document.getElementById('owner-name');
    if (ownerNameEl) ownerNameEl.textContent = state.user.name;
    showView('view-owner-dashboard');
    updateOwnerAvailability(true)
      .then(() => {
        renderOwnerAvailability(true);
        startOwnerPoll();
        getCurrentPosition()
          .then(pos => {
            state.ownerPos = pos;
            return updateOwnerAvailability(true);
          })
          .catch(err => console.warn('Owner GPS:', err.message));
      })
      .catch(err => {
        console.error('Owner availability:', err.message);
        renderOwnerAvailability(false, 'เชื่อมต่อสถานะรับงานไม่สำเร็จ');
        const toggle = document.getElementById('owner-available-toggle');
        if (toggle) toggle.checked = false;
        clearOwnerPoll();
      });
  } else {
    const driverNameEl = document.getElementById('driver-name');
    if (driverNameEl) driverNameEl.textContent = state.user.name;
    showView('view-home-driver');
    initDriverMap();
    restoreDriverBooking().catch(err => console.warn('Restore booking:', err.message));
    // Get GPS position
    getCurrentPosition().then(pos => {
      state.driverPos = pos;
      if (state.mapDriver) {
        state.mapDriver.setCenter(pos);
        if (state.driverMarker) state.driverMarker.setPosition(pos);
        else state.driverMarker = new google.maps.Marker({
          position: pos, map: state.mapDriver,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10,
            fillColor: '#0B7465', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
        });
      }
    }).catch(err => console.warn('GPS:', err.message));
  }
}

function renderOwnerAvailability(available, noteOverride = '') {
  const title = document.getElementById('owner-status-title');
  const note  = document.getElementById('owner-status-note');
  const dot   = document.getElementById('owner-status-dot');
  if (title) title.textContent = available ? 'พร้อมรับงาน' : 'พักรับงาน';
  if (note) note.textContent = noteOverride || (available
    ? 'ระบบกำลังค้นหาคำขอใกล้คุณ'
    : 'ระบบหยุดค้นหาคำขอชั่วคราว');
  if (dot) dot.classList.toggle('is-off', !available);
}

// Logout buttons
document.getElementById('driver-logout').addEventListener('click', logout);
document.getElementById('owner-logout').addEventListener('click',  logout);

/* =====================================================
   9. EVENT HANDLERS — DRIVER BOOKING FLOW
===================================================== */

/** Step 1: Driver requests parking */
document.getElementById('btn-request-parking').addEventListener('click', async e => {
  if (!state.user) return;
  const requestButton = e.currentTarget;
  setButtonLoading(requestButton, 'กำลังระบุตำแหน่ง');
  clearDriverPoll();
  clearCountdown(true);
  try {
    // 1. Ensure we have a GPS position
    if (!state.driverPos) {
      state.driverPos = await getCurrentPosition().catch(() => ({ lat: 13.7563, lng: 100.5018 }));
    }

    // 2. Create booking (status=pending)
    const res     = await api('requestBooking', {
      driver_id: state.user.user_id,
      lat:       state.driverPos.lat,
      lng:       state.driverPos.lng,
    });
    state.booking = res.booking;

    // 3. Go to matching screen — searching state
    showView('view-matching');
    showMatchingPanel('searching');
    document.getElementById('matching-kicker').textContent = 'กำลังจับคู่';
    document.getElementById('matching-search-title').innerHTML = 'กำลังหาสิทธิ์จอด<br />ใกล้ตำแหน่งของคุณ';
    document.getElementById('matching-search-desc').innerHTML = '<span class="loading-dots"><span></span><span></span><span></span></span> ตรวจสอบเจ้าของสิทธิ์ในรัศมีใกล้เคียง';

    // 4. Allow a short window for an owner who just opened the dashboard.
    try {
      const match = await findNearestOwnerWithRetry(state.booking.booking_id);
      state.booking.owner_id   = match.owner_id;
      state.booking.eta_minutes = match.eta_minutes;
      state.booking.status     = 'matched';
      showAwaitingOwnerResponse();
      startDriverPoll();
    } catch (err) {
      const failedBooking = state.booking;
      if (failedBooking) {
        api('updateBookingStatus', {
          booking_id: failedBooking.booking_id,
          status: 'cancelled'
        }).catch(() => {});
      }
      state.booking = null;
      showMatchingFailure(err.message);
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    resetButton(requestButton, '<i data-lucide="navigation"></i><span>หาที่จอดด่วน</span><i data-lucide="arrow-up-right"></i>');
  }
});

/** Step 2: Driver cancels booking */
document.getElementById('btn-cancel-booking').addEventListener('click', async () => {
  if (!state.booking) { showView('view-home-driver'); return; }
  try {
    await api('updateBookingStatus', { booking_id: state.booking.booking_id, status: 'cancelled' });
  } catch { /* ignore */ }
  state.booking = null;
  clearDriverPoll();
  clearCountdown(true);
  showView('view-home-driver');
});

document.getElementById('btn-matching-home').addEventListener('click', () => {
  state.booking = null;
  clearDriverPoll();
  clearCountdown(true);
  showView('view-home-driver');
});

/** Step 3: Driver proceeds to payment */
document.getElementById('btn-proceed-payment').addEventListener('click', async e => {
  if (!state.booking || state.booking.status !== 'arrived') return;
  const button = e.currentTarget;
  const confirmButton = document.getElementById('btn-confirm-payment');
  const bookingId = state.booking.booking_id;
  setButtonLoading(button, 'กำลังเปิดหน้าชำระเงิน');
  hideError('payment-error');
  renderPaymentAmount(BOOKING_AMOUNT);
  showView('view-payment');

  try {
    clearDriverPoll();
    clearCountdown();

    if (state.paymentBookingId === bookingId && state.paymentEl) return;

    resetPaymentState();
    setButtonLoading(confirmButton, 'กำลังโหลดช่องทางชำระเงิน');
    const res = await api('createPaymentIntent', {
      booking_id: bookingId,
      amount: BOOKING_AMOUNT,
    });
    if (res.status === 'succeeded') {
      state.booking.status = 'completed';
      showView('view-rating');
      return;
    }

    state.clientSecret = res.client_secret;
    state.paymentBookingId = bookingId;
    renderPaymentAmount(res.amount);
    await initStripe(state.clientSecret);
    resetButton(confirmButton, '<i data-lucide="lock-keyhole"></i><span>ชำระเงินอย่างปลอดภัย</span>');
  } catch (err) {
    showError('payment-error', 'ไม่สามารถเปิดระบบชำระเงินได้: ' + err.message);
    resetButton(confirmButton, '<i data-lucide="lock-keyhole"></i><span>ชำระเงินอย่างปลอดภัย</span>');
    confirmButton.disabled = true;
  } finally {
    resetButton(button, '<i data-lucide="wallet-cards"></i><span>เจ้าของมาถึงแล้ว ชำระเงิน</span>');
  }
});

/** Step 4: Confirm payment */
document.getElementById('btn-confirm-payment').addEventListener('click', async () => {
  if (!state.stripe || !state.stripeElements || !state.booking) return;
  hideError('payment-error');
  const btn = document.getElementById('btn-confirm-payment');
  setButtonLoading(btn, 'กำลังประมวลผล');

  try {
    const { error, paymentIntent } = await state.stripe.confirmPayment({
      elements: state.stripeElements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });

    if (error) {
      showError('payment-error', error.message);
      return;
    }
    if (!paymentIntent) throw new Error('Stripe ไม่ส่งสถานะการชำระเงินกลับมา');

    const verification = await api('confirmPayment', {
      payment_intent_id: paymentIntent.id,
      status: paymentIntent.status,
    });
    const verifiedStatus = verification.status || paymentIntent.status;
    if (verifiedStatus !== 'succeeded') {
      showError('payment-error', paymentStatusMessage(verifiedStatus));
      return;
    }

    // Older Apps Script deployments did not complete the booking in confirmPayment.
    if (!verification.status) {
      await api('updateBookingStatus', { booking_id: state.booking.booking_id, status: 'completed' });
    }

    state.booking.status = 'completed';
    showView('view-rating');
    resetPaymentState();
  } catch (err) {
    showError('payment-error', 'ไม่สามารถยืนยันการชำระเงินได้: ' + err.message);
  } finally {
    resetButton(btn, '<i data-lucide="lock-keyhole"></i><span>ชำระเงินอย่างปลอดภัย</span>');
  }
});

/** Payment back button */
document.getElementById('payment-back').addEventListener('click', () => {
  showView('view-matching');
  if (state.booking) {
    showOwnerArrived();
    startDriverPoll();
  }
});

/* =====================================================
   10. EVENT HANDLERS — DRIVER HISTORY
===================================================== */

document.getElementById('btn-driver-history').addEventListener('click', async () => {
  if (!state.user) return;
  try {
    const res = await api(`listBookings&driver_id=${state.user.user_id}`);
    renderHistoryItems(res.data, 'modal-history-list');
    document.getElementById('modal-history').classList.remove('hidden');
  } catch (err) {
    alert('ไม่สามารถโหลดประวัติได้: ' + err.message);
  }
});

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('modal-history').classList.add('hidden');
});
document.getElementById('modal-overlay').addEventListener('click', () => {
  document.getElementById('modal-history').classList.add('hidden');
});

/* =====================================================
   11. EVENT HANDLERS — RATING
===================================================== */

let selectedRating = 0;

document.querySelectorAll('.star').forEach(star => {
  star.addEventListener('click', () => {
    selectedRating = parseInt(star.dataset.value, 10);
    document.querySelectorAll('.star').forEach((s, i) => {
      s.classList.toggle('active', i < selectedRating);
    });
  });
});

document.getElementById('btn-submit-rating').addEventListener('click', async () => {
  if (state.booking && selectedRating > 0) {
    try {
      await api('rateBooking', { booking_id: state.booking.booking_id, rating: selectedRating });
    } catch { /* ignore */ }
  }
  state.booking = null;
  resetPaymentState();
  clearDriverPoll();
  clearCountdown(true);
  selectedRating = 0;
  document.querySelectorAll('.star').forEach(s => s.classList.remove('active'));
  showView('view-home-driver');
  initDriverMap();
});

/* =====================================================
   12. EVENT HANDLERS — OWNER DASHBOARD
===================================================== */

/** Owner accepts a booking */
document.getElementById('btn-accept-booking').addEventListener('click', async e => {
  if (!state.ownerBooking) return;
  const button = e.currentTarget;
  setButtonLoading(button, 'กำลังรับงาน');
  try {
    await api('updateBookingStatus', { booking_id: state.ownerBooking.booking_id, status: 'waiting' });
    state.ownerBooking.status = 'waiting';
    document.getElementById('owner-incoming-card').classList.add('hidden');
    showActiveBookingCard(state.ownerBooking);
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    resetButton(button, '<i data-lucide="check"></i><span>รับงาน</span>');
  }
});

/** Owner rejects a booking */
document.getElementById('btn-reject-booking').addEventListener('click', async e => {
  if (!state.ownerBooking) return;
  const button = e.currentTarget;
  setButtonLoading(button, 'กำลังปฏิเสธ');
  try {
    await api('updateBookingStatus', { booking_id: state.ownerBooking.booking_id, status: 'cancelled' });
    state.ownerBooking = null;
    document.getElementById('owner-incoming-card').classList.add('hidden');
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    resetButton(button, '<i data-lucide="x"></i><span>ปฏิเสธ</span>');
  }
});

/** Owner marks themselves as arrived */
document.getElementById('btn-owner-arrived').addEventListener('click', async e => {
  if (!state.ownerBooking) return;
  const button = e.currentTarget;
  setButtonLoading(button, 'กำลังยืนยัน');
  try {
    await api('updateBookingStatus', { booking_id: state.ownerBooking.booking_id, status: 'arrived' });
    document.getElementById('owner-active-card').classList.add('hidden');
    state.ownerBooking = null;
    alert('ยืนยันการมาถึงแล้ว ระบบเปิดให้ผู้ขับขี่ชำระเงินได้');
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    resetButton(button, '<i data-lucide="map-pin-check"></i><span>ฉันมาถึงแล้ว</span>');
  }
});

/** Persist availability so matching only selects owners who are online. */
document.getElementById('owner-available-toggle').addEventListener('change', async e => {
  const toggle = e.target;
  const available = toggle.checked;
  toggle.disabled = true;
  try {
    await updateOwnerAvailability(available);
    renderOwnerAvailability(available);
    if (available) startOwnerPoll();
    else clearOwnerPoll();
  } catch (err) {
    toggle.checked = !available;
    renderOwnerAvailability(!available, 'อัปเดตสถานะไม่สำเร็จ กรุณาลองอีกครั้ง');
    alert('ไม่สามารถอัปเดตสถานะรับงานได้: ' + err.message);
  } finally {
    toggle.disabled = false;
  }
});

/* =====================================================
   13. BOOT
===================================================== */

async function boot() {
  refreshIcons();
  // Restore session
  const saved = loadSession();
  if (saved) {
    state.user = saved;
    afterLogin();
  } else {
    // Small delay to show splash
    await new Promise(r => setTimeout(r, 1200));
    showView('view-login');
  }
}

// DOM ready
document.addEventListener('DOMContentLoaded', boot);
