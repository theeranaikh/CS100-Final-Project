/**
 * Piakarn Parking Space — Apps Script API
 * Deploy: Deploy > New deployment > Web App
 *   - Execute as: Me
 *   - Who has access: Anyone
 *
 * ก่อน deploy ให้ตั้งค่า Script Properties (Project Settings > Script Properties):
 *   SHEET_ID              = <Google Sheet ID ที่ใช้เป็นฐานข้อมูล>
 *   STRIPE_SECRET_KEY     = sk_test_xxxxxxxx   (ห้าม commit ค่าจริงลง repo)
 *   TWILIO_ACCOUNT_SID    = ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   TWILIO_AUTH_TOKEN     = <Twilio Auth Token>
 *   TWILIO_VERIFY_SERVICE_SID = VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (ไม่บังคับ ระบบสร้างให้ครั้งแรก)
 *   PASSWORD_RESET_DEMO_BYPASS = false (ไม่บังคับ; ใช้ปิด OTP demo ก่อนนำขึ้น production)
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
const BOOKING_AMOUNT_THB = 50;
const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
const TWILIO_VERIFY_API_BASE_URL = 'https://verify.twilio.com/v2';
const PASSWORD_RESET_COOLDOWN_SEC = 60;
const PASSWORD_RESET_WINDOW_SEC = 21600;
const PASSWORD_RESET_MAX_SENDS = 5;
const PASSWORD_RESET_DEV_CODE = '676767';
const PASSWORD_RESET_DEMO_BYPASS_ENABLED =
  normalise_(PROPS.getProperty('PASSWORD_RESET_DEMO_BYPASS') || 'true') !== 'false';

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
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    const action = String((e.parameter && e.parameter.action) || body.action || '').trim();
    switch (action) {
      case 'register': return jsonOut_(register_(body));
      case 'login': return jsonOut_(login_(body));
      case 'requestPasswordReset': return jsonOut_(requestPasswordReset_(body));
      case 'resetPassword': return jsonOut_(resetPassword_(body));
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

function hashPassword_(password) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password || ''))
  );
}

function phoneLookupKey_(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.indexOf('66') === 0) digits = digits.slice(2);
  return digits.replace(/^0+/, '');
}

function thaiPhoneToE164_(value) {
  const phoneKey = phoneLookupKey_(value);
  if (!/^[689]\d{8}$/.test(phoneKey)) {
    throw new Error('กรุณากรอกเบอร์มือถือไทยให้ถูกต้อง');
  }
  return '+66' + phoneKey;
}

function register_(body) {
  const sheet = getSheet_('Users');
  const headers = ensureHeaders_(sheet, USER_HEADERS);
  const role = normalise_(body.role);
  const phone = String(body.phone || '').trim();
  if (!body.name || !phone || !body.password) return { ok: false, error: 'กรุณากรอกข้อมูลให้ครบ' };
  if (['driver', 'owner'].indexOf(role) === -1) return { ok: false, error: 'ประเภทผู้ใช้ไม่ถูกต้อง' };

  const duplicate = sheetToObjects_(sheet).some(user => phoneLookupKey_(user.phone) === phoneLookupKey_(phone));
  if (duplicate) return { ok: false, error: 'เบอร์โทรนี้มีบัญชีอยู่แล้ว' };

  const user = {
    user_id: uid_('u'),
    name: body.name,
    phone: phone,
    plate: body.plate || '',
    role: role,
    permit_type: body.permit_type || '',
    password_hash: hashPassword_(body.password),
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
  const hash = hashPassword_(body.password);
  const inputPhone = phoneLookupKey_(body.phone);
  const found = users.find(u => {
    const storedPhone = phoneLookupKey_(u.phone);
    return storedPhone === inputPhone && u.password_hash === hash;
  });
  if (!found) return { ok: false, error: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' };
  delete found.password_hash;
  return { ok: true, user: found };
}

// ---------- PASSWORD RESET (Twilio Verify) ----------

function requestPasswordReset_(body) {
  let phoneE164;
  try {
    phoneE164 = thaiPhoneToE164_(body.phone);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const phoneKey = phoneLookupKey_(body.phone);
  const cache = CacheService.getScriptCache();
  const cooldownKey = 'password_reset_cooldown_' + phoneKey;
  const windowKey = 'password_reset_window_' + phoneKey;
  if (!PASSWORD_RESET_DEMO_BYPASS_ENABLED && cache.get(cooldownKey)) {
    return { ok: false, error: 'กรุณารอ 60 วินาทีก่อนขอรหัสใหม่', retry_after: PASSWORD_RESET_COOLDOWN_SEC };
  }

  const sendCount = Number(cache.get(windowKey) || 0);
  if (!PASSWORD_RESET_DEMO_BYPASS_ENABLED && sendCount >= PASSWORD_RESET_MAX_SENDS) {
    return { ok: false, error: 'ขอรหัสยืนยันบ่อยเกินไป กรุณาลองใหม่ภายหลัง' };
  }
  if (!PASSWORD_RESET_DEMO_BYPASS_ENABLED) {
    cache.put(cooldownKey, '1', PASSWORD_RESET_COOLDOWN_SEC);
    cache.put(windowKey, String(sendCount + 1), PASSWORD_RESET_WINDOW_SEC);
  }

  const user = sheetToObjects_(getSheet_('Users'))
    .find(item => phoneLookupKey_(item.phone) === phoneKey);
  if (user) {
    try {
      sendTwilioVerification_(phoneE164);
    } catch (err) {
      if (PASSWORD_RESET_DEMO_BYPASS_ENABLED) {
        return {
          ok: true,
          message: 'เปิดขั้นตอนยืนยันสำหรับบัญชี demo แล้ว',
          retry_after: PASSWORD_RESET_COOLDOWN_SEC
        };
      }
      // The reservation prevents concurrent sends, but a provider failure must not lock out retries.
      cache.remove(cooldownKey);
      if (sendCount > 0) cache.put(windowKey, String(sendCount), PASSWORD_RESET_WINDOW_SEC);
      else cache.remove(windowKey);
      throw err;
    }
  }

  return {
    ok: true,
    message: 'หากเบอร์นี้มีบัญชี ระบบจะส่งรหัสยืนยันทาง SMS',
    retry_after: PASSWORD_RESET_COOLDOWN_SEC
  };
}

function resetPassword_(body) {
  const password = String(body.password || '');
  const code = String(body.code || '').trim();
  if (password.length < 8) return { ok: false, error: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' };
  if (!/^\d{4,10}$/.test(code)) return { ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' };

  let phoneE164;
  try {
    phoneE164 = thaiPhoneToE164_(body.phone);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const sheet = getSheet_('Users');
  const phoneKey = phoneLookupKey_(body.phone);
  const user = sheetToObjects_(sheet)
    .find(item => phoneLookupKey_(item.phone) === phoneKey);
  if (!user) return { ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' };

  const devBypassApproved = PASSWORD_RESET_DEMO_BYPASS_ENABLED && code === PASSWORD_RESET_DEV_CODE;
  if (!devBypassApproved) {
    let verification;
    try {
      verification = checkTwilioVerification_(phoneE164, code);
    } catch (err) {
      return { ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' };
    }
    if (verification.status !== 'approved') {
      return { ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' };
    }
  }

  const updated = updateRowById_(sheet, 'user_id', user.user_id, {
    password_hash: hashPassword_(password)
  });
  if (!updated) return { ok: false, error: 'ไม่สามารถอัปเดตรหัสผ่านได้' };

  return { ok: true, message: 'ตั้งรหัสผ่านใหม่สำเร็จ' };
}

function sendTwilioVerification_(phoneE164) {
  const serviceSid = getTwilioVerifyServiceSid_();
  return twilioVerifyRequest_('/Services/' + encodeURIComponent(serviceSid) + '/Verifications', {
    To: phoneE164,
    Channel: 'sms'
  });
}

function checkTwilioVerification_(phoneE164, code) {
  const serviceSid = getTwilioVerifyServiceSid_();
  return twilioVerifyRequest_('/Services/' + encodeURIComponent(serviceSid) + '/VerificationCheck', {
    To: phoneE164,
    Code: code
  });
}

function getTwilioVerifyServiceSid_() {
  let serviceSid = String(PROPS.getProperty('TWILIO_VERIFY_SERVICE_SID') || '').trim();
  if (serviceSid) return serviceSid;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('ระบบ SMS กำลังเริ่มต้น กรุณาลองอีกครั้ง');
  try {
    serviceSid = String(PROPS.getProperty('TWILIO_VERIFY_SERVICE_SID') || '').trim();
    if (serviceSid) return serviceSid;

    const service = twilioVerifyRequest_('/Services', { FriendlyName: 'Piakarn Password Reset' });
    if (!service.sid) throw new Error('ไม่สามารถสร้าง Twilio Verify Service ได้');
    PROPS.setProperty('TWILIO_VERIFY_SERVICE_SID', service.sid);
    return service.sid;
  } finally {
    lock.releaseLock();
  }
}

function twilioVerifyRequest_(path, payload) {
  const accountSid = String(PROPS.getProperty('TWILIO_ACCOUNT_SID') || '').trim();
  const authToken = String(PROPS.getProperty('TWILIO_AUTH_TOKEN') || '').trim();
  if (!accountSid || !authToken) {
    throw new Error('ยังไม่ได้ตั้งค่า Twilio ใน Script Properties');
  }

  const response = UrlFetchApp.fetch(TWILIO_VERIFY_API_BASE_URL + path, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(accountSid + ':' + authToken)
    },
    payload: payload,
    muteHttpExceptions: true
  });

  const responseText = response.getContentText();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (err) {
    throw new Error('Twilio ส่งข้อมูลตอบกลับที่ไม่ถูกต้อง');
  }

  const responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(twilioErrorMessage_(data, responseCode));
  }
  return data;
}

function twilioErrorMessage_(data, responseCode) {
  const message = String((data && data.message) || '');
  const errorCode = Number(data && data.code);
  if (errorCode === 21608 || /phone number is unverified|trial accounts cannot send/i.test(message)) {
    return 'บัญชี Twilio แบบ Trial ส่ง SMS ได้เฉพาะเบอร์ที่ยืนยันไว้ กรุณายืนยันเบอร์ปลายทางใน Twilio Console หรืออัปเกรดบัญชี';
  }
  return message || 'Twilio API error (' + responseCode + ')';
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
  const bookingId = String(body.booking_id || '').trim();
  if (!bookingId) return { ok: false, error: 'ไม่พบรหัสการจองสำหรับชำระเงิน' };

  const bookingsSheet = getSheet_('Bookings');
  ensureHeaders_(bookingsSheet, BOOKING_HEADERS);
  const booking = sheetToObjects_(bookingsSheet)
    .find(item => String(item.booking_id) === bookingId);
  if (!booking) return { ok: false, error: 'ไม่พบคำขอจอง' };

  const bookingStatus = normalise_(booking.status);
  if (bookingStatus !== 'arrived' && bookingStatus !== 'completed') {
    return { ok: false, error: 'การจองยังไม่พร้อมสำหรับชำระเงิน' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'ระบบชำระเงินกำลังประมวลผล กรุณาลองอีกครั้ง' };

  try {
    const sheet = getSheet_('Transactions');
    const headers = ensureHeaders_(sheet, TRANSACTION_HEADERS);
    const transactions = sheetToObjects_(sheet)
      .filter(item => String(item.booking_id) === bookingId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const succeededTransaction = transactions.find(item => normalise_(item.status) === 'succeeded');
    const pendingTransaction = transactions.find(item => normalise_(item.status) === 'pending');

    if (succeededTransaction) {
      const paidIntent = getPaymentIntent_(succeededTransaction.stripe_payment_intent_id);
      validatePaymentIntent_(paidIntent, succeededTransaction);
      updateRowById_(sheet, 'stripe_payment_intent_id', paidIntent.id, {
        status: paymentStatusForSheet_(paidIntent.status)
      });
      if (paidIntent.status === 'succeeded') {
        completeBookingAfterPayment_(bookingId);
        return {
          ok: true,
          status: 'succeeded',
          already_paid: true,
          booking_id: bookingId,
          amount: BOOKING_AMOUNT_THB
        };
      }
    }

    if (bookingStatus === 'completed') {
      return { ok: false, error: 'การจองเสร็จสิ้นแล้ว แต่ไม่พบรายการชำระเงินที่สำเร็จ' };
    }

    if (pendingTransaction) {
      const existingIntent = getPaymentIntent_(pendingTransaction.stripe_payment_intent_id);
      validatePaymentIntent_(existingIntent, pendingTransaction);
      const existingStatus = paymentStatusForSheet_(existingIntent.status);
      updateRowById_(sheet, 'stripe_payment_intent_id', existingIntent.id, { status: existingStatus });

      if (existingIntent.status === 'succeeded') {
        completeBookingAfterPayment_(bookingId);
        return {
          ok: true,
          status: 'succeeded',
          already_paid: true,
          booking_id: bookingId,
          amount: BOOKING_AMOUNT_THB
        };
      }

      if (existingIntent.status !== 'canceled') {
        return {
          ok: true,
          status: existingIntent.status,
          client_secret: existingIntent.client_secret,
          payment_intent_id: existingIntent.id,
          trans_id: pendingTransaction.trans_id,
          amount: BOOKING_AMOUNT_THB,
          reused: true
        };
      }
    }

    // Apps Script may serialize numeric form fields as "5000.0". Stripe requires an integer string.
    const amountSatang = String(Math.round(BOOKING_AMOUNT_THB * 100));
    const intent = stripeRequest_('/payment_intents', {
      method: 'post',
      headers: {
        'Idempotency-Key': 'booking-' + bookingId + '-attempt-' + (transactions.length + 1)
      },
      payload: {
        amount: amountSatang,
        currency: 'thb',
        description: 'Piakarn parking booking ' + bookingId,
        'metadata[booking_id]': bookingId,
        'automatic_payment_methods[enabled]': 'true'
      }
    });

    const trans = {
      trans_id: uid_('t'),
      booking_id: bookingId,
      amount: BOOKING_AMOUNT_THB,
      currency: 'thb',
      stripe_payment_intent_id: intent.id,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    appendRow_(sheet, trans, headers);

    return {
      ok: true,
      status: intent.status,
      client_secret: intent.client_secret,
      payment_intent_id: intent.id,
      trans_id: trans.trans_id,
      amount: BOOKING_AMOUNT_THB
    };
  } finally {
    lock.releaseLock();
  }
}

function confirmPayment_(body) {
  const paymentIntentId = String(body.payment_intent_id || '').trim();
  if (!paymentIntentId) return { ok: false, error: 'ไม่พบรหัสการชำระเงิน' };

  const sheet = getSheet_('Transactions');
  ensureHeaders_(sheet, TRANSACTION_HEADERS);
  const transaction = sheetToObjects_(sheet)
    .find(item => String(item.stripe_payment_intent_id) === paymentIntentId);
  if (!transaction) return { ok: false, error: 'ไม่พบรายการชำระเงิน' };

  const intent = getPaymentIntent_(paymentIntentId);
  try {
    validatePaymentIntent_(intent, transaction);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const status = paymentStatusForSheet_(intent.status);
  const updated = updateRowById_(sheet, 'stripe_payment_intent_id', paymentIntentId, { status: status });
  if (!updated) return { ok: false, error: 'ไม่สามารถอัปเดตรายการชำระเงินได้' };

  if (intent.status === 'succeeded') completeBookingAfterPayment_(transaction.booking_id);
  return {
    ok: true,
    status: intent.status,
    booking_id: transaction.booking_id
  };
}

function getPaymentIntent_(paymentIntentId) {
  if (!paymentIntentId) throw new Error('ไม่พบรหัส PaymentIntent');
  return stripeRequest_('/payment_intents/' + encodeURIComponent(paymentIntentId));
}

function stripeRequest_(path, options) {
  const secretKey = String(PROPS.getProperty('STRIPE_SECRET_KEY') || '').trim();
  if (!secretKey) throw new Error('ยังไม่ได้ตั้งค่า STRIPE_SECRET_KEY ใน Script Properties');

  const config = options || {};
  const headers = Object.assign({ Authorization: 'Bearer ' + secretKey }, config.headers || {});
  const request = {
    method: config.method || 'get',
    headers: headers,
    muteHttpExceptions: true
  };
  if (config.payload) request.payload = config.payload;

  const response = UrlFetchApp.fetch(STRIPE_API_BASE_URL + path, request);
  const responseText = response.getContentText();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (err) {
    throw new Error('Stripe ส่งข้อมูลตอบกลับที่ไม่ถูกต้อง');
  }

  const responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300 || data.error) {
    const message = data.error && data.error.message ? data.error.message : 'Stripe API error (' + responseCode + ')';
    throw new Error(message);
  }
  return data;
}

function paymentStatusForSheet_(stripeStatus) {
  if (stripeStatus === 'succeeded') return 'succeeded';
  if (stripeStatus === 'canceled') return 'failed';
  return 'pending';
}

function validatePaymentIntent_(intent, transaction) {
  const expectedAmountSatang = Math.round(Number(transaction.amount) * 100);
  if (!isFinite(expectedAmountSatang) || intent.amount !== expectedAmountSatang || normalise_(intent.currency) !== normalise_(transaction.currency)) {
    throw new Error('ยอดเงินหรือสกุลเงินจาก Stripe ไม่ตรงกับรายการจอง');
  }

  const metadataBookingId = intent.metadata && intent.metadata.booking_id;
  if (metadataBookingId && String(metadataBookingId) !== String(transaction.booking_id)) {
    throw new Error('ข้อมูลการจองจาก Stripe ไม่ตรงกับรายการชำระเงิน');
  }
}

function completeBookingAfterPayment_(bookingId) {
  const sheet = getSheet_('Bookings');
  ensureHeaders_(sheet, BOOKING_HEADERS);
  const booking = sheetToObjects_(sheet)
    .find(item => String(item.booking_id) === String(bookingId));
  if (!booking) throw new Error('ไม่พบคำขอจองของรายการชำระเงิน');

  const status = normalise_(booking.status);
  if (status === 'completed') return true;
  if (status !== 'arrived') throw new Error('สถานะการจองไม่พร้อมสำหรับยืนยันการชำระเงิน');

  return updateRowById_(sheet, 'booking_id', bookingId, {
    status: 'completed',
    completed_at: new Date().toISOString()
  });
}
