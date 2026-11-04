// Happy CU room booking — front end.
// Data goes to Google Sheets via Apps Script when API_URL is set, otherwise to localStorage.

const TIMES = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'];
const WEEKDAY = ['อา','จ','อ','พ','พฤ','ศ','ส'];
const WEEKDAY_FULL = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
const MONTH_SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const MONTH_FULL = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const MAX_HOURS = 4;
const DAYS_AHEAD = 7;
const BOOK_AHEAD_DAYS = 60;
const HISTORY_DAYS = 14;

const API_URL = ((window.HAPPY_CONFIG || {}).API_URL || '').trim();

const ERRORS = {
  missing_fields: 'ยังกรอกไม่ครบ ใส่ชื่อ แผนก เบอร์ติดต่อ และเรื่องที่ประชุมด้วยนะ',
  taken: 'ช่วงเวลานี้มีคนจองไปก่อนแล้ว ลองเลือกเวลาอื่นดูนะ',
  past: 'เลยเวลานี้ไปแล้ว เลือกช่วงเวลาที่ยังไม่ถึงนะ',
  too_long: 'จองได้ครั้งละไม่เกิน 4 ชั่วโมง',
  bad_time: 'ช่วงเวลาไม่ถูกต้อง ลองเลือกใหม่อีกครั้ง',
  bad_date: 'วันที่ไม่ถูกต้อง ลองเลือกใหม่อีกครั้ง',
  wrong_contact: 'เบอร์หรืออีเมลไม่ตรงกับตอนที่จอง',
  already_cancelled: 'การจองนี้ถูกยกเลิกไปแล้ว',
  not_found: 'ไม่เจอการจองนี้แล้ว ลองรีเฟรชหน้าดู',
  network: 'เชื่อมต่อระบบไม่ได้ เช็กอินเทอร์เน็ตแล้วลองใหม่',
};

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const nowHm = () => { const n = new Date(); return `${pad(n.getHours())}:${pad(n.getMinutes())}`; };
const dateObj = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const shortDate = (s) => { const d = dateObj(s); return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`; };
const fullDate = (s) => { const d = dateObj(s); return `วัน${WEEKDAY_FULL[d.getDay()]}ที่ ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`; };
const errText = (code) => ERRORS[code] || 'มีบางอย่างผิดพลาด ลองใหม่อีกครั้ง';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

// same rule as normContact_ in apps-script/Code.gs
function normContact(s) {
  let v = String(s).trim().toLowerCase().replace(/[\s\-().]/g, '');
  if (/^\+?\d+$/.test(v)) {
    v = v.replace(/^\+/, '');
    if (v.length === 11 && v.startsWith('66')) v = v.slice(2);
    v = v.replace(/^0+/, '');
  }
  return v;
}

// ---------- data layer ----------
function overlaps(a, b) { return a.date === b.date && a.start < b.end && b.start < a.end; }

const localApi = {
  KEY: 'happyroom.bookings',
  all() { return store.get(this.KEY, []); },
  async list(from, to) {
    return this.all().filter((b) => b.date >= from && b.date <= to).map(({ contact, ...pub }) => pub);
  },
  async create(b) {
    const all = this.all();
    if (all.some((x) => x.status === 'active' && overlaps(x, b))) return { ok: false, error: 'taken' };
    const booking = { ...b, id: Math.random().toString(36).slice(2, 10), status: 'active' };
    all.push(booking);
    store.set(this.KEY, all);
    const { contact, ...pub } = booking;
    return { ok: true, booking: pub };
  },
  async cancel(id, contact) {
    const all = this.all();
    const b = all.find((x) => x.id === id);
    if (!b) return { ok: false, error: 'not_found' };
    if (b.status !== 'active') return { ok: false, error: 'already_cancelled' };
    if (normContact(b.contact) !== normContact(contact)) return { ok: false, error: 'wrong_contact' };
    b.status = 'cancelled';
    store.set(this.KEY, all);
    return { ok: true };
  },
};

const sheetApi = {
  async list(from, to) {
    const res = await fetch(`${API_URL}?action=list&from=${from}&to=${to}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data.bookings;
  },
  async post(payload) {
    // text/plain avoids a CORS preflight, which Apps Script can't answer
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    return res.json();
  },
  create(b) { return this.post({ action: 'create', booking: b }); },
  cancel(id, contact) { return this.post({ action: 'cancel', id, contact }); },
};

