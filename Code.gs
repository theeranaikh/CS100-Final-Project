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
 *   Users:        user_id | name | phone | plate | role | permit_type | password_hash | created_at
 *   Bookings:     booking_id | driver_id | owner_id | status | lat | lng | requested_at | matched_at | eta_minutes | completed_at | rating
 *   Transactions: trans_id | booking_id | amount | currency | stripe_payment_intent_id | status | created_at
 */

const PROPS = PropertiesService.getScriptProperties();

function getSheet_(name) {
  const ss = SpreadsheetApp.openById(PROPS.getProperty('SHEET_ID'));
  return ss.getSheetByName(name);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  return values.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
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
  const body = JSON.parse(e.postData.contents || '{}');
  try {
    switch (action) {
      case 'register': return jsonOut_(register_(body));
      case 'login': return jsonOut_(login_(body));
      case 'requestBooking': return jsonOut_(requestBooking_(body));
      case 'findNearestOwner': return jsonOut_(findNearestOwner_(body));
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
  const user = {
    user_id: uid_('u'),
    name: body.name,
    phone: body.phone,
    plate: body.plate || '',
    role: body.role, // 'driver' | 'owner'
    permit_type: body.permit_type || '',
    password_hash: Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body.password)
    ),
    created_at: new Date().toISOString()
  };
  appendRow_(sheet, user, ['user_id','name','phone','plate','role','permit_type','password_hash','created_at']);
  delete user.password_hash;
  return { ok: true, user: user };
}

function login_(body) {
  const users = sheetToObjects_(getSheet_('Users'));
  const hash = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body.password)
  );
  const found = users.find(u => u.phone === body.phone && u.password_hash === hash);
  if (!found) return { ok: false, error: 'Invalid credentials' };
  delete found.password_hash;
  return { ok: true, user: found };
}

// ---------- BOOKINGS ----------

function requestBooking_(body) {
  const sheet = getSheet_('Bookings');
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
    completed_at: '',
    rating: ''
  };
  appendRow_(sheet, booking, ['booking_id','driver_id','owner_id','status','lat','lng','requested_at','matched_at','eta_minutes','completed_at','rating']);
  return { ok: true, booking: booking };
}

// หา owner ที่ role=owner และไม่มี booking ค้าง (status matched/waiting) อยู่ — เรียงตามระยะทางแบบ straight-line
function findNearestOwner_(body) {
  const users = sheetToObjects_(getSheet_('Users'));
  const bookings = sheetToObjects_(getSheet_('Bookings'));
  const busyOwnerIds = new Set(
    bookings.filter(b => ['matched','waiting'].includes(b.status)).map(b => b.owner_id)
  );
  const owners = users.filter(u => u.role === 'owner' && !busyOwnerIds.has(u.user_id));
  if (owners.length === 0) return { ok: false, error: 'No available owner nearby' };

  // ถ้ามีพิกัด owner เก็บไว้ ให้คำนวณระยะทางจริง (ในตัวอย่างนี้สุ่ม/เลือกตัวแรกไว้ก่อน
  // แนะนำให้ต่อ Google Distance Matrix API แทนในระบบจริง)
  const owner = owners[0];

  const etaMinutes = 45; // ตาม flowchart เดิม — แทนที่ด้วยผลจาก Distance Matrix API ได้
  updateRowById_(getSheet_('Bookings'), 'booking_id', body.booking_id, {
    owner_id: owner.user_id,
    status: 'matched',
    matched_at: new Date().toISOString(),
    eta_minutes: etaMinutes
  });
  return { ok: true, owner_id: owner.user_id, eta_minutes: etaMinutes };
}

function updateBookingStatus_(body) {
  const updates = { status: body.status };
  if (body.status === 'completed') updates.completed_at = new Date().toISOString();
  const ok = updateRowById_(getSheet_('Bookings'), 'booking_id', body.booking_id, updates);
  return { ok: ok };
}

function rateBooking_(body) {
  const ok = updateRowById_(getSheet_('Bookings'), 'booking_id', body.booking_id, { rating: body.rating });
  return { ok: ok };
}

function listBookings_(params) {
  const bookings = sheetToObjects_(getSheet_('Bookings'));
  if (params.driver_id) return bookings.filter(b => b.driver_id === params.driver_id);
  if (params.owner_id) return bookings.filter(b => b.owner_id === params.owner_id);
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
  const trans = {
    trans_id: uid_('t'),
    booking_id: body.booking_id,
    amount: body.amount,
    currency: 'thb',
    stripe_payment_intent_id: intent.id,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  appendRow_(sheet, trans, ['trans_id','booking_id','amount','currency','stripe_payment_intent_id','status','created_at']);

  return { ok: true, client_secret: intent.client_secret, trans_id: trans.trans_id };
}

function confirmPayment_(body) {
  const ok = updateRowById_(getSheet_('Transactions'), 'stripe_payment_intent_id', body.payment_intent_id, {
    status: body.status // 'succeeded' | 'failed'
  });
  return { ok: ok };
}
