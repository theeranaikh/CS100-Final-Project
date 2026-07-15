const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createHarness() {
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => '' })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: contents => ({
        contents,
        setMimeType() { return this; }
      })
    }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  vm.runInContext(source, context);

  return event => JSON.parse(vm.runInContext('doPost', context)(event).contents);
}

test('doPost dispatches password reset actions from the query string', () => {
  const post = createHarness();
  const result = post({
    parameter: { action: 'requestPasswordReset' },
    postData: { contents: JSON.stringify({ phone: '123' }) }
  });

  assert.notEqual(result.error, 'Unknown POST action');
  assert.match(result.error, /เบอร์มือถือไทย/);
});

test('doPost falls back to the action in the JSON body', () => {
  const post = createHarness();
  const result = post({
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'resetPassword' }) }
  });

  assert.notEqual(result.error, 'Unknown POST action');
  assert.match(result.error, /รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร/);
});