const api = API_URL ? sheetApi : localApi;

// ---------- state ----------
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const DAYS = Array.from({ length: DAYS_AHEAD }, (_, i) => ymd(addDays(TODAY, i)));
const LAST_DAY = ymd(addDays(TODAY, BOOK_AHEAD_DAYS));

const state = {
  bookings: [],
  loaded: false,
  day: DAYS[0],
  picked: [],
  confirmId: null,
  confirmManual: false,
  calOpen: false,
  calMonth: new Date(TODAY.getFullYear(), TODAY.getMonth(), 1),
  mineQuery: null,
  saving: false,
};

const mine = new Set(store.get('happyroom.mine', []));
const profile = store.get('happyroom.profile', { name: '', dept: '', contact: '' });

const contacts = store.get('happyroom.contacts', {});

function rememberMine(id, contact) {
  mine.add(id);
  store.set('happyroom.mine', [...mine]);
  contacts[id] = contact;
  store.set('happyroom.contacts', contacts);
}

async function load() {
  try {
    state.bookings = await api.list(ymd(addDays(TODAY, -HISTORY_DAYS)), LAST_DAY);
    state.loaded = true;
  } catch {
    toast(errText('network'));
  }
  renderAll();
}

// ---------- derived ----------
function slotsFor(date) {
  return TIMES.slice(0, -1).map((start, i) => {
    const end = TIMES[i + 1];
    const booking = state.bookings.find((b) => b.status === 'active' && b.date === date && b.start <= start && start < b.end) || null;
    const past = date === DAYS[0] && end <= nowHm();
    return { index: i, start, end, booking, past };
  });
}
const freeCount = (date) => slotsFor(date).filter((s) => !s.booking && !s.past).length;

// ---------- now card ----------
const ICON = {
  check: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/></svg>',
  calendar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  moon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>',
};

function renderNow() {
  const dot = $('nowDot');
  if (!state.loaded) {
    dot.dataset.state = 'closed';
    dot.innerHTML = '';
    $('nowTitle').textContent = 'กำลังโหลด…';
    $('nowSub').textContent = 'กำลังดูตารางห้องประชุม';
    return;
  }
  const now = nowHm();
  if (now < '08:00' || now >= '17:00') {
    dot.dataset.state = 'closed';
    dot.innerHTML = ICON.moon;
    $('nowTitle').textContent = 'นอกเวลาจอง';
    $('nowSub').textContent = 'ห้องเปิดให้ใช้ 08:00–17:00 น. จองล่วงหน้าได้เลย';
    return;
  }
  const slots = slotsFor(DAYS[0]);
  const i = TIMES.findIndex((t, k) => t <= now && now < TIMES[k + 1]);
  const slot = slots[i];
  let j = i;
  if (!slot.booking) {
    while (j < slots.length && !slots[j].booking) j++;
    dot.dataset.state = 'free';
    dot.innerHTML = ICON.check;
    $('nowTitle').textContent = 'ตอนนี้ห้องว่าง';
    $('nowSub').textContent = j === slots.length ? 'ว่างยาวจนเลิกงาน' : `ว่างยาวถึง ${TIMES[j]} น.`;
  } else {
    while (j < slots.length && slots[j].booking) j++;
    dot.dataset.state = 'busy';
    dot.innerHTML = ICON.cross;
    $('nowTitle').textContent = `แผนก ${slot.booking.dept} ใช้ห้องอยู่`;
    $('nowSub').textContent = j === slots.length ? 'ใช้ยาวจนเลิกงาน' : `ว่างอีกทีตอน ${TIMES[j]} น.`;
  }
}

