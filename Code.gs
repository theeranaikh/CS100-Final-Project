/**
 * Piakarn Parking Space — Apps Script API
 * Deploy: Deploy > New deployment > Web App
 *   - Execute as: Me
 *   - Who has access: Anyone
 *
 * ก่อน deploy ให้ตั้งค่า Script Properties (Project Settings > Script Properties):
 *   SHEET_ID              = <Google Sheet ID ที่ใช้เป็นฐานข้อมูล>
 *   STRIPE_SECRET_KEY     = sk_test_xxxxxxxx   (ห้าม commit ค่าจริงลง repo)
 *
 * Sheets ที่ต้องมีในไฟล์ (สร้างหัวตารางตามนี้ในแถวแรก):
 *   Users:        user_id | name | phone | plate | role | permit_type | password_hash | created_at | available | lat | lng | last_seen_at
 *   Bookings:     booking_id | driver_id | owner_id | status | lat | lng | requested_at | matched_at | eta_minutes | owner_response_at | arrived_at | completed_at | rating
 *   Transactions: trans_id | booking_id | amount | currency | stripe_payment_intent_id | status | created_at
 */

const PROPS = PropertiesService.getScriptProperties();
const USER_HEADERS = ['user_id','name','phone','plate','role','permit_type','password_hash','created_at','available','lat','lng','last_seen_at'];
const BOOKING_HEADERS = ['booking_id','driver_id','owner_id','status','lat','lng','requested_at','matched_at','eta_minutes','owner_response_at','arrived_at','completed_at','rating'];
const TRANSACTION_HEADERS = ['trans_id','booking_id','amount','currency','stripe_payment_intent_id','status','created_at'];
const OWNER_ONLINE_TTL_MS = 150000;

function getSheet_(name) {
  const sheetId = PROPS.getProperty('SHEET_ID');
  if (!sheetId) throw new Error('ยังไม่ได้ตั้งค่า SHEET_ID ใน Script Properties');
  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(name);
  if (!sheet) throw new Error('ไม่พบชีต ' + name);
  return sheet;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length === 0 || values[0].length === 0 || values[0][0] === '') return [];
  const headers = values.shift();
  return values.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function ensureHeaders_(sheet, requiredHeaders) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return requiredHeaders.slice();
  }

  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  requiredHeaders.forEach(header => {
    if (headers.indexOf(header) === -1) {
      headers.push(header);
      sheet.getRange(1, headers.length).setValue(header);
    }
  });
  return headers;
}

function appendRow_(sheet, obj, headers) {
  sheet.appendRow(headers.map(h => obj[h] !== undefined ? obj[h] : ''));
}

function updateRowById_(sheet, idField, idValue, updates) {
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf(idField);
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idCol]) === String(idValue)) {
      Object.keys(updates).forEach(key => {
        const col = headers.indexOf(key);
        if (col !== -1) sheet.getRange(r + 1, col + 1).setValue(updates[key]);
      });
      return true;
    }
  }
  return false;
}

function uid_(prefix) {
  return prefix + '_' + Utilities.getUuid().slice(0, 8);
}

function normalise_(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function isTrue_(value) {
  return value === true || ['true', '1', 'yes'].indexOf(normalise_(value)) !== -1;
}

function isRecentlySeen_(value) {
  const timestamp = new Date(value).getTime();
  return isFinite(timestamp) && Date.now() - timestamp <= OWNER_ONLINE_TTL_MS;
}

function haversineKm_(lat1, lng1, lat2, lng2) {
  const values = [lat1, lng1, lat2, lng2].map(Number);
  if (values.some(value => !isFinite(value))) return Infinity;
  const toRad = degrees => degrees * Math.PI / 180;
  const dLat = toRad(values[2] - values[0]);
  const dLng = toRad(values[3] - values[1]);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(values[0])) * Math.cos(toRad(values[2])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- ENTRY POINTS ----------

function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'listBookings') return jsonOut_({ ok: true, data: listBookings_(e.parameter) });
    return jsonOut_({ ok: false, error: 'Unknown GET action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: err.message });
  }
}

function doPost(e) {
  const action = e.parameter.action;
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    switch (action) {
      case 'register': return jsonOut_(register_(body));
      case 'login': return jsonOut_(login_(body));
      case 'requestBooking': return jsonOut_(requestBooking_(body));
      case 'findNearestOwner': return jsonOut_(findNearestOwner_(body));
      case 'updateOwnerAvailability': return jsonOut_(updateOwnerAvailability_(body));
      case 'updateBookingStatus': return jsonOut_(updateBookingStatus_(body));
      case 'createPaymentIntent': return jsonOut_(createPaymentIntent_(body));
      case 'confirmPayment': return jsonOut_(confirmPayment_(body));
      case 'rateBooking': return jsonOut_(rateBooking_(body));
      default: return jsonOut_({ ok: false, error: 'Unknown POST action' });
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: err.message });
  }
}

