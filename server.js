/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  LuxStay Server v2.0                                  ║
 * ║  RealtyCalendar интеграция через iCal + Webhook        ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * КАК ПОДКЛЮЧИТЬ RealtyCalendar:
 * ─────────────────────────────
 * 1. ЭКСПОРТ из RC → ваш сервер (RC → занятые даты → сайт):
 *    RC: Менеджер каналов → иконка объекта → iCalendar → скопировать ссылку "Экспорт"
 *    Вставить в admin-панели сайта (или PATCH /api/admin/apartments/:id)
 *    поле: rcIcalExportUrl
 *
 * 2. ИМПОРТ в RC ← ваш сервер (сайт → брони → RC):
 *    RC: Менеджер каналов → иконка объекта → iCalendar → поле "Импорт"
 *    Вставить URL: https://ВАШ_ДОМЕН/api/ical/apt-1
 *    (для каждой из 12 квартир свой apt-1..apt-12)
 *
 * 3. WEBHOOK (мгновенные уведомления, опционально):
 *    RC: Настройки → Интеграция → Webhook → URL: https://ВАШ_ДОМЕН/api/webhook/rc
 *    При новой брони в RC → сервер немедленно обновит кэш занятых дат
 *
 * ИТОГ: двусторонняя синхронизация без двойных броней.
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const ical    = require('ical');
const cron    = require('node-cron');
const { v4: uuid } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════
// БД  (JSON-файл, легко заменить на PostgreSQL)
// ══════════════════════════════
const DB_FILE = path.join(__dirname, 'data', 'db.json');

function dbRead() {
  if (!fs.existsSync(DB_FILE)) {
    const init = { apartments: buildEmptyApartments(), bookings: [], icalCache: {} };
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { apartments: buildEmptyApartments(), bookings: [], icalCache: {} }; }
}

