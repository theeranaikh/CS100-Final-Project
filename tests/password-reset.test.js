const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const USER_HEADERS = [
  'user_id', 'name', 'phone', 'plate', 'role', 'permit_type',
  'password_hash', 'created_at', 'available', 'lat', 'lng', 'last_seen_at'
];

class FakeSheet {
  constructor(headers, objects) {
    this.values = [headers.slice()];
    (objects || []).forEach(object => {
      this.values.push(headers.map(header => object[header] === undefined ? '' : object[header]));
    });
  }

  getLastRow() { return this.values.length; }
  getLastColumn() { return this.values[0].length; }
  getDataRange() { return { getValues: () => this.values.map(row => row.slice()) }; }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    return {
      getValues: () => Array.from({ length: rowCount }, (_, rowOffset) =>
        Array.from({ length: columnCount }, (_, columnOffset) =>
          (this.values[row - 1 + rowOffset] || [])[column - 1 + columnOffset]
        )
      ),
      setValue: value => {
        while (this.values.length < row) this.values.push([]);
        this.values[row - 1][column - 1] = value;
        return this.getRange(row, column, rowCount, columnCount);
      },
      setValues: values => {
        values.forEach((sourceRow, rowOffset) => {
          while (this.values.length < row + rowOffset) this.values.push([]);
          sourceRow.forEach((value, columnOffset) => {
            this.values[row - 1 + rowOffset][column - 1 + columnOffset] = value;
          });
        });
        return this.getRange(row, column, rowCount, columnCount);
      },
      setNumberFormat: () => this.getRange(row, column, rowCount, columnCount)
    };
  }

  appendRow(row) { this.values.push(row.slice()); }

  objects() {
    const headers = this.values[0];
    return this.values.slice(1).map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  }
}

function response(body, status = 200) {
  return {
    getContentText: () => JSON.stringify(body),
    getResponseCode: () => status
  };
}

function toBuffer(value) {
  if (Array.isArray(value)) return Buffer.from(value.map(byte => byte & 0xff));
  return Buffer.from(String(value));
}

function createHarness({ users, serviceSid = 'VA_service', twilioHandler, demoBypass } = {}) {
  const sheets = {
    Users: new FakeSheet(USER_HEADERS, users || [{
      user_id: 'u_1',
      name: 'Test User',
      phone: 812345678,
      role: 'driver',
      password_hash: 'old_hash'
    }])
  };
  const properties = new Map([
    ['SHEET_ID', 'sheet_1'],
    ['TWILIO_ACCOUNT_SID', 'AC_test'],
    ['TWILIO_AUTH_TOKEN', 'auth_test']
  ]);
  if (serviceSid) properties.set('TWILIO_VERIFY_SERVICE_SID', serviceSid);
  if (demoBypass !== undefined) properties.set('PASSWORD_RESET_DEMO_BYPASS', String(demoBypass));

  const cacheValues = new Map();
  const requests = [];
  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.get(key) || '',
        setProperty: (key, value) => properties.set(key, value)
      })
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: name => sheets[name] })
    },
    CacheService: {
      getScriptCache: () => ({
        get: key => cacheValues.get(key) || null,
        put: (key, value) => cacheValues.set(key, String(value)),
        remove: key => cacheValues.delete(key)
      })
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        requests.push({ url, options });
        return twilioHandler ? twilioHandler(url, options) : response({ sid: 'VE_test', status: 'pending' });
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(String(value)).digest()),
      base64Encode: value => toBuffer(value).toString('base64'),
      getUuid: () => '12345678-abcd-efgh-ijkl-123456789012'
    }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  vm.runInContext(source, context);

  return {
    call: expression => JSON.parse(JSON.stringify(vm.runInContext(expression, context))),
    properties,
    requests,
    sheets
  };
}

test('normalizes local and international Thai mobile numbers', () => {
  const harness = createHarness();

  assert.equal(harness.call('thaiPhoneToE164_("081-234-5678")'), '+66812345678');
  assert.equal(harness.call('phoneLookupKey_("+66 81 234 5678")'), '812345678');
});

