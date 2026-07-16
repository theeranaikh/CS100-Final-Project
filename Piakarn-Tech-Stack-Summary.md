# สรุปเทคโนโลยีที่ใช้ในโปรเจกต์ Piakarn (ที่จอดพร้อม เมื่อคุณต้องการ)

โปรเจกต์: แอปพลิเคชันหาที่จอดรถ (CS100 Final Project)

## Frontend
- **HTML + CSS + Vanilla JavaScript** — ไม่มี framework และไม่มี build step เป็น Single Page App ควบคุมด้วยไฟล์ `app.js` (~1,200 บรรทัด)
- **Google Fonts** — Bricolage Grotesque, IBM Plex Sans Thai
- **Lucide Icons** — ชุดไอคอน
- **Stripe.js** (`js.stripe.com/v3`) — ฝั่ง client สำหรับฟอร์มชำระเงิน
- **Google Maps JavaScript API** — แสดงแผนที่และตำแหน่งของคนขับ/เจ้าของที่จอด
- **Hosting:** GitHub Pages (มีไฟล์ `CNAME` ชี้โดเมน `piakarn.theeranai.dev`)

## Backend
- **Google Apps Script** (`Code.gs`, 771 บรรทัด) ทำหน้าที่เป็น REST-like API ผ่านฟังก์ชัน `doGet` / `doPost` และ deploy เป็น Web App

## ฐานข้อมูล (Database)
- **Google Sheets** เป็นฐานข้อมูลหลัก เข้าถึงผ่าน `SpreadsheetApp` แบ่งเป็น 3 ชีต:
  - `Users`
  - `Bookings`
  - `Transactions`

## API / บริการภายนอกที่เชื่อมต่อ
- **Stripe API** — สร้าง/ยืนยัน Payment Intent สำหรับชำระเงินค่าบริการจอง
- **Twilio Verify API** — ส่ง OTP เพื่อยืนยันเบอร์โทรศัพท์และรีเซ็ตรหัสผ่าน
- **Google Maps API** (Maps JS + Distance Matrix)

## Testing
- **Node.js built-in test runner** (`node:test`, `node:assert`) — ทดสอบไฟล์ `Code.gs` ผ่าน `vm` module โดย mock `PropertiesService` และ `ContentService`
- มีไฟล์ทดสอบ 3 ไฟล์: `routes.test.js`, `payment.test.js`, `password-reset.test.js`