function dbWrite(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ══════════════════════════════
// ШАБЛОН 12 КВАРТИР
// Заполните через admin-панель или напрямую в data/db.json
// ══════════════════════════════
function buildEmptyApartments() {
  return Array.from({ length: 12 }, (_, i) => ({
    id: `apt-${i + 1}`,
    // ── ОСНОВНОЕ (заполнить) ──
    title:       '',
    city:        '',
    address:     '',
    description: '',
    shortDesc:   '',
    price:       0,
    // ── ПАРАМЕТРЫ ──
    guests: 2,
    rooms:  1,
    area:   40,
    floor:  null,
    // ── ОЦЕНКА ──
    rating:  0,
    reviews: 0,
    // ── ФЛАГИ ──
    instant: false,
    active:  false,   // false = черновик, не показывается на сайте
    // ── КАТЕГОРИИ (добавить свои теги) ──
    tags: [],         // пример: ['penthouse','studio','loft','kazan','istanbul']
    // ── УДОБСТВА ──
    amenities: [],    // пример: ['WiFi','Кондиционер','Парковка','Бассейн']
    // ── ФОТО (URLs) ──
    photos: [],       // первое фото — обложка
    // ── RC iCal ──
    rcIcalExportUrl: '',  // ← RC → Менеджер каналов → iCal → Экспорт
    rcIcalImportUrl: '',  // для справки (то что вы вставили в RC)
  }));
}

// ══════════════════════════════
// iCAL СИНХРОНИЗАЦИЯ С RC
// ══════════════════════════════
async function fetchIcal(url) {
  if (!url) return [];
  try {
    const res  = await fetch(url, { timeout: 12000 });
    const text = await res.text();
    const data = ical.parseICS(text);
    const out  = [];
    for (const k in data) {
      const e = data[k];
      if (e.type === 'VEVENT' && e.start && e.end) {
        out.push({ start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(), summary: e.summary || 'Занято' });
      }
    }
    return out;
  } catch (err) {
    console.warn(`[iCal] Ошибка ${url.slice(0,50)}: ${err.message}`);
    return [];
  }
}

async function syncAllCalendars() {
  const db = dbRead();
  let updated = 0;
  for (const apt of db.apartments) {
    if (!apt.rcIcalExportUrl) continue;
    const occupied = await fetchIcal(apt.rcIcalExportUrl);
    db.icalCache[apt.id] = { updatedAt: new Date().toISOString(), occupied };
    updated++;
  }
  dbWrite(db);
  if (updated) console.log(`[Sync] ${new Date().toLocaleTimeString()} — обновлено ${updated} календарей`);
}

// Синхронизация каждые 15 минут
cron.schedule('*/15 * * * *', syncAllCalendars);

// ══════════════════════════════
// ГЕНЕРАЦИЯ iCAL ДЛЯ RC
// RC должен импортировать: GET /api/ical/:id
// ══════════════════════════════
function makeIcal(aptId) {
  const db       = dbRead();
  const bookings = db.bookings.filter(b => b.apartmentId === aptId && b.status !== 'cancelled');
  const lines    = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//LuxStay//RU','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  for (const b of bookings) {
    const s = new Date(b.checkIn).toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';
    const e = new Date(b.checkOut).toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';
    lines.push('BEGIN:VEVENT', `UID:${b.id}@luxstay`, `DTSTART:${s}`, `DTEND:${e}`,
               `SUMMARY:LuxStay - ${b.guestName}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ══════════════════════════════
// ДОСТУПНОСТЬ
// ══════════════════════════════
function isAvailable(aptId, checkIn, checkOut) {
  const db  = dbRead();
  const cIn  = new Date(checkIn);
  const cOut = new Date(checkOut);

  // 1. Проверяем наши брони
  const conflict = db.bookings.find(b => {
    if (b.apartmentId !== aptId || b.status === 'cancelled') return false;
    return cIn < new Date(b.checkOut) && cOut > new Date(b.checkIn);
  });
  if (conflict) return false;

  // 2. Проверяем RC кэш
  const cache = db.icalCache[aptId];
  if (cache?.occupied) {
    const rcConflict = cache.occupied.find(o => cIn < new Date(o.end) && cOut > new Date(o.start));
    if (rcConflict) return false;
  }
  return true;
}

function getOccupied(aptId) {
  const db     = dbRead();
  const ranges = [];
  db.bookings.filter(b => b.apartmentId === aptId && b.status !== 'cancelled')
    .forEach(b => ranges.push({ start: b.checkIn, end: b.checkOut, source: 'site' }));
  const cache = db.icalCache[aptId];
  if (cache?.occupied) cache.occupied.forEach(o => ranges.push({ start: o.start, end: o.end, source: 'rc' }));
  return ranges;
}

// ══════════════════════════════
// PUBLIC API
// ══════════════════════════════

// Все активные квартиры
app.get('/api/apartments', (req, res) => {
  const db = dbRead();
  const { checkIn, checkOut, guests, tag } = req.query;
  let list = db.apartments
    .filter(a => a.active && a.title)
    .map(a => {
      const { rcIcalExportUrl, rcIcalImportUrl, ...pub } = a;
      let available = true;
      if (checkIn && checkOut) available = isAvailable(a.id, checkIn, checkOut);
      return { ...pub, available, occupiedRanges: getOccupied(a.id) };
    });

  if (guests)              list = list.filter(a => a.guests >= +guests);
  if (tag && tag !== 'all') list = list.filter(a => a.tags?.includes(tag));
  if (checkIn && checkOut) list = list.filter(a => a.available);
  res.json(list);
});

// Одна квартира
app.get('/api/apartments/:id', (req, res) => {
  const db  = dbRead();
  const apt = db.apartments.find(a => a.id === req.params.id);
  if (!apt) return res.status(404).json({ error: 'Not found' });
  const { rcIcalExportUrl, rcIcalImportUrl, ...pub } = apt;
  res.json({ ...pub, occupiedRanges: getOccupied(apt.id) });
});

// Проверка доступности
app.get('/api/apartments/:id/check', (req, res) => {
  const { checkIn, checkOut } = req.query;
  if (!checkIn || !checkOut) return res.status(400).json({ error: 'Нужны checkIn и checkOut' });
  res.json({ available: isAvailable(req.params.id, checkIn, checkOut) });
});

// iCal для RC (RC импортирует этот URL)
app.get('/api/ical/:id', (req, res) => {
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.send(makeIcal(req.params.id));
});

// Создать бронирование
app.post('/api/bookings', (req, res) => {
  const { apartmentId, checkIn, checkOut, guests, guestName, guestPhone, guestEmail, comment } = req.body;
  if (!apartmentId || !checkIn || !checkOut || !guestName || !guestPhone)
    return res.status(400).json({ error: 'Заполните обязательные поля' });

  if (!isAvailable(apartmentId, checkIn, checkOut))
    return res.status(409).json({ error: 'Квартира занята на выбранные даты' });

  const db  = dbRead();
  const apt = db.apartments.find(a => a.id === apartmentId);
  if (!apt) return res.status(404).json({ error: 'Квартира не найдена' });

  const nights  = Math.ceil((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const booking = {
    id: uuid(), apartmentId, apartmentTitle: apt.title,
    checkIn, checkOut, nights, guests: +guests || 1,
    guestName, guestPhone, guestEmail: guestEmail || '',
    comment: comment || '',
    totalPrice: apt.price * nights,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    source: 'site'
  };
  db.bookings.push(booking);
  dbWrite(db);

  console.log(`[Бронь] ${booking.id.slice(0,8)} | ${apt.title} | ${checkIn}→${checkOut} | ${guestName}`);

  // RC подхватит бронь автоматически через /api/ical/:id при следующем импорте
  res.status(201).json({ success: true, booking: {
    id: booking.id, apartmentTitle: booking.apartmentTitle,
    checkIn, checkOut, nights, totalPrice: booking.totalPrice, status: 'confirmed'
  }});
});

// Webhook от RC — мгновенное обновление при брони в RC
app.post('/api/webhook/rc', (req, res) => {
  console.log('[RC Webhook]', new Date().toLocaleTimeString(), JSON.stringify(req.body).slice(0, 200));
  syncAllCalendars(); // немедленно обновляем кэш
  res.json({ ok: true });
});

// Принудительная синхронизация
app.post('/api/sync', async (req, res) => {
  await syncAllCalendars();
  res.json({ ok: true, at: new Date().toISOString() });
});

// ══════════════════════════════
// ADMIN API (защитите Basic Auth / IP whitelist на проде)
// ══════════════════════════════

// Получить все квартиры (включая черновики)
app.get('/api/admin/apartments', (req, res) => {
  res.json(dbRead().apartments);
});

// Обновить квартиру (заполнение данных + rcIcalExportUrl)
app.patch('/api/admin/apartments/:id', (req, res) => {
  const db  = dbRead();
  const idx = db.apartments.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.apartments[idx] = { ...db.apartments[idx], ...req.body };
  dbWrite(db);
  res.json({ ok: true, apartment: db.apartments[idx] });
});

// Все брони
app.get('/api/admin/bookings', (req, res) => {
  const db = dbRead();
  res.json(db.bookings.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Отменить бронь
app.patch('/api/admin/bookings/:id/cancel', (req, res) => {
  const db  = dbRead();
  const idx = db.bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.bookings[idx].status = 'cancelled';
  dbWrite(db);
  res.json({ ok: true });
});

// Статус синхронизации
app.get('/api/admin/sync-status', (req, res) => {
  const db = dbRead();
  const status = db.apartments.map(a => ({
    id: a.id, title: a.title || '(пусто)', active: a.active,
    hasIcal: !!a.rcIcalExportUrl,
    lastSync: db.icalCache[a.id]?.updatedAt || null,
    occupiedCount: db.icalCache[a.id]?.occupied?.length || 0,
  }));
  res.json(status);
});

// ══════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  🏠 LuxStay  →  http://localhost:${PORT}  ║`);
  console.log(`║  🔧 Admin    →  /admin                ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  await syncAllCalendars();
});