// ---------- days ----------
function renderDays() {
  const el = $('days');
  el.innerHTML = '';
  DAYS.forEach((date, idx) => {
    const d = dateObj(date);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day' + (date === state.day ? ' is-active' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', date === state.day);
    const free = state.loaded ? freeCount(date) : null;
    const label = free === null ? '…' : free ? `ว่าง ${free}` : 'เต็ม';
    b.innerHTML = `${idx === 0 ? 'วันนี้' : WEEKDAY[d.getDay()]}<b>${d.getDate()}</b><small>${label}</small>`;
    b.addEventListener('click', () => { state.day = date; state.picked = []; state.calOpen = false; renderBook(); });
    el.appendChild(b);
  });

  // a date picked from the calendar that isn't in the 7-day strip shows up on this button
  const far = !DAYS.includes(state.day);
  const cal = $('calBtn');
  cal.className = 'cal-btn' + (far ? ' is-active' : '') + (state.calOpen ? ' is-open' : '');
  cal.setAttribute('aria-expanded', state.calOpen);
  cal.innerHTML = `${ICON.calendar}<span>${far ? shortDate(state.day) : 'ดูปฏิทิน'}</span>`;
}

function toggleCalendar() {
  state.calOpen = !state.calOpen;
  if (state.calOpen) { const d = dateObj(state.day); state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); }
  renderDays();
  renderCalendar();
}

// ---------- month calendar ----------
function renderCalendar() {
  const el = $('calendar');
  el.hidden = !state.calOpen;
  if (!state.calOpen) return;

  const m = state.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const canPrev = first > TODAY;
  const canNext = ymd(new Date(m.getFullYear(), m.getMonth() + 1, 1)) <= LAST_DAY;

  el.innerHTML = `
    <div class="cal-head">
      <button type="button" class="cal-nav" data-dir="-1" aria-label="เดือนก่อน" ${canPrev ? '' : 'disabled'}>‹</button>
      <p class="cal-title">${MONTH_FULL[m.getMonth()]} ${m.getFullYear() + 543}</p>
      <button type="button" class="cal-nav" data-dir="1" aria-label="เดือนถัดไป" ${canNext ? '' : 'disabled'}>›</button>
    </div>
    <div class="cal-grid">${WEEKDAY.map((w) => `<span class="cal-wd">${w}</span>`).join('')}</div>`;

  const grid = el.querySelector('.cal-grid');
  for (let i = 0; i < first.getDay(); i++) grid.appendChild(document.createElement('span'));
  for (let n = 1; n <= daysInMonth; n++) {
    const date = ymd(new Date(m.getFullYear(), m.getMonth(), n));
    const b = document.createElement('button');
    b.type = 'button';
    const out = date < DAYS[0] || date > LAST_DAY;
    const free = out || !state.loaded ? null : freeCount(date);
    let cls = 'cal-day';
    if (date === state.day) cls += ' is-active';
    if (date === DAYS[0]) cls += ' is-today';
    if (free === 0) cls += ' is-full';
    b.className = cls;
    b.disabled = out;
    b.setAttribute('aria-label', `${fullDate(date)}${free === null ? '' : free ? ` ว่าง ${free} ช่วง` : ' เต็มแล้ว'}`);
    b.innerHTML = `${n}${free !== null && free < TIMES.length - 1 ? `<i class="${free ? 'dot-some' : 'dot-full'}"></i>` : ''}`;
    if (!out) b.addEventListener('click', () => {
      state.day = date;
      state.picked = [];
      state.calOpen = false;
      renderBook();
      $('slotsHeading').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    grid.appendChild(b);
  }

  el.querySelectorAll('.cal-nav').forEach((btn) => btn.addEventListener('click', () => {
    state.calMonth = new Date(m.getFullYear(), m.getMonth() + Number(btn.dataset.dir), 1);
    renderCalendar();
  }));

  el.insertAdjacentHTML('beforeend', `
    <div class="cal-legend">
      <span><i class="dot-some"></i>มีคนจองบางช่วง</span>
      <span><i class="dot-full"></i>เต็มทั้งวัน</span>
    </div>`);
}

// ---------- slots ----------
function pickSlot(i) {
  const p = state.picked;
  const min = Math.min(...p), max = Math.max(...p);
  if (!p.length) state.picked = [i];
  else if (p.includes(i)) state.picked = (i === min || i === max) ? p.filter((x) => x !== i) : [i];
  else if ((i === max + 1 || i === min - 1) && p.length < MAX_HOURS) state.picked = [...p, i];
  else state.picked = [i];
  renderSlots();
  renderCta();
}

function renderSlots() {
  $('slotsHeading').textContent = state.day === DAYS[0] ? 'เลือกช่วงเวลาวันนี้' : `เลือกช่วงเวลา ${shortDate(state.day)}`;
  const el = $('slots');
  el.innerHTML = '';
  slotsFor(state.day).forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    const picked = state.picked.includes(s.index);
    let cls = 'slot', sub = 'ว่าง';
    if (!state.loaded) { cls += ' is-past'; sub = '…'; b.disabled = true; }
    else if (s.booking && mine.has(s.booking.id)) { cls += ' is-mine'; sub = 'คุณจองแล้ว'; b.disabled = true; }
    else if (s.booking) { cls += ' is-busy'; sub = s.booking.dept; b.disabled = true; }
    else if (s.past) { cls += ' is-past'; sub = 'เลยเวลาแล้ว'; b.disabled = true; }
    else if (picked) { cls += ' is-picked'; sub = 'เลือกแล้ว'; }
    b.className = cls;
    b.setAttribute('aria-pressed', picked);
    b.innerHTML = `${s.start}<small>${escapeHtml(sub)}</small>`;
    if (!b.disabled) b.addEventListener('click', () => pickSlot(s.index));
    el.appendChild(b);
  });
}

