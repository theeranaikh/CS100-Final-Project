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
const POLL_INTERVAL_MS = 5000;    // poll owner dashboard every 5 s

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

  stripe:        null,    // Stripe instance
  stripeElements:null,
  paymentEl:     null,    // Stripe Payment Element
  clientSecret:  null,

  ownerPoll:     null,    // setInterval handle
  selectedRating: 0,
};

/* =====================================================
   2. UTILITIES
===================================================== */

/** Show exactly one view by ID */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

/** GET or POST to Apps Script Web App */
async function api(action, body = null) {
  if (!API_URL) throw new Error('กรุณาตั้งค่า APPS_SCRIPT_API_URL ใน config.js ก่อนใช้งาน');
  const url = `${API_URL}?action=${action}`;
  // ใช้ text/plain เพื่อหลีกเลี่ยง CORS preflight ที่ Apps Script ไม่รองรับ
  // Apps Script อ่าน JSON body ได้ผ่าน e.postData.contents อยู่แล้ว
  const opts = body
    ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' } }
    : { method: 'GET' };
  const res  = await fetch(url, opts);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'API error');
  return json;
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
  state.user    = null;
  state.booking = null;
  clearCountdown();
  clearOwnerPoll();
  saveSession();
  showView('view-login');
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(elId) {
  document.getElementById(elId).classList.add('hidden');
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
      styles: darkMapStyle(),
    });

    if (state.driverPos) {
      state.driverMarker = new google.maps.Marker({
        position: center,
        map: state.mapDriver,
        title: 'ตำแหน่งของคุณ',
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10,
          fillColor: '#3D8BFF', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
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
      styles: darkMapStyle(),
    });
    new google.maps.Marker({ position: center, map: state.mapOwner,
      title: 'ตำแหน่งผู้ขับขี่',
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10,
        fillColor: '#FF5C5C', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
    });
  });
}

