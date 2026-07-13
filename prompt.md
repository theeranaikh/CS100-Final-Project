# PROMPT.md — Piakarn Parking Space (Web App)
> ใช้ไฟล์นี้เป็น "master prompt" ป้อนให้ AI coding tool (Cursor / Windsurf / v0 / Claude Code ฯลฯ) เพื่อ vibe-code เว็บแอปทั้งระบบ

---

## 0. สรุปการเปลี่ยนแปลงจากแพลนเดิม

| เดิม | ใหม่ |
|---|---|
| Database: PostgreSQL / MongoDB | **Google Sheets** (ผ่าน Google Apps Script API) |
| Front-end: React Native / Flutter (mobile) | **Web App** (HTML/CSS/JS) ตามโจทย์ CS100 ที่ต้องส่ง URL Web Application |
| Payment: Omise / Stripe (เลือกอย่างใดอย่างหนึ่ง) | **Stripe** เท่านั้น |
| ฝั่งที่ให้บริการที่จอด: "คนพิการ" | **"เจ้าของสิทธิ์จอดรถ" (Space Owner / Right Holder)** — คือผู้ถือสิทธิ์ใช้ช่องจอดสำรอง (เช่น ช่องจอดที่จองไว้/ช่องสิทธิพิเศษ) ที่ ณ ขณะนั้นไม่ได้ใช้งาน และยินยอมปล่อยสิทธิ์ชั่วคราวให้ผู้ขับขี่คนอื่นใช้จอดฉุกเฉิน |

**เหตุผลของการเปลี่ยน role:** โมเดลเดิมที่ "เรียกคนพิการมาเปิดสิทธิ์" มีปัญหาเชิงจริยธรรม เพราะทำให้คนพิการกลายเป็น "บริการตามคำสั่ง" ของคนอื่น การเปลี่ยนเป็น **เจ้าของสิทธิ์จอดรถ** ทำให้ระบบเป็นกลางทางแนวคิด: ใครก็ตามที่ถือสิทธิ์ใช้ช่องจอดพิเศษ (ไม่ว่าจะเป็นสิทธิ์ผู้พิการ, สิทธิ์ VIP, สิทธิ์คอนโด ฯลฯ) สามารถเลือกปล่อยสิทธิ์ชั่วคราวเพื่อรับค่าตอบแทนได้ด้วยความสมัครใจ — ระบบเป็น "marketplace ปล่อยเช่าสิทธิ์จอดรถ" ไม่ใช่ระบบเรียกใช้ตัวบุคคล

---

## 1. Problem Statement

ผู้ขับขี่จำนวนมากเจอปัญหาหาที่จอดรถไม่ได้ในช่วงเร่งด่วน ขณะที่ช่องจอดสิทธิพิเศษ (reserved/permit spot) จำนวนมากว่างอยู่โดยเจ้าของสิทธิ์ไม่ได้ใช้งานในขณะนั้น **Piakarn Parking Space** จึงเป็นแพลตฟอร์มที่จับคู่ผู้ขับขี่ที่ต้องการที่จอดด่วนกับเจ้าของสิทธิ์ที่ยินยอมปล่อยช่องจอดชั่วคราว โดยมีระบบยืนยันตัวตน ระบบจับเวลา และระบบชำระเงินผ่านแอปรองรับ

---

## 2. Computational Thinking mapping (สำหรับใส่ใน Presentation)

- **Decomposition:** แยกระบบเป็น 5 โมดูล — Auth, Request/Matching, Tracking (45-min countdown), Payment, Rating
- **Pattern Recognition:** ทุก transaction มีรูปแบบเดียวกันคือ User → Booking → Transaction (เหมือนระบบ ride-hailing / marketplace)
- **Abstraction:** ซ่อนรายละเอียดการคำนวณระยะทาง/ระยะเวลาไว้หลัง Google Maps API, ซ่อน logic การตัดเงินไว้หลัง Stripe API
- **Algorithm Design:** ตาม flowchart เดิม (ปรับคำ) — เริ่มจากปัญหา → เช็คว่าต้องการจอดด่วนหรือไม่ → ถ้าใช่ เปิดแอป → ระบบจับคู่กับเจ้าของสิทธิ์ที่ใกล้ที่สุด → รอเจ้าของสิทธิ์เดินทางมา (นับถอยหลัง 45 นาที) → ตัดเงินผ่านแอป → จบ

---

## 3. User Roles

1. **Driver (ผู้ขับขี่)** — ผู้ต้องการที่จอดด่วน กดขอใช้บริการ, ชำระเงิน, ให้คะแนน
2. **Space Owner (เจ้าของสิทธิ์)** — ผู้ถือสิทธิ์ช่องจอด รับคำขอ, เดินทางมาเปิดสิทธิ์/ยืนยันให้ใช้ช่อง, รับเงิน