function pickedRange() {
  const p = [...state.picked].sort((a, b) => a - b);
  return { start: TIMES[p[0]], end: TIMES[p[p.length - 1] + 1], hours: p.length };
}

function renderCta() {
  const onBook = !$('view-book').hidden;
  if (!state.picked.length || !onBook) { $('ctaBar').hidden = true; return; }
  const r = pickedRange();
  $('ctaBtn').textContent = `จอง ${r.start}–${r.end} (${r.hours} ชม.)`;
  $('ctaBar').hidden = false;
}

function renderBook() { renderNow(); renderDays(); renderCalendar(); renderSlots(); renderCta(); }

// ---------- booking sheet ----------
function openSheet() {
  const r = pickedRange();
  const f = $('bookForm');
  $('sheetSummary').textContent = `${fullDate(state.day)} · ${r.start}–${r.end} น. (${r.hours} ชม.)`;
  f.reset();
  f.name.value = profile.name;
  f.dept.value = profile.dept;
  f.contact.value = profile.contact;
  $('formError').hidden = true;
  f.hidden = false;
  $('doneView').hidden = true;
  $('sheet').hidden = false;
  $('sheetBackdrop').hidden = false;
  (profile.name ? f.purpose : f.name).focus();
}

function closeSheet() { $('sheet').hidden = true; $('sheetBackdrop').hidden = true; }