/** Minimal dark map style matching the app palette */
function darkMapStyle() {
  return [
    { elementType: 'geometry', stylers: [{ color: '#1a2c4a' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#0B1E3D' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#7a9ec4' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#243c5c' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#182d45' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1a2d' }] },
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
  const circle = document.getElementById('progress-circle');
  const minEl  = document.getElementById('countdown-min');

  // Initialise stroke
  circle.style.strokeDasharray  = CIRCUMFERENCE;
  circle.style.strokeDashoffset = 0;

  function tick() {
    const mins = Math.floor(state.countdownSec / 60);
    if (minEl) minEl.textContent = mins;

    // SVG progress bar (drains from full → empty)
    const progress = state.countdownSec / totalSec;
    circle.style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);

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

function clearCountdown() {
  if (state.countdown) { clearInterval(state.countdown); state.countdown = null; }
}

function onCountdownEnd() {
  // เมื่อ 45 นาทีหมด ถือว่าเจ้าของสิทธิ์ถึงแล้ว — เปิดปุ่มชำระเงิน
  const btn  = document.getElementById('btn-proceed-payment');
  const note = document.getElementById('payment-note');
  if (btn)  btn.disabled = false;
  if (note) note.textContent = 'เวลาหมดแล้ว — กรุณาชำระเงิน';
}

/* =====================================================
   5. STRIPE
===================================================== */

async function initStripe(clientSecret) {
  if (!STRIPE_PUB_KEY) {
    showError('payment-error', 'STRIPE_PUBLISHABLE_KEY ยังไม่ได้ตั้งค่าใน config.js');
    return;
  }
  state.stripe = Stripe(STRIPE_PUB_KEY);
  state.stripeElements = state.stripe.elements({ clientSecret, appearance: stripeAppearance() });
  state.paymentEl      = state.stripeElements.create('payment');
  state.paymentEl.mount('#stripe-payment-element');
}

function stripeAppearance() {
  return {
    theme: 'night',
    variables: {
      colorPrimary:       '#3D8BFF',
      colorBackground:    '#F4F7FF',
      colorText:          '#0B1E3D',
      colorDanger:        '#ff5c5c',
      fontFamily:         'Poppins, sans-serif',
      borderRadius:       '8px',
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
    el.innerHTML = '<p class="history-empty">ยังไม่มีประวัติ</p>';
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
}

function statusLabel(s) {
  const MAP = { pending: 'รอคู่', matched: 'จับคู่แล้ว', waiting: 'กำลังรอ', completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก' };
  return MAP[s] || s;
}

/* =====================================================
   7. OWNER POLLING
===================================================== */

function startOwnerPoll() {
  if (state.ownerPoll) return;
  pollOwnerBookings(); // immediate first call
  state.ownerPoll = setInterval(pollOwnerBookings, POLL_INTERVAL_MS);
}

function clearOwnerPoll() {
  if (state.ownerPoll) { clearInterval(state.ownerPoll); state.ownerPoll = null; }
}

async function pollOwnerBookings() {
  if (!state.user || state.user.role !== 'owner') return;
  try {
    const res = await api(`listBookings&owner_id=${state.user.user_id}`);
    const bookings = res.data || [];

    // Update history
    renderHistoryItems(bookings, 'owner-history-list');

    // Check for a pending booking assigned to this owner
    const pending = bookings.find(b => b.status === 'matched' && !state.ownerBooking);
    if (pending && !state.ownerBooking) {
      state.ownerBooking = pending;
      showIncomingRequest(pending);
    }

    // If we have an active booking (waiting), show the active card
    const active = bookings.find(b => b.status === 'waiting');
    if (active) {
      showActiveBookingCard(active);
    }
  } catch (err) {
    console.error('Owner poll error:', err.message);
  }
}

function showIncomingRequest(booking) {
  const card = document.getElementById('owner-incoming-card');
  const locEl = document.getElementById('incoming-location');
  if (!card) return;
  card.classList.remove('hidden');
  if (locEl) locEl.textContent = `📍 ละติจูด ${Number(booking.lat).toFixed(4)}, ลองจิจูด ${Number(booking.lng).toFixed(4)}`;
}

function showActiveBookingCard(booking) {
  const card = document.getElementById('owner-active-card');
  if (card) card.classList.remove('hidden');
  if (booking.lat && booking.lng) initOwnerMap(Number(booking.lat), Number(booking.lng));
}

/* =====================================================
   8. EVENT HANDLERS — AUTH
===================================================== */

// Login form
document.getElementById('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('login-error');
  const phone    = document.getElementById('login-phone').value.trim();
  const password = document.getElementById('login-password').value;
  if (!phone || !password) { showError('login-error', 'กรุณากรอกข้อมูลให้ครบ'); return; }
  try {
    const res  = await api('login', { phone, password });
    state.user = res.user;
    saveSession();
    afterLogin();
  } catch (err) {
    showError('login-error', err.message);
  }
});

// Register form
document.getElementById('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('reg-error');
  const name     = document.getElementById('reg-name').value.trim();
  const phone    = document.getElementById('reg-phone').value.trim();
  const password = document.getElementById('reg-password').value;
  const role     = document.querySelector('input[name="role"]:checked')?.value || 'driver';
  const plate    = document.getElementById('reg-plate').value.trim();
  const permit   = document.getElementById('reg-permit').value.trim();
  if (!name || !phone || !password) { showError('reg-error', 'กรุณากรอกข้อมูลให้ครบ'); return; }
  if (password.length < 8)          { showError('reg-error', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'); return; }
  try {
    const res  = await api('register', { name, phone, password, role, plate, permit_type: permit });
    state.user = res.user;
    saveSession();
    afterLogin();
  } catch (err) {
    showError('reg-error', err.message);
  }
});

// Navigate between login/register
document.getElementById('go-register').addEventListener('click', e => { e.preventDefault(); showView('view-register'); });
document.getElementById('go-login').addEventListener('click',    e => { e.preventDefault(); showView('view-login'); });
document.getElementById('reg-back').addEventListener('click', () => showView('view-login'));

// Role toggle — show/hide owner-specific fields
document.querySelectorAll('input[name="role"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const ownerFields = document.getElementById('owner-fields');
    ownerFields.classList.toggle('hidden', radio.value !== 'owner' || !radio.checked);
  });
});

function afterLogin() {
  if (state.user.role === 'owner') {
    document.getElementById('owner-name').textContent = state.user.name;
    showView('view-owner-dashboard');
    startOwnerPoll();
  } else {
    document.getElementById('driver-name').textContent = state.user.name;
    showView('view-home-driver');
    initDriverMap();
    // Get GPS position
    getCurrentPosition().then(pos => {
      state.driverPos = pos;
      if (state.mapDriver) {
        state.mapDriver.setCenter(pos);
        if (state.driverMarker) state.driverMarker.setPosition(pos);
        else state.driverMarker = new google.maps.Marker({
          position: pos, map: state.mapDriver,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10,
            fillColor: '#3D8BFF', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        });
      }
    }).catch(err => console.warn('GPS:', err.message));
  }
}

// Logout buttons
document.getElementById('driver-logout').addEventListener('click', logout);
document.getElementById('owner-logout').addEventListener('click',  logout);

/* =====================================================
   9. EVENT HANDLERS — DRIVER BOOKING FLOW
===================================================== */

/** Step 1: Driver requests parking */
document.getElementById('btn-request-parking').addEventListener('click', async () => {
  if (!state.user) return;
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
    document.getElementById('matching-searching').classList.remove('hidden');
    document.getElementById('matching-found').classList.add('hidden');

    // 4. Call findNearestOwner
    try {
      const match = await api('findNearestOwner', { booking_id: state.booking.booking_id });
      state.booking.owner_id   = match.owner_id;
      state.booking.eta_minutes = match.eta_minutes;
      state.booking.status     = 'matched';

      // Show countdown
      document.getElementById('matching-searching').classList.add('hidden');
      document.getElementById('matching-found').classList.remove('hidden');
      document.getElementById('eta-label').textContent = `${match.eta_minutes} นาที`;

      startCountdown(match.eta_minutes * 60);
    } catch (err) {
      // No owner available
      document.getElementById('matching-searching').classList.add('hidden');
      document.getElementById('matching-found').innerHTML =
        `<p style="color:var(--error);text-align:center;padding:40px 0">${err.message}</p>
         <button class="btn-primary btn-full" onclick="showView('view-home-driver')">กลับหน้าหลัก</button>`;
      document.getElementById('matching-found').classList.remove('hidden');
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
});

/** Step 2: Driver cancels booking */
document.getElementById('btn-cancel-booking').addEventListener('click', async () => {
  if (!state.booking) { showView('view-home-driver'); return; }
  try {
    await api('updateBookingStatus', { booking_id: state.booking.booking_id, status: 'cancelled' });
  } catch { /* ignore */ }
  state.booking = null;
  clearCountdown();
  showView('view-home-driver');
});

/** Step 3: Driver proceeds to payment */
document.getElementById('btn-proceed-payment').addEventListener('click', async () => {
  if (!state.booking) return;
  try {
    clearCountdown();
    await api('updateBookingStatus', { booking_id: state.booking.booking_id, status: 'waiting' });
    state.booking.status = 'waiting';

    // Create Stripe PaymentIntent via Apps Script
    const res = await api('createPaymentIntent', {
      booking_id: state.booking.booking_id,
      amount:     BOOKING_AMOUNT,
    });
    state.clientSecret = res.client_secret;

    document.getElementById('payment-amount-display').textContent = `฿${BOOKING_AMOUNT.toFixed(2)}`;
    document.getElementById('payment-total-display').textContent  = `฿${BOOKING_AMOUNT.toFixed(2)}`;

    showView('view-payment');
    await initStripe(state.clientSecret);
  } catch (err) {
    alert('ไม่สามารถสร้าง Payment Intent ได้: ' + err.message);
  }
});

/** Step 4: Confirm payment */
document.getElementById('btn-confirm-payment').addEventListener('click', async () => {
  if (!state.stripe || !state.stripeElements) return;
  hideError('payment-error');
  const btn = document.getElementById('btn-confirm-payment');
  btn.disabled = true;
  btn.textContent = 'กำลังประมวลผล…';

  const { error, paymentIntent } = await state.stripe.confirmPayment({
    elements: state.stripeElements,
    confirmParams: { return_url: window.location.href },
    redirect: 'if_required',
  });

  if (error) {
    showError('payment-error', error.message);
    btn.disabled = false;
    btn.innerHTML = '🔒 &nbsp;ชำระเงิน';
    return;
  }

  if (paymentIntent && paymentIntent.status === 'succeeded') {
    // Notify backend
    try {
      await api('confirmPayment', { payment_intent_id: paymentIntent.id, status: 'succeeded' });
      await api('updateBookingStatus', { booking_id: state.booking.booking_id, status: 'completed' });
    } catch { /* non-critical */ }
    showView('view-rating');
  }
});

/** Payment back button */
document.getElementById('payment-back').addEventListener('click', () => {
  showView('view-matching');
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
  selectedRating = 0;
  document.querySelectorAll('.star').forEach(s => s.classList.remove('active'));
  showView('view-home-driver');
  initDriverMap();
});

/* =====================================================
   12. EVENT HANDLERS — OWNER DASHBOARD
===================================================== */

/** Owner accepts a booking */
document.getElementById('btn-accept-booking').addEventListener('click', async () => {
  if (!state.ownerBooking) return;
  try {
    await api('updateBookingStatus', { booking_id: state.ownerBooking.booking_id, status: 'waiting' });
    state.ownerBooking.status = 'waiting';
    document.getElementById('owner-incoming-card').classList.add('hidden');
    showActiveBookingCard(state.ownerBooking);
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
});

/** Owner rejects a booking */
document.getElementById('btn-reject-booking').addEventListener('click', async () => {
  if (!state.ownerBooking) return;
  try {
    await api('updateBookingStatus', { booking_id: state.ownerBooking.booking_id, status: 'cancelled' });
  } catch { /* ignore */ }
  state.ownerBooking = null;
  document.getElementById('owner-incoming-card').classList.add('hidden');
});

/** Owner marks themselves as arrived */
document.getElementById('btn-owner-arrived').addEventListener('click', async () => {
  if (!state.ownerBooking) return;
  try {
    await api('updateBookingStatus', { booking_id: state.ownerBooking.booking_id, status: 'completed' });
    document.getElementById('owner-active-card').classList.add('hidden');
    state.ownerBooking = null;
    alert('✅ ขอบคุณ! การให้บริการเสร็จสมบูรณ์');
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
});

/** Owner availability toggle (UI only — could extend to a status field in Sheets) */
document.getElementById('owner-available-toggle').addEventListener('change', e => {
  if (!e.target.checked) {
    clearOwnerPoll();
  } else {
    startOwnerPoll();
  }
});

/* =====================================================
   13. BOOT
===================================================== */

async function boot() {
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