---

## 4. Tech Stack

- **Front-end:** HTML + CSS + Vanilla JS (Single Page, responsive) — เลือก vanilla เพื่อ deploy ง่ายเป็น Web App เดี่ยว ไม่ต้อง build step, เรียก Apps Script API ด้วย `fetch()`
- **Back-end / API:** **Google Apps Script** deploy เป็น Web App (`doGet` / `doPost`) — ทำหน้าที่เป็น REST-like API
- **Database:** **Google Sheets** (3 ชีต: `Users`, `Bookings`, `Transactions`)
- **Payment:** **Stripe** (Stripe.js + Payment Element ฝั่ง frontend, Stripe REST API เรียกผ่าน `UrlFetchApp` ฝั่ง Apps Script เพื่อสร้าง PaymentIntent — **ห้ามเก็บ Secret Key ไว้ฝั่ง frontend**)
- **Location:** Google Maps JavaScript API + Places/Distance Matrix (คำนวณระยะเวลาเดินทางแทนค่าคงที่ 45 นาที)
- **Notification (optional):** Twilio SMS API

---

## 5. UI/UX Style Reference

อ้างอิงสไตล์จาก https://dribbble.com/shots/27025736-Car-Parking-Mobile-App (แนวเดียวกับ genre "car parking mobile app" บน Dribbble) นำมาปรับเป็นเว็บ (desktop + mobile responsive):

- **โทนสี:** Dark navy `#0B1E3D` เป็นพื้นหลังหลัก + accent สีฟ้าสด `#3D8BFF` สำหรับปุ่ม CTA + การ์ดพื้นขาว/เทาอ่อนลอยด้านบน (bottom-sheet card)
- **เลย์เอาต์หน้า Home:** แผนที่เต็มจอด้านบน (Google Map) + การ์ดลอย (floating bottom sheet, bo-radius 24px) ด้านล่างแสดงปุ่ม "หาที่จอดด่วน"
- **ปุ่มหลัก:** ปุ่มกลม/แคปซูลขนาดใหญ่ สีฟ้า ตัวหนังสือขาว มี icon เช่น 🅿️/นาฬิกา
- **Typography:** Sans-serif สมัยใหม่ (เช่น Inter / Poppins), หัวข้อหนา ตัวอักษรรองบางลง
- **หน้าจอที่ต้องมี:** Login/Register (เลือก role), Home (แผนที่ + ปุ่มขอที่จอดด่วน), หน้าจับคู่ + นับถอยหลัง 45 นาที (progress ring), หน้าชำระเงิน (Stripe Payment Element), หน้าให้คะแนน, หน้า Dashboard เจ้าของสิทธิ์ (รับ/ปฏิเสธคำขอ)
- ทุกหน้าต้อง responsive ทั้ง mobile และ desktop (ตาม rubric ข้อ 4)

---

## 6. Google Sheets Schema (แทน PostgreSQL เดิม)

**Spreadsheet เดียว 3 ชีต:**

### ชีต `Users`
| user_id | name | phone | plate | role (driver/owner) | permit_type | password_hash | created_at |

### ชีต `Bookings`
| booking_id | driver_id | owner_id | status (pending/matched/waiting/completed/cancelled) | lat | lng | requested_at | matched_at | eta_minutes | completed_at |

### ชีต `Transactions`
| trans_id | booking_id | amount | currency | stripe_payment_intent_id | status (pending/succeeded/failed) | created_at |

> Apps Script ใช้ `SpreadsheetApp.openById(SHEET_ID)` เข้าถึงทั้ง 3 ชีตนี้ — ห้าม hardcode SHEET_ID ในโค้ดที่ commit ให้ดึงจาก Script Properties แทน

---

## 7. API Endpoints (ผ่าน Apps Script Web App เดียว, ใช้ query param `action`)

ทุก request ยิงไปที่ `WEB_APP_URL?action=<name>` (GET สำหรับอ่าน, POST + JSON body สำหรับเขียน)

| action | method | หน้าที่ |
|---|---|---|
| `register` | POST | สร้างผู้ใช้ใหม่ใน `Users` |
| `login` | POST | ตรวจสอบ user/password คืนค่า user object |
| `requestBooking` | POST | Driver สร้าง booking ใหม่ (status=pending) |
| `findNearestOwner` | POST | ค้นหา owner ที่ว่าง+ใกล้ที่สุด (ใช้ lat/lng + Distance Matrix) → update booking เป็น matched |
| `updateBookingStatus` | POST | เปลี่ยนสถานะ booking (waiting/completed/cancelled) |
| `createPaymentIntent` | POST | เรียก Stripe API สร้าง PaymentIntent, บันทึกลง `Transactions` |
| `confirmPayment` | POST | Stripe webhook/callback อัปเดตสถานะ transaction |
| `rateBooking` | POST | บันทึกคะแนนใน `Bookings` |
| `listBookings` | GET | ดึงประวัติการจอง (ใช้แสดง dashboard) |