// ---------- USERS ----------

function register_(body) {
  const sheet = getSheet_('Users');
  const headers = ensureHeaders_(sheet, USER_HEADERS);
  const role = normalise_(body.role);
  const phone = String(body.phone || '').trim();
  if (!body.name || !phone || !body.password) return { ok: false, error: 'กรุณากรอกข้อมูลให้ครบ' };
  if (['driver', 'owner'].indexOf(role) === -1) return { ok: false, error: 'ประเภทผู้ใช้ไม่ถูกต้อง' };

  const duplicate = sheetToObjects_(sheet).some(user => {
    return String(user.phone).replace(/^0+/, '') === phone.replace(/^0+/, '');
  });
  if (duplicate) return { ok: false, error: 'เบอร์โทรนี้มีบัญชีอยู่แล้ว' };

  const user = {
    user_id: uid_('u'),
    name: body.name,
    phone: phone,
    plate: body.plate || '',
    role: role,
    permit_type: body.permit_type || '',
    password_hash: Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body.password)
    ),
    created_at: new Date().toISOString(),
    available: false,
    lat: '',
    lng: '',
    last_seen_at: ''
  };
  appendRow_(sheet, user, headers);

  // Google Sheets auto-converts "0812345678" → 812345678 (ตัด 0 ออก)
  // แก้ด้วยการ format เซลล์ phone เป็น text แล้ว setValue ใหม่
  const lastRow  = sheet.getLastRow();
  const phoneCol = headers.indexOf('phone') + 1; // 1-based
  sheet.getRange(lastRow, phoneCol)
    .setNumberFormat('@')   // force text format
    .setValue(phone);

  delete user.password_hash;
  return { ok: true, user: user };
}

function updateOwnerAvailability_(body) {
  const sheet = getSheet_('Users');
  ensureHeaders_(sheet, USER_HEADERS);
  const users = sheetToObjects_(sheet);
  const owner = users.find(user => String(user.user_id) === String(body.owner_id));
  if (!owner || normalise_(owner.role) !== 'owner') {
    return { ok: false, error: 'ไม่พบบัญชีเจ้าของสิทธิ์' };
  }

  const updates = {
    available: isTrue_(body.available),
    last_seen_at: new Date().toISOString()
  };
  if (isFinite(Number(body.lat)) && isFinite(Number(body.lng))) {
    updates.lat = Number(body.lat);
    updates.lng = Number(body.lng);
  }

  const ok = updateRowById_(sheet, 'user_id', body.owner_id, updates);
  return { ok: ok, available: updates.available };
}

function login_(body) {
  const users = sheetToObjects_(getSheet_('Users'));
  const hash  = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body.password)
  );
  // normalise: ตัด leading zeros ออกก่อนเปรียบเทียบ เพื่อรองรับ Sheets ที่อาจเคยตัด 0 ไปแล้ว
  const inputPhone = String(body.phone).replace(/^0+/, '');
  const found = users.find(u => {
    const storedPhone = String(u.phone).replace(/^0+/, '');
    return storedPhone === inputPhone && u.password_hash === hash;
  });
  if (!found) return { ok: false, error: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' };
  delete found.password_hash;
  return { ok: true, user: found };
}

// ---------- BOOKINGS ----------

function requestBooking_(body) {
  const sheet = getSheet_('Bookings');
  const headers = ensureHeaders_(sheet, BOOKING_HEADERS);
  if (!body.driver_id || !isFinite(Number(body.lat)) || !isFinite(Number(body.lng))) {
    return { ok: false, error: 'ข้อมูลคำขอหรือพิกัดไม่ถูกต้อง' };
  }
  const booking = {
    booking_id: uid_('b'),
    driver_id: body.driver_id,
    owner_id: '',
    status: 'pending',
    lat: body.lat,
    lng: body.lng,
    requested_at: new Date().toISOString(),
    matched_at: '',
    eta_minutes: '',
    owner_response_at: '',
    arrived_at: '',
    completed_at: '',
    rating: ''
  };
  appendRow_(sheet, booking, headers);
  return { ok: true, booking: booking };
}

