const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BOOKING_HEADERS = [
  'booking_id', 'driver_id', 'owner_id', 'status', 'lat', 'lng',
  'requested_at', 'matched_at', 'eta_minutes', 'owner_response_at',
  'arrived_at', 'completed_at', 'rating'
];
const TRANSACTION_HEADERS = [
  'trans_id', 'booking_id', 'amount', 'currency',
  'stripe_payment_intent_id', 'status', 'created_at'
];

class FakeSheet {
  constructor(headers, objects) {
    this.values = [headers.slice()];
    (objects || []).forEach(object => {
      this.values.push(headers.map(header => object[header] === undefined ? '' : object[header]));
    });
  }

  getLastRow() {
    return this.values.length;
  }

  getLastColumn() {
    return this.values[0] ? this.values[0].length : 0;
  }

  getDataRange() {
    return { getValues: () => this.values.map(row => row.slice()) };
  }

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

  appendRow(row) {
    this.values.push(row.slice());
  }

  objects() {
    const headers = this.values[0];
    return this.values.slice(1).map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  }
}

function stripeResponse(body, responseCode = 200) {
  return {
    getContentText: () => JSON.stringify(body),
    getResponseCode: () => responseCode
  };
}

function createHarness({ bookingStatus = 'arrived', transactions = [], stripeHandler }) {
  const sheets = {
    Bookings: new FakeSheet(BOOKING_HEADERS, [{
      booking_id: 'b_1',
      driver_id: 'u_driver',
      owner_id: 'u_owner',
      status: bookingStatus,
      arrived_at: '2026-07-15T00:00:00.000Z'
    }]),
    Transactions: new FakeSheet(TRANSACTION_HEADERS, transactions)
  };
  const requests = [];
  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => ({ SHEET_ID: 'sheet_1', STRIPE_SECRET_KEY: 'sk_test_example' })[key] || ''
      })
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: name => sheets[name] })
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        requests.push({ url, options });
        return stripeHandler(url, options);
      }
    },
    Utilities: {
      getUuid: () => '12345678-abcd-efgh-ijkl-123456789012'
    }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  vm.runInContext(source, context);

  return {
    call: expression => JSON.parse(JSON.stringify(vm.runInContext(expression, context))),
    requests,
    sheets
  };
}

test('createPaymentIntent uses the server price and stores one transaction', () => {
  const harness = createHarness({
    stripeHandler: () => stripeResponse({
      id: 'pi_new',
      client_secret: 'pi_new_secret',
      status: 'requires_payment_method'
    })
  });

  const result = harness.call('createPaymentIntent_({ booking_id: "b_1", amount: 0.01 })');

  assert.equal(result.ok, true);
  assert.equal(result.amount, 50);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].options.payload.amount, '5000');
  assert.equal(harness.requests[0].options.payload['metadata[booking_id]'], 'b_1');
  assert.equal(harness.sheets.Transactions.objects().length, 1);
  assert.equal(harness.sheets.Transactions.objects()[0].amount, 50);
});

test('createPaymentIntent reuses an unfinished PaymentIntent', () => {
  const harness = createHarness({
    transactions: [{
      trans_id: 't_1',
      booking_id: 'b_1',
      amount: 50,
      currency: 'thb',
      stripe_payment_intent_id: 'pi_existing',
      status: 'pending',
      created_at: '2026-07-15T00:00:00.000Z'
    }],
    stripeHandler: () => stripeResponse({
      id: 'pi_existing',
      amount: 5000,
      currency: 'thb',
      client_secret: 'pi_existing_secret',
      status: 'requires_payment_method',
      metadata: { booking_id: 'b_1' }
    })
  });

  const result = harness.call('createPaymentIntent_({ booking_id: "b_1" })');

  assert.equal(result.reused, true);
  assert.equal(result.client_secret, 'pi_existing_secret');
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].options.method, 'get');
  assert.equal(harness.sheets.Transactions.objects().length, 1);
});

test('createPaymentIntent repairs a paid booking without creating a second intent', () => {
  const harness = createHarness({
    transactions: [{
      trans_id: 't_1',
      booking_id: 'b_1',
      amount: 50,
      currency: 'thb',
      stripe_payment_intent_id: 'pi_paid',
      status: 'succeeded',
      created_at: '2026-07-15T00:00:00.000Z'
    }],
    stripeHandler: () => stripeResponse({
      id: 'pi_paid',
      amount: 5000,
      currency: 'thb',
      status: 'succeeded',
      metadata: { booking_id: 'b_1' }
    })
  });

  const result = harness.call('createPaymentIntent_({ booking_id: "b_1" })');

  assert.equal(result.already_paid, true);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.sheets.Bookings.objects()[0].status, 'completed');
});

test('confirmPayment trusts Stripe status instead of browser status', () => {
  const harness = createHarness({
    transactions: [{
      trans_id: 't_1',
      booking_id: 'b_1',
      amount: 50,
      currency: 'thb',
      stripe_payment_intent_id: 'pi_processing',
      status: 'pending',
      created_at: '2026-07-15T00:00:00.000Z'
    }],
    stripeHandler: () => stripeResponse({
      id: 'pi_processing',
      amount: 5000,
      currency: 'thb',
      status: 'processing',
      metadata: { booking_id: 'b_1' }
    })
  });

  const result = harness.call('confirmPayment_({ payment_intent_id: "pi_processing", status: "succeeded" })');

  assert.equal(result.status, 'processing');
  assert.equal(harness.sheets.Transactions.objects()[0].status, 'pending');
  assert.equal(harness.sheets.Bookings.objects()[0].status, 'arrived');
});

test('confirmPayment completes the booking only after Stripe succeeds', () => {
  const harness = createHarness({
    transactions: [{
      trans_id: 't_1',
      booking_id: 'b_1',
      amount: 50,
      currency: 'thb',
      stripe_payment_intent_id: 'pi_paid',
      status: 'pending',
      created_at: '2026-07-15T00:00:00.000Z'
    }],
    stripeHandler: () => stripeResponse({
      id: 'pi_paid',
      amount: 5000,
      currency: 'thb',
      status: 'succeeded',
      metadata: { booking_id: 'b_1' }
    })
  });

  const result = harness.call('confirmPayment_({ payment_intent_id: "pi_paid" })');

  assert.equal(result.status, 'succeeded');
  assert.equal(harness.sheets.Transactions.objects()[0].status, 'succeeded');
  assert.equal(harness.sheets.Bookings.objects()[0].status, 'completed');
  assert.ok(harness.sheets.Bookings.objects()[0].completed_at);
});

test('confirmPayment rejects a Stripe amount mismatch', () => {
  const harness = createHarness({
    transactions: [{
      trans_id: 't_1',
      booking_id: 'b_1',
      amount: 50,
      currency: 'thb',
      stripe_payment_intent_id: 'pi_wrong_amount',
      status: 'pending',
      created_at: '2026-07-15T00:00:00.000Z'
    }],
    stripeHandler: () => stripeResponse({
      id: 'pi_wrong_amount',
      amount: 100,
      currency: 'thb',
      status: 'succeeded',
      metadata: { booking_id: 'b_1' }
    })
  });

  const result = harness.call('confirmPayment_({ payment_intent_id: "pi_wrong_amount" })');

  assert.equal(result.ok, false);
  assert.match(result.error, /ยอดเงินหรือสกุลเงิน/);
  assert.equal(harness.sheets.Bookings.objects()[0].status, 'arrived');
});