async function submitBooking(e) {
  e.preventDefault();
  if (state.saving) return;
  const f = e.target;
  const data = Object.fromEntries(new FormData(f).entries());
  if (['name', 'dept', 'contact', 'purpose'].some((k) => !data[k].trim())) return showFormError('missing_fields');

  const r = pickedRange();
  const booking = {
    date: state.day, start: r.start, end: r.end,
    name: data.name.trim(), dept: data.dept.trim(), contact: data.contact.trim(),
    people: data.people.trim(), purpose: data.purpose.trim(),
  };

  setSaving(true);
  let res;
  try { res = await api.create(booking); } catch { res = { ok: false, error: 'network' }; }
  setSaving(false);

  if (!res.ok) {
    showFormError(res.error);
    if (res.error === 'taken') { state.picked = []; await load(); }
    return;
  }

  Object.assign(profile, { name: booking.name, dept: booking.dept, contact: booking.contact });
  store.set('happyroom.profile', profile);
  rememberMine(res.booking.id, booking.contact);
  state.bookings.push(res.booking);
  state.picked = [];

  $('doneCard').innerHTML = `
    <b>${fullDate(booking.date)}</b><br>
    เวลา ${booking.start}–${booking.end} น.<br>
    ${escapeHtml(booking.name)} · แผนก ${escapeHtml(booking.dept)}${booking.people ? ` · ${escapeHtml(booking.people)} คน` : ''}<br>
    เรื่อง: ${escapeHtml(booking.purpose)}`;
  f.hidden = true;
  $('doneView').hidden = false;
  renderAll();
}

function showFormError(code) { $('formError').textContent = errText(code); $('formError').hidden = false; }

function setSaving(on) {
  state.saving = on;
  const btn = $('submitBtn');
  btn.disabled = on;
  btn.textContent = on ? 'กำลังจอง…' : 'ยืนยันการจอง';
}

// ---------- mine ----------
function itemHtml(b, metaText) {
  const d = dateObj(b.date);
  return `
    <div class="item-date">${WEEKDAY[d.getDay()]}<b>${d.getDate()}</b></div>
    <div class="item-main">
      <div class="item-time">${b.start}–${b.end} น.</div>
      <div class="item-meta">${metaText}</div>
    </div>`;
}

function renderMine() {
  const el = $('mineList');
  el.innerHTML = '';
  if (state.mineQuery === null) { el.innerHTML = '<p class="empty">ใส่ชื่อของคุณ แล้วกด "ดูการจอง"</p>'; return; }
  const q = state.mineQuery.trim().toLowerCase();
  const list = state.bookings
    .filter((b) => b.date >= DAYS[0] && (!q || b.name.toLowerCase().includes(q)))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if (!list.length) { el.innerHTML = '<p class="empty">ยังไม่มีการจองที่จะถึงของชื่อนี้</p>'; return; }

  list.forEach((b) => {
    const row = document.createElement('div');
    const cancelled = b.status !== 'active';
    row.className = 'item' + (cancelled ? ' is-cancelled' : '');
    row.innerHTML = itemHtml(b, `${escapeHtml(b.name)} · ${escapeHtml(b.purpose)}`);

    if (cancelled) {
      row.insertAdjacentHTML('beforeend', '<span class="pill pill-off">ยกเลิกแล้ว</span>');
    } else if (state.confirmId === b.id) {
      row.classList.add('is-confirming');
      row.appendChild(buildCancelConfirm(b));
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-cancel';
      btn.textContent = 'ยกเลิก';
      btn.addEventListener('click', () => { state.confirmId = b.id; state.confirmManual = false; renderMine(); });
      row.appendChild(btn);
    }
    el.appendChild(row);
  });
}