// หา owner ที่เปิดรับงานและไม่มี booking ค้าง โดยล็อกทั้งขั้นตอนเพื่อไม่ให้ owner คนเดียวถูกจับคู่ซ้ำ
function findNearestOwner_(body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'ระบบกำลังจับคู่คำขออื่น กรุณาลองอีกครั้ง' };

  try {
    const usersSheet = getSheet_('Users');
    const bookingsSheet = getSheet_('Bookings');
    ensureHeaders_(usersSheet, USER_HEADERS);
    ensureHeaders_(bookingsSheet, BOOKING_HEADERS);

    const users = sheetToObjects_(usersSheet);
    const bookings = sheetToObjects_(bookingsSheet);
    const booking = bookings.find(item => String(item.booking_id) === String(body.booking_id));
    if (!booking) return { ok: false, error: 'ไม่พบคำขอจอง' };
    if (normalise_(booking.status) !== 'pending') return { ok: false, error: 'คำขอนี้ถูกดำเนินการแล้ว' };

    const busyOwnerIds = new Set(
      bookings
        .filter(item => ['matched', 'waiting', 'arrived'].indexOf(normalise_(item.status)) !== -1)
        .map(item => String(item.owner_id))
    );

    const owners = users
      .filter(user => normalise_(user.role) === 'owner' && isTrue_(user.available) && isRecentlySeen_(user.last_seen_at) && !busyOwnerIds.has(String(user.user_id)))
      .map(user => ({
        user: user,
        distanceKm: haversineKm_(booking.lat, booking.lng, user.lat, user.lng)
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    if (owners.length === 0) return { ok: false, error: 'ยังไม่มีเจ้าของสิทธิ์ที่พร้อมรับงาน' };

    const selected = owners[0];
    const etaMinutes = isFinite(selected.distanceKm)
      ? Math.max(5, Math.min(45, Math.ceil(selected.distanceKm / 0.4)))
      : 45;

    const updated = updateRowById_(bookingsSheet, 'booking_id', body.booking_id, {
      owner_id: selected.user.user_id,
      status: 'matched',
      matched_at: new Date().toISOString(),
      eta_minutes: etaMinutes
    });
    if (!updated) return { ok: false, error: 'ไม่สามารถบันทึกการจับคู่ได้' };

    return {
      ok: true,
      owner_id: selected.user.user_id,
      eta_minutes: etaMinutes,
      distance_km: isFinite(selected.distanceKm) ? Number(selected.distanceKm.toFixed(2)) : null
    };
  } finally {
    lock.releaseLock();
  }
}

function updateBookingStatus_(body) {
  const sheet = getSheet_('Bookings');
  ensureHeaders_(sheet, BOOKING_HEADERS);
  const bookings = sheetToObjects_(sheet);
  const booking = bookings.find(item => String(item.booking_id) === String(body.booking_id));
  if (!booking) return { ok: false, error: 'ไม่พบคำขอจอง' };

  const current = normalise_(booking.status);
  const next = normalise_(body.status);
  const transitions = {
    pending: ['cancelled'],
    matched: ['waiting', 'cancelled'],
    waiting: ['arrived', 'cancelled'],
    arrived: ['completed', 'cancelled'],
    completed: [],
    cancelled: []
  };
  if (!transitions[current] || transitions[current].indexOf(next) === -1) {
    return { ok: false, error: 'ไม่สามารถเปลี่ยนสถานะจาก ' + current + ' เป็น ' + next };
  }

  const updates = { status: next };
  if (next === 'waiting') updates.owner_response_at = new Date().toISOString();
  if (next === 'arrived') updates.arrived_at = new Date().toISOString();
  if (next === 'completed') updates.completed_at = new Date().toISOString();
  const ok = updateRowById_(sheet, 'booking_id', body.booking_id, updates);
  return { ok: ok };
}

function rateBooking_(body) {
  const ok = updateRowById_(getSheet_('Bookings'), 'booking_id', body.booking_id, { rating: body.rating });
  return { ok: ok };
}

function listBookings_(params) {
  const bookings = sheetToObjects_(getSheet_('Bookings'));
  if (params.booking_id) return bookings.filter(b => String(b.booking_id) === String(params.booking_id));
  if (params.driver_id) return bookings.filter(b => String(b.driver_id) === String(params.driver_id));
  if (params.owner_id) return bookings.filter(b => String(b.owner_id) === String(params.owner_id));
  return bookings;
}

// ---------- PAYMENTS (Stripe) ----------

function createPaymentIntent_(body) {
  const secretKey = PROPS.getProperty('STRIPE_SECRET_KEY');
  const amountSatang = Math.round(Number(body.amount) * 100); // THB -> satang

  const response = UrlFetchApp.fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + secretKey },
    payload: {
      amount: amountSatang,
      currency: 'thb',
      'automatic_payment_methods[enabled]': 'true'
    },
    muteHttpExceptions: true
  });

  const intent = JSON.parse(response.getContentText());
  if (intent.error) return { ok: false, error: intent.error.message };

  const sheet = getSheet_('Transactions');
  const headers = ensureHeaders_(sheet, TRANSACTION_HEADERS);
  const trans = {
    trans_id: uid_('t'),
    booking_id: body.booking_id,
    amount: body.amount,
    currency: 'thb',
    stripe_payment_intent_id: intent.id,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  appendRow_(sheet, trans, headers);

  return { ok: true, client_secret: intent.client_secret, trans_id: trans.trans_id };
}

function confirmPayment_(body) {
  const ok = updateRowById_(getSheet_('Transactions'), 'stripe_payment_intent_id', body.payment_intent_id, {
    status: body.status // 'succeeded' | 'failed'
  });
  return { ok: ok };
}
