// Happy CU room booking — backend on Google Apps Script + Google Sheets.
// Paste into Extensions > Apps Script of the booking spreadsheet, then deploy as a Web app.

const SHEET_NAME = 'Bookings';
const HEADERS = ['id', 'date', 'start', 'end', 'name', 'dept', 'contact', 'people', 'purpose', 'status', 'createdAt'];
const TIMES = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
const MAX_HOURS = 4;
const TZ = 'Asia/Bangkok';

function doGet(e) {
  const p = e.parameter || {};
  if (p.action === 'list') {
    const from = p.from || '0000-00-00';
    const to = p.to || '9999-99-99';
    const list = readAll_()
      .filter((b) => b.date >= from && b.date <= to)
      .map(publicView_);
    return json_({ ok: true, bookings: list });
  }
  return json_({ ok: false, error: 'unknown_action' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.action === 'create') return json_(create_(body.booking || {}));
    if (body.action === 'cancel') return json_(cancel_(String(body.id || ''), String(body.contact || '')));
    return json_({ ok: false, error: 'unknown_action' });
  } finally {
    lock.releaseLock();
  }
}

function create_(b) {
  const booking = {
    id: Utilities.getUuid().slice(0, 8),
    date: String(b.date || '').trim(),
    start: String(b.start || '').trim(),
    end: String(b.end || '').trim(),
    name: String(b.name || '').trim().slice(0, 80),
    dept: String(b.dept || '').trim().slice(0, 60),
    contact: String(b.contact || '').trim().slice(0, 80),
    people: String(b.people || '').trim().slice(0, 3),
    purpose: String(b.purpose || '').trim().slice(0, 200),
    status: 'active',
    createdAt: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"),
  };

  if (!booking.name || !booking.dept || !booking.contact || !booking.purpose) return { ok: false, error: 'missing_fields' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booking.date)) return { ok: false, error: 'bad_date' };

  const si = TIMES.indexOf(booking.start);
  const ei = TIMES.indexOf(booking.end);
  if (si < 0 || ei < 0 || ei <= si) return { ok: false, error: 'bad_time' };
  if (ei - si > MAX_HOURS) return { ok: false, error: 'too_long' };

  const now = new Date();
  const today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const nowHm = Utilities.formatDate(now, TZ, 'HH:mm');
  if (booking.date < today || (booking.date === today && booking.end <= nowHm)) return { ok: false, error: 'past' };

  const clash = readAll_().some((x) =>
    x.status === 'active' && x.date === booking.date && x.start < booking.end && booking.start < x.end);
  if (clash) return { ok: false, error: 'taken' };

  sheet_().appendRow(HEADERS.map((h) => booking[h]));
  return { ok: true, booking: publicView_(booking) };
}

function cancel_(id, contact) {
  const sh = sheet_();
  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    const row = rowToObj_(values[r]);
    if (row.id !== id) continue;
    if (row.status !== 'active') return { ok: false, error: 'already_cancelled' };
    if (row.contact.trim().toLowerCase() !== contact.trim().toLowerCase()) return { ok: false, error: 'wrong_contact' };
    sh.getRange(r + 1, HEADERS.indexOf('status') + 1).setValue('cancelled');
    return { ok: true };
  }
  return { ok: false, error: 'not_found' };
}

// works whether the script was opened from a spreadsheet or created on its own
function spreadsheet_() {
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if (bound) return bound;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('Happy Room Bookings');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function sheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange('A:K').setNumberFormat('@'); // keep dates/times as plain text
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_() {
  const values = sheet_().getDataRange().getValues();
  values.shift();
  return values.filter((r) => r[0]).map(rowToObj_);
}

function rowToObj_(r) {
  const o = {};
  HEADERS.forEach((h, i) => {
    let v = r[i];
    if (v instanceof Date) v = Utilities.formatDate(v, TZ, h === 'date' ? 'yyyy-MM-dd' : 'HH:mm');
    o[h] = String(v == null ? '' : v);
  });
  return o;
}

// contact stays private: never sent back to the browser
function publicView_(b) {
  return { id: b.id, date: b.date, start: b.start, end: b.end, name: b.name, dept: b.dept, people: b.people, purpose: b.purpose, status: b.status };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