function buildCancelConfirm(b) {
  const saved = contacts[b.id] || (mine.has(b.id) ? profile.contact : '');
  const knowsContact = Boolean(saved) && !state.confirmManual;
  const box = document.createElement('form');
  box.className = 'confirm';
  box.innerHTML = `
    ${knowsContact ? '<p class="confirm-q">ยกเลิกการจองนี้ใช่ไหม?</p>' : `
      <label class="field confirm-field">
        <span>ใส่เบอร์หรืออีเมลที่ใช้ตอนจอง</span>
        <input type="text" name="contact" autocomplete="off">
      </label>`}
    <p class="form-error" hidden></p>
    <div class="confirm-actions">
      <button type="button" class="btn btn-light" data-no>ไม่ยกเลิก</button>
      <button type="submit" class="btn btn-danger">ยกเลิกการจอง</button>
    </div>`;
  box.querySelector('[data-no]').addEventListener('click', () => { state.confirmId = null; renderMine(); });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const contact = knowsContact ? saved : box.contact.value;
    const err = box.querySelector('.form-error');
    if (!contact.trim()) { err.textContent = 'ใส่เบอร์หรืออีเมลก่อนนะ'; err.hidden = false; return; }
    const submit = box.querySelector('[type=submit]');
    submit.disabled = true;
    submit.textContent = 'กำลังยกเลิก…';
    let res;
    try { res = await api.cancel(b.id, contact); } catch { res = { ok: false, error: 'network' }; }
    if (!res.ok && res.error === 'wrong_contact' && knowsContact) {
      // the remembered contact didn't match; let the person type it instead of getting stuck
      state.confirmManual = true;
      renderMine();
      const e2 = document.querySelector('.confirm .form-error');
      e2.textContent = 'เบอร์ที่จำไว้ในเครื่องนี้ไม่ตรง ลองพิมพ์เบอร์หรืออีเมลที่ใช้ตอนจองอีกครั้ง';
      e2.hidden = false;
      return;
    }
    if (!res.ok) {
      err.textContent = errText(res.error);
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = 'ยกเลิกการจอง';
      return;
    }
    b.status = 'cancelled';
    state.confirmId = null;
    toast('ยกเลิกการจองแล้ว');
    renderAll();
  });
  setTimeout(() => { const i = box.querySelector('input'); if (i) i.focus(); });
  return box;
}

// ---------- history ----------
function renderHistory() {
  const el = $('historyList');
  el.innerHTML = '';
  if (!state.loaded) { el.innerHTML = '<p class="empty">กำลังโหลด…</p>'; return; }
  const list = [...state.bookings].sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
  if (!list.length) { el.innerHTML = '<p class="empty">ยังไม่มีใครจองห้องในช่วงนี้</p>'; return; }
  list.forEach((b) => {
    const row = document.createElement('div');
    const cancelled = b.status !== 'active';
    row.className = 'item' + (cancelled ? ' is-cancelled' : '');
    row.innerHTML = itemHtml(b, `แผนก ${escapeHtml(b.dept)} · ${escapeHtml(b.purpose)}`) +
      `<span class="pill ${cancelled ? 'pill-off' : 'pill-ok'}">${cancelled ? 'ยกเลิก' : 'จองแล้ว'}</span>`;
    el.appendChild(row);
  });
}

// ---------- misc ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function renderAll() { renderBook(); renderMine(); renderHistory(); }

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + tab.dataset.view; });
      renderCta();
    });
  });
}

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'อรุณสวัสดิ์' : h < 17 ? 'สวัสดีตอนบ่าย' : 'สวัสดีตอนเย็น';
  $('hello').textContent = `${part} · ${fullDate(DAYS[0])}`;
}

document.addEventListener('DOMContentLoaded', () => {
  greeting();
  setupTabs();
  $('modeNote').hidden = Boolean(API_URL);
  if (profile.name) { $('mineName').value = profile.name; state.mineQuery = profile.name; }

  $('ctaBtn').addEventListener('click', openSheet);
  $('calBtn').addEventListener('click', toggleCalendar);
  $('bookForm').addEventListener('submit', submitBooking);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  $('sheetBackdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  $('mineForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.mineQuery = $('mineName').value;
    state.confirmId = null;
    renderMine();
  });

  renderAll();
  load();
  // pick up other people's bookings; skip while someone is mid-booking
  setInterval(() => { if ($('sheet').hidden && state.confirmId === null) load(); }, 60000);
});