test('sends a Twilio verification only for a registered phone', () => {
  const harness = createHarness();

  const result = harness.call('requestPasswordReset_({ phone: "081 234 5678" })');

  assert.equal(result.ok, true);
  assert.equal(result.retry_after, 60);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].options.payload.To, '+66812345678');
  assert.equal(harness.requests[0].options.payload.Channel, 'sms');
  assert.match(harness.requests[0].options.headers.Authorization, /^Basic /);
});

test('does not reveal or send SMS for an unregistered phone', () => {
  const harness = createHarness();

  const result = harness.call('requestPasswordReset_({ phone: "0899999999" })');

  assert.equal(result.ok, true);
  assert.match(result.message, /หากเบอร์นี้มีบัญชี/);
  assert.equal(harness.requests.length, 0);
});

test('rate limits repeated reset-code requests when demo bypass is disabled', () => {
  const harness = createHarness({ demoBypass: false });

  const first = harness.call('requestPasswordReset_({ phone: "0812345678" })');
  const second = harness.call('requestPasswordReset_({ phone: "0812345678" })');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.error, /60 วินาที/);
  assert.equal(harness.requests.length, 1);
});

test('creates and stores a Twilio Verify Service when no service SID is configured', () => {
  const harness = createHarness({
    serviceSid: '',
    twilioHandler: (url) => {
      if (url.endsWith('/Services')) return response({ sid: 'VA_created' }, 201);
      return response({ sid: 'VE_test', status: 'pending' }, 201);
    }
  });

  const result = harness.call('requestPasswordReset_({ phone: "0812345678" })');

  assert.equal(result.ok, true);
  assert.equal(harness.properties.get('TWILIO_VERIFY_SERVICE_SID'), 'VA_created');
  assert.equal(harness.requests.length, 2);
  assert.ok(harness.requests[1].url.includes('/Services/VA_created/Verifications'));
});

test('opens the OTP step when Twilio rejects a request in default demo mode', () => {
  const harness = createHarness({
    twilioHandler: () => response({
      code: 21608,
      message: 'The phone number is unverified. Trial accounts cannot send messages to unverified numbers.'
    }, 400)
  });

  const result = harness.call('requestPasswordReset_({ phone: "0812345678" })');

  assert.equal(result.ok, true);
  assert.equal(harness.requests.length, 1);
});

test('allows the fixed demo code by default for an existing account', () => {
  const harness = createHarness({
    twilioHandler: () => response({
      code: 21608,
      message: 'The phone number is unverified. Trial accounts cannot send messages to unverified numbers.'
    }, 400)
  });

  const request = harness.call('requestPasswordReset_({ phone: "0812345678" })');
  const reset = harness.call('resetPassword_({ phone: "0812345678", code: "676767", password: "demo-password" })');
  const login = harness.call('login_({ phone: "0812345678", password: "demo-password" })');

  assert.equal(request.ok, true);
  assert.equal(reset.ok, true);
  assert.equal(login.ok, true);
  assert.equal(harness.requests.length, 1);
});

test('does not allow the demo code when demo bypass is explicitly disabled', () => {
  const harness = createHarness({
    demoBypass: false,
    twilioHandler: () => response({ status: 'pending' })
  });

  const reset = harness.call('resetPassword_({ phone: "0812345678", code: "676767", password: "demo-password" })');

  assert.equal(reset.ok, false);
  assert.equal(harness.sheets.Users.objects()[0].password_hash, 'old_hash');
});

test('changes the password only after Twilio approves the code', () => {
  const harness = createHarness({
    twilioHandler: () => response({ status: 'approved' })
  });

  const result = harness.call('resetPassword_({ phone: "+66812345678", code: "123456", password: "new-password" })');
  const login = harness.call('login_({ phone: "0812345678", password: "new-password" })');

  assert.equal(result.ok, true);
  assert.equal(login.ok, true);
  assert.notEqual(harness.sheets.Users.objects()[0].password_hash, 'old_hash');
});

test('keeps the old password when Twilio rejects the code', () => {
  const harness = createHarness({
    twilioHandler: () => response({ status: 'pending' })
  });

  const result = harness.call('resetPassword_({ phone: "0812345678", code: "000000", password: "new-password" })');

  assert.equal(result.ok, false);
  assert.match(result.error, /ไม่ถูกต้องหรือหมดอายุ/);
  assert.equal(harness.sheets.Users.objects()[0].password_hash, 'old_hash');
});