ดู implementation เต็มใน `appscript/Code.gs`

---

## 8. Stripe Payment Flow

1. Frontend โหลด Stripe.js ด้วย **Publishable Key** (`STRIPE_PUBLISHABLE_KEY` ใน `.env`)
2. Driver กดชำระเงิน → frontend เรียก Apps Script `createPaymentIntent` (ส่ง booking_id, amount)
3. Apps Script (ฝั่ง server) ใช้ **Secret Key** ที่เก็บใน `PropertiesService.getScriptProperties()` (ไม่ใช่ .env — Apps Script ไม่มี .env) ยิง `UrlFetchApp.fetch()` ไปที่ `https://api.stripe.com/v1/payment_intents` เพื่อสร้าง PaymentIntent และคืน `client_secret`
4. Frontend ใช้ `client_secret` กับ Stripe Payment Element เพื่อ confirm การชำระเงิน
5. Frontend เรียก `confirmPayment` เพื่ออัปเดตสถานะใน `Transactions`

---

## 9. Environment Variables (ฝั่ง Frontend เท่านั้น)

Apps Script ไม่รองรับไฟล์ `.env` โดยตรง — Secret ฝั่ง server (Stripe Secret Key, Sheet ID) ให้ตั้งผ่าน **Script Properties** ในโปรเจกต์ Apps Script (Project Settings → Script Properties) แทน ส่วนไฟล์ `.env` (ดูไฟล์ `.env.example` ที่แนบมา) ใช้สำหรับ config ฝั่ง frontend เท่านั้น (ค่าที่ปลอดภัยจะ public ได้ เช่น publishable key และ URL ของ Apps Script Web App)

---

## 10. Flowchart ใหม่ (คำอธิบายสำหรับวาดใน Figma/Canva)

```
[Start: Piakarn Parking Space]
        ↓
[ปัญหา: หาที่จอดรถด่วนไม่ได้]
        ↓
   <ต้องการจอดด่วนหรือไม่?>
     Yes ↓         ↓ No
[เปิดแอป Piakarn]  [หาที่จอดเอง]
        ↓                ↓
[ระบบจับคู่เจ้าของสิทธิ์ที่ใกล้ที่สุด]  [End]
        ↓
[รอเจ้าของสิทธิ์เดินทางมา ~45 นาที (นับถอยหลัง)]
        ↓
[ชำระเงินผ่าน Stripe ในแอป]
        ↓
[ให้คะแนน / จบการใช้งาน]
        ↓
      [End]
```

---

## 11. Deliverables Checklist (ตาม CS100 rubric)

- [ ] URL ของ Web Application ที่ deploy จริง (เช่น GitHub Pages / Apps Script Web App URL)
- [ ] URL ของ Google Sheets ฐานข้อมูล (ตั้งสิทธิ์ "ดูได้" สำหรับอาจารย์)
- [ ] ไฟล์ Presentation (PDF) — อัปเดต mockup ให้ตรงกับสไตล์ dribbble ที่เลือก และเปลี่ยน copy ทุกจุดจาก "คนพิการ" → "เจ้าของสิทธิ์"
- [ ] ไฟล์ Source Code / ลิงก์ repo — รวม `appscript/Code.gs`, frontend files, `.env.example`

---

## 12. คำสั่งสำหรับ AI Vibe Coding Tool (ใช้ต่อจากนี้ได้เลย)

```
สร้างเว็บแอป "Piakarn Parking Space" ตาม spec ในไฟล์นี้ทั้งหมด:
1. สร้างหน้า index.html + style.css + app.js เป็น single-page responsive web app
   ตามสไตล์ dark navy + ฟ้า, bottom-sheet card, ตามข้อ 5
2. เชื่อมต่อกับ Apps Script Web App ตาม endpoint ในข้อ 7 ด้วย fetch()
3. ใช้ Stripe Payment Element สำหรับหน้าชำระเงินตาม flow ข้อ 8
4. ใช้ Google Maps JS API แสดงแผนที่และคำนวณระยะเวลาเดินทาง
5. Role ฝั่งผู้ให้บริการคือ "เจ้าของสิทธิ์จอดรถ" (owner) ไม่ใช่ระบุกลุ่มบุคคลใด ๆ เป็นการเฉพาะ
6. อ่านค่า config (API URL, Stripe publishable key, Maps key) จาก .env ผ่าน build-time replace หรือ window config object
```
