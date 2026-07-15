/**
 * Piakarn Parking Space — Frontend Configuration
 *
 * คัดลอกไฟล์นี้และแก้ไขค่าด้านล่างด้วยค่าจริงของคุณ:
 *   1. APPS_SCRIPT_API_URL  — URL จาก Deploy > New deployment > Web App
 *   2. STRIPE_PUBLISHABLE_KEY — pk_test_xxx หรือ pk_live_xxx
 *   3. GOOGLE_MAPS_API_KEY   — API Key ที่เปิดใช้ Maps JS API + Distance Matrix API
 *
 * ⚠️  ห้ามใส่ Stripe Secret Key หรือ Google Sheet ID ที่นี่
 *     ให้ไปตั้งใน Google Apps Script > Project Settings > Script Properties แทน
 */
window.APP_CONFIG = {
  APPS_SCRIPT_API_URL: 'https://script.google.com/macros/s/AKfycbyb-rNfuZLAuUMsawDH_LY9WS7ajyhNtPIC8GG5e7-DE-rk9J-xJE2-5D4jKGgekzes/exec',       // ← ใส่ URL ของ Apps Script Web App
  STRIPE_PUBLISHABLE_KEY: 'pk_test_51Tsee8Jtg9AC5RjGKCJp9wrMeUY6RSRsT5DutVxQFfXDAGMXnpwfy9EPTJQl6dZqQsgCgjOre9zV5AQNau722THt0046XRsR1w',    // ← ใส่ pk_test_... หรือ pk_live_...
  GOOGLE_MAPS_API_KEY: 'AIzaSyDChQ__hGVj7SN5xNJiDu1GYZntEi9u2go',       // ← ใส่ Google Maps API Key
};
