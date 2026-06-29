/**
 * ============================================================================
 *  CHURCH CAMP CHECK-IN SYSTEM  —  Google Apps Script backend
 *  3 Days 2 Nights · ~280 attendees · 12 checkpoints · QR + manual check-in
 * ============================================================================
 *  HOW TO INSTALL: see "00_START_HERE_Setup_Guide.md".
 *  Quick version:
 *    1. Open a NEW Google Sheet.
 *    2. Extensions > Apps Script. Delete the sample, paste THIS file.
 *    3. Add an HTML file named exactly "Index" and paste Index.html into it.
 *    4. Run setupSheet() once (authorise when asked).
 *    5. Deploy > New deployment > Web app > Execute as ME, Access: Anyone with link.
 *    6. Send the web-app URL to the organiser team. Done.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// CONFIG — edit here if you want to rename things
// ----------------------------------------------------------------------------
const SHEET = { ATTENDEES: 'Attendees', LOG: 'ScanLog', ROOMS: 'Rooms', DASH: 'Dashboard', SCHED: 'Schedule' };

const DEFAULT_PASSCODE = 'camp2026';   // change after setup via the Camp menu

// Single source of truth for the checkpoints. Order = display order.
// type:  simple   = just record time
//        room     = record time + show the person's hotel room / key
//        hall     = free-choice seminar, asks which Hall, handles switches
//        checkout = record time = "room key returned"
//  day/start/end = the scheduled time window (24h). Shown to organisers in 12h,
//  and (if ENFORCE_WINDOWS) used to block scans outside the window.
const CHECKPOINTS = [
  { key: 'bus_to',   label: '1. 教会乘车报到 Church Bus',       type: 'simple',   day: 1, start: '08:30', end: '09:30' },
  { key: 'checkin',  label: '2. 会场报到·领房卡 Venue Check-in', type: 'room',     day: 1, start: '15:00', end: '18:30' },
  { key: 'theme1',   label: '3. 主题信息1 Theme Msg 1',         type: 'simple',   day: 1, start: '20:00', end: '22:15' },
  { key: 'worship2', label: '4. 敬拜 Day2 Worship',             type: 'simple',   day: 2, start: '09:30', end: '09:50' },
  { key: 'seminar',  label: '5. 专题讲座 Seminar',              type: 'hall',     day: 2, start: '09:50', end: '11:45' },
  { key: 'biggame',  label: '6. 大型游戏 Big Game',             type: 'simple',   day: 2, start: '13:30', end: '15:30' },
  { key: 'bbq',      label: '7. BBQ Dinner',                    type: 'simple',   day: 2, start: '18:30', end: '20:00' },
  { key: 'devo1',    label: '8. 灵修1 Devotion 1',              type: 'simple',   day: 2, start: '06:30', end: '09:20' },
  { key: 'devo2',    label: '9. 灵修2 Devotion 2',              type: 'simple',   day: 3, start: '06:30', end: '08:50' },
  { key: 'theme2',   label: '10. 主题信息2 Theme Msg 2',        type: 'simple',   day: 3, start: '09:10', end: '10:50' },
  { key: 'checkout', label: '11. 退房·还房卡 Check-out',        type: 'checkout', day: 3, start: '11:15', end: '12:15' },
  { key: 'bus_back', label: '12. 返程乘车报到 Return Bus',      type: 'simple',   day: 3, start: '12:15', end: '13:00' },
];

const HALLS = ['Jade Main Hall', 'Sapphire 1', 'Sapphire 2'];

// Camp dates per day + optional time-window enforcement.
const CAMP_DATES = { 1: '2026-08-29', 2: '2026-08-30', 3: '2026-08-31' };
const ENFORCE_WINDOWS = false;   // ⬅ set TRUE on camp day to block scans outside a checkpoint's time
const WINDOW_GRACE_MIN = 30;     // allow scanning from this many minutes BEFORE the start time

// Fixed profile columns at the start of the Attendees sheet (in order).
//   RoomGroup = planned room (e.g. "R01" / a family name). Fill BEFORE camp.
//   Room      = actual room number. Left blank; auto-stamped at check-in from the
//               Rooms tab (you type the real number there at 3pm, once per room).
const PROFILE_COLS = ['ID','Token','Name','Phone','Role','Group','BusTo','BusBack','RoomGroup','Room','RoomNote','Notes'];
const HALL_COL = 'SeminarHall';   // extra column that stores which hall they attended

// ----------------------------------------------------------------------------
// WEB APP ENTRY POINTS
// ----------------------------------------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Camp Check-in 报到系统')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

/** Public config for the UI (no passcode needed — just labels + scheduled times). */
function getConfig() {
  const ss = SpreadsheetApp.getActive();
  const sched = getSchedule_(ss);
  return {
    checkpoints: CHECKPOINTS.map(c => {
      const e = sched.map[c.key] || {};
      const sMin = (e.start != null) ? e.start : hhmmToMin_(c.start);
      const eMin = (e.end != null) ? e.end : hhmmToMin_(c.end);
      return { key: c.key, label: c.label, type: c.type,
               when: 'D' + c.day + ' ' + to12h_(minToHHmm_(sMin)) + '–' + to12h_(minToHHmm_(eMin)) };
    }),
    halls: HALLS,
    enforce: sched.enforce
  };
}

// --- time helpers ---
function to12h_(hhmm) {
  const p = String(hhmm).split(':'); let h = +p[0]; const m = p[1];
  const ap = h < 12 ? 'am' : 'pm'; h = h % 12; if (h === 0) h = 12;
  return h + ':' + m + ap;
}
function hhmmToMin_(hhmm) { const p = String(hhmm).split(':'); return (+p[0]) * 60 + (+p[1]); }
function minToHHmm_(min) { const h = Math.floor(min / 60), m = min % 60; return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2); }
function defaultLead_(cp) { return (cp.key === 'bus_to' || cp.key === 'bus_back') ? 60 : WINDOW_GRACE_MIN; }
/** Accepts "20:00", "8:00pm", "8pm", "8:30 PM", or a time/Date cell -> minutes since midnight. */
function parseTime_(v) {
  if (v === '' || v == null) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getHours() * 60 + v.getMinutes();
  let s = String(v).trim().toLowerCase().replace(/\s+/g, '');
  let ap = s.indexOf('pm') > -1 ? 'pm' : (s.indexOf('am') > -1 ? 'am' : null);
  s = s.replace('am', '').replace('pm', '');
  const p = s.split(':'); let h = parseInt(p[0], 10), m = p.length > 1 ? parseInt(p[1], 10) : 0;
  if (isNaN(h)) return null; if (isNaN(m)) m = 0;
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  return h * 60 + m;
}
function dateStr_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return String(v || '').trim();
}
/** Read the editable Schedule tab. Returns {map:{key:{date,start,end,lead}}, enforce}. */
function getSchedule_(ss) {
  const out = { map: {}, enforce: ENFORCE_WINDOWS };
  const sh = ss.getSheetByName(SHEET.SCHED);
  if (!sh) return out;
  const tz = ss.getSpreadsheetTimeZone();
  const d = sh.getDataRange().getValues();
  for (let r = 0; r < d.length; r++) {
    const a = String(d[r][0] || '').trim();
    if (/^enforce/i.test(a)) { out.enforce = isYes_(d[r][1]); continue; }
    if (!a || a.toLowerCase() === 'key') continue;
    out.map[a] = { date: dateStr_(d[r][2], tz), start: parseTime_(d[r][3]), end: parseTime_(d[r][4]), lead: Number(d[r][5]) || 0 };
  }
  return out;
}
/** Is "now" inside a checkpoint's scan window? Uses Schedule tab, falls back to code. */
function windowCheck_(ss, cp, sched) {
  const tz = ss.getSpreadsheetTimeZone();
  const e = (sched && sched.map[cp.key]) ? sched.map[cp.key] : {};
  const date = e.date || CAMP_DATES[cp.day] || '';
  const startMin = (e.start != null) ? e.start : hhmmToMin_(cp.start);
  const endMin = (e.end != null) ? e.end : hhmmToMin_(cp.end);
  const lead = e.lead || defaultLead_(cp);
  const now = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
  const startStr = date + ' ' + minToHHmm_(startMin - lead);
  const endStr = date + ' ' + minToHHmm_(endMin);
  return { ok: (now >= startStr && now <= endStr), now: now,
           range: 'D' + cp.day + ' ' + to12h_(minToHHmm_(startMin - lead)) + '–' + to12h_(minToHHmm_(endMin)) };
}

/**
 * JSON API for the external scanner page (GitHub Pages).
 * Called via fetch POST with Content-Type text/plain (avoids a CORS preflight,
 * which Apps Script can't answer). Body = {action, ...params}.
 */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (req.action) {
      case 'config': out = getConfig(); break;
      case 'scan':   out = recordScan(req); break;
      case 'undo':   out = undoScan(req); break;
      case 'search': out = manualSearch(req); break;
      case 'stats':  out = getStats(req); break;
      default:       out = { ok: false, error: 'BAD_ACTION' };
    }
  } catch (err) {
    out = { ok: false, error: 'EXCEPTION', message: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------------------------------------------
// AUTH
// ----------------------------------------------------------------------------
function getPasscode_() {
  const p = PropertiesService.getScriptProperties().getProperty('ORG_PASSCODE');
  return p || DEFAULT_PASSCODE;
}
function checkPass(pass) {
  return String(pass || '') === String(getPasscode_());
}

// ----------------------------------------------------------------------------
// CORE: record a scan / manual check-in
//   req = { pass, payload, checkpointKey, hall, organiser }
// ----------------------------------------------------------------------------
function recordScan(req) {
  if (!checkPass(req.pass)) return { ok: false, error: 'AUTH', message: '密码错误 Wrong passcode' };

  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (e) { return { ok: false, error: 'BUSY', message: '系统繁忙，请重试 System busy, retry' }; }

  try {
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(SHEET.ATTENDEES);
    const data = sh.getDataRange().getValues();
    const header = data[0];
    const idx = {};
    header.forEach((h, i) => { idx[String(h).trim()] = i; });

    const parsed = parsePayload_(req.payload);
    if (!parsed) return { ok: false, error: 'BAD_QR', message: '无法识别 Unrecognised code' };

    // find attendee row by ID
    let rowNum = -1, row = null;
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][idx['ID']]).trim().toUpperCase() === parsed.id) { rowNum = r + 1; row = data[r]; break; }
    }
    if (rowNum < 0) return { ok: false, error: 'NOT_FOUND', message: '找不到 ID: ' + parsed.id };

    // token check (skip if attendee has no token stored)
    const storedTok = String(row[idx['Token']] || '').trim().toUpperCase();
    if (storedTok && parsed.token && storedTok !== parsed.token) {
      return { ok: false, error: 'BAD_TOKEN', message: '二维码不匹配 QR / ID mismatch' };
    }

    const cp = CHECKPOINTS.find(c => c.key === req.checkpointKey);
    if (!cp) return { ok: false, error: 'BAD_CP', message: 'Unknown checkpoint' };
    const col = idx[cp.label];
    if (col === undefined) return { ok: false, error: 'NO_COL', message: '缺少栏位 Missing column: ' + cp.label };

    // optional time-window guard (catches "wrong checkpoint selected"); allow override with force.
    // Times + on/off live in the editable Schedule tab, so you can change them mid-camp.
    const sched = getSchedule_(ss);
    if (sched.enforce && cp.start && !req.force) {
      const w = windowCheck_(ss, cp, sched);
      if (!w.ok) return { ok: false, error: 'WINDOW', canForce: true,
        message: '⏰ ' + cp.label + ' 扫描时间为 ' + w.range + '。现在不在时段内。' };
    }

    const name = row[idx['Name']];
    const group = row[idx['Group']];
    const role = row[idx['Role']];
    let room = row[idx['Room']];
    const roomGroup = (idx['RoomGroup'] !== undefined) ? row[idx['RoomGroup']] : '';
    const busBack = isYes_(row[idx['BusBack']]);
    const existing = row[col];
    const now = new Date();
    const tz = ss.getSpreadsheetTimeZone();

    let action = 'check', duplicate = false, switched = false, prevTime = '';

    if (cp.type === 'hall') {
      const hallCol = idx[HALL_COL];
      const prevHall = (hallCol !== undefined) ? row[hallCol] : '';
      if (existing) {
        if (req.hall && prevHall && req.hall !== prevHall) {           // switching halls
          if (hallCol !== undefined) sh.getRange(rowNum, hallCol + 1).setValue(req.hall);
          sh.getRange(rowNum, col + 1).setValue(now);
          action = 'switch'; switched = true;
        } else {                                                       // re-scan same hall
          duplicate = true; action = 'rescan'; prevTime = fmt_(existing, tz);
        }
      } else {
        sh.getRange(rowNum, col + 1).setValue(now);
        if (hallCol !== undefined && req.hall) sh.getRange(rowNum, hallCol + 1).setValue(req.hall);
      }
    } else {
      if (existing) { duplicate = true; action = 'rescan'; prevTime = fmt_(existing, tz); }
      else { sh.getRange(rowNum, col + 1).setValue(now); }
    }

    // ROOM KEY (领房卡 / 退房卡) — handled per FAMILY/ROOM: one scan covers the whole
    // RoomGroup. So scanning any one member marks everyone in that room as done, and
    // (for check-in) stamps the room number to all of them. Kids need not be scanned here.
    let famCount = 0;
    if (cp.type === 'room' || cp.type === 'checkout') {
      if (cp.type === 'room' && !room && roomGroup) {          // look up the actual room number
        const rn = lookupRoomNumber_(ss, roomGroup);
        if (rn) room = rn;
      }
      if (roomGroup) {
        const g = String(roomGroup).trim();
        for (let r = 1; r < data.length; r++) {
          if (String(data[r][idx['RoomGroup']] || '').trim() !== g) continue;
          famCount++;
          if (!data[r][col]) sh.getRange(r + 1, col + 1).setValue(now);                 // mark whole room
          if (cp.type === 'room' && room && idx['Room'] !== undefined && !data[r][idx['Room']]) {
            sh.getRange(r + 1, idx['Room'] + 1).setValue(room);                          // fill room # for all
          }
        }
      } else if (cp.type === 'room' && room && !row[idx['Room']]) {
        sh.getRange(rowNum, idx['Room'] + 1).setValue(room);   // no group: just this person
      }
    }

    logScan_(ss, now, parsed.id, name, cp.label, (cp.type === 'hall' ? (req.hall || '') : ''), action, req.organiser || '');

    return {
      ok: true,
      id: parsed.id, name: name, group: group, role: role,
      room: room, roomGroup: roomGroup, family: famCount,
      roomPending: (cp.type === 'room' && !room),   // true = room number not set yet (before 3pm)
      busBack: busBack,
      checkpoint: cp.label, type: cp.type,
      hall: (cp.type === 'hall') ? (req.hall || (idx[HALL_COL] !== undefined ? row[idx[HALL_COL]] : '')) : '',
      time: fmt_(now, tz),
      duplicate: duplicate, switched: switched, action: action, prevTime: prevTime
    };
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// UNDO the last check-in (for a mis-scan / wrong person).
//   req = { pass, id, checkpointKey }
//   Clears that checkpoint's timestamp; for room/checkout it reverses the whole
//   RoomGroup (and clears the room number that check-in stamped).
// ----------------------------------------------------------------------------
function undoScan(req) {
  if (!checkPass(req.pass)) return { ok: false, error: 'AUTH', message: '密码错误' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, error: 'BUSY', message: '系统繁忙' }; }
  try {
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(SHEET.ATTENDEES);
    const data = sh.getDataRange().getValues();
    const header = data[0]; const idx = {}; header.forEach((h, i) => idx[String(h).trim()] = i);
    const parsed = parsePayload_(req.id);
    if (!parsed) return { ok: false, error: 'BAD_QR' };
    const cp = CHECKPOINTS.find(c => c.key === req.checkpointKey);
    if (!cp) return { ok: false, error: 'BAD_CP' };
    const col = idx[cp.label];

    let rowNum = -1, row = null;
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][idx['ID']]).trim().toUpperCase() === parsed.id) { rowNum = r + 1; row = data[r]; break; }
    }
    if (rowNum < 0) return { ok: false, error: 'NOT_FOUND', message: '找不到 ID: ' + parsed.id };
    const name = row[idx['Name']];
    const roomGroup = (idx['RoomGroup'] !== undefined) ? row[idx['RoomGroup']] : '';

    if ((cp.type === 'room' || cp.type === 'checkout') && roomGroup) {
      const g = String(roomGroup).trim();
      for (let r = 1; r < data.length; r++) {
        if (String(data[r][idx['RoomGroup']] || '').trim() !== g) continue;
        sh.getRange(r + 1, col + 1).clearContent();
        if (cp.type === 'room' && idx['Room'] !== undefined) sh.getRange(r + 1, idx['Room'] + 1).clearContent();
      }
    } else {
      sh.getRange(rowNum, col + 1).clearContent();
      if (cp.type === 'hall' && idx[HALL_COL] !== undefined) sh.getRange(rowNum, idx[HALL_COL] + 1).clearContent();
    }
    logScan_(ss, new Date(), parsed.id, name, cp.label, '', 'UNDO', req.organiser || '');
    return { ok: true, id: parsed.id, name: name, checkpoint: cp.label };
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// MANUAL SEARCH (for the manual-entry fallback) — by ID or name
// ----------------------------------------------------------------------------
function manualSearch(req) {
  if (!checkPass(req.pass)) return { ok: false, error: 'AUTH' };
  const q = String(req.query || '').trim().toLowerCase();
  if (!q) return { ok: true, results: [] };
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.ATTENDEES);
  const data = sh.getDataRange().getValues();
  const header = data[0]; const idx = {}; header.forEach((h, i) => idx[String(h).trim()] = i);
  const out = [];
  for (let r = 1; r < data.length && out.length < 12; r++) {
    const id = String(data[r][idx['ID']] || '').toLowerCase();
    const name = String(data[r][idx['Name']] || '').toLowerCase();
    const grp = String(data[r][idx['Group']] || '').toLowerCase();
    if (id.indexOf(q) > -1 || name.indexOf(q) > -1 || grp.indexOf(q) > -1) {
      out.push({
        id: data[r][idx['ID']], token: data[r][idx['Token']], name: data[r][idx['Name']],
        group: data[r][idx['Group']], role: data[r][idx['Role']], room: data[r][idx['Room']]
      });
    }
  }
  return { ok: true, results: out };
}

// ----------------------------------------------------------------------------
// LIVE STATS for the in-app dashboard
// ----------------------------------------------------------------------------
function getStats(req) {
  if (!checkPass(req.pass)) return { ok: false, error: 'AUTH' };
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET.ATTENDEES);
  const data = sh.getDataRange().getValues();
  const header = data[0]; const idx = {}; header.forEach((h, i) => idx[String(h).trim()] = i);

  let total = 0, organisers = 0;
  for (let r = 1; r < data.length; r++) if (String(data[r][idx['ID']]).trim()) {
    total++;
    if (String(data[r][idx['Role']]).toLowerCase().indexOf('organ') > -1) organisers++;
  }

  const rows = CHECKPOINTS.map(cp => {
    const col = idx[cp.label]; let n = 0;
    if (col !== undefined) for (let r = 1; r < data.length; r++) if (data[r][col] !== '' && data[r][col] != null) n++;
    return { key: cp.key, label: cp.label, type: cp.type, count: n, total: total };
  });

  // seminar hall distribution
  const hallCounts = {}; HALLS.forEach(h => hallCounts[h] = 0);
  const hc = idx[HALL_COL];
  if (hc !== undefined) for (let r = 1; r < data.length; r++) {
    const v = data[r][hc]; if (v && hallCounts[v] !== undefined) hallCounts[v]++;
  }

  // ---- outstanding lists ----
  const labelOf = k => (CHECKPOINTS.find(c => c.key === k) || {}).label;
  const busToCol = idx[labelOf('bus_to')], busBackCol = idx[labelOf('bus_back')];
  const nm = i => String(data[i][idx['Name']] || '');
  const gp = i => String(data[i][idx['Group']] || '');
  const isDone = v => v !== '' && v != null;

  // bus is PER PERSON (everyone incl. kids is scanned)
  const busTo = { total: 0, done: 0, pending: [] };
  const busBack = { total: 0, done: 0, pending: [] };
  for (let r = 1; r < data.length; r++) {
    if (!String(data[r][idx['ID']]).trim()) continue;
    if (isYes_(data[r][idx['BusTo']])) {
      busTo.total++;
      if (busToCol !== undefined && isDone(data[r][busToCol])) busTo.done++;
      else busTo.pending.push(nm(r) + (gp(r) ? ' · ' + gp(r) : ''));
    }
    if (isYes_(data[r][idx['BusBack']])) {
      busBack.total++;
      if (busBackCol !== undefined && isDone(data[r][busBackCol])) busBack.done++;
      else busBack.pending.push(nm(r) + (gp(r) ? ' · ' + gp(r) : ''));
    }
  }

  // room keys are PER ROOM (family unit) — read the Rooms tab counts
  const keyOut = { total: 0, done: 0, pending: [] };       // 领房卡
  const keyReturn = { total: 0, done: 0, pending: [] };    // 退房卡
  const rmSh = ss.getSheetByName(SHEET.ROOMS);
  if (rmSh) {
    const rm = rmSh.getDataRange().getValues();   // cols: RoomGroup,RoomNumber,Members,Assigned,KeyIssued,KeyReturned,Notes
    for (let r = 1; r < rm.length; r++) {
      const grp = String(rm[r][0] || '').trim(); if (!grp) continue;
      const label = grp + (rm[r][2] ? ' · ' + rm[r][2] : '') + (rm[r][1] ? ' (Rm ' + rm[r][1] + ')' : '');
      keyOut.total++;
      if ((Number(rm[r][4]) || 0) > 0) keyOut.done++; else keyOut.pending.push(label);
      keyReturn.total++;
      if ((Number(rm[r][5]) || 0) > 0) keyReturn.done++; else keyReturn.pending.push(label);
    }
  }

  return { ok: true, total: total, organisers: organisers, rows: rows, halls: hallCounts,
           busTo: busTo, busBack: busBack, keyOut: keyOut, keyReturn: keyReturn,
           updated: fmt_(new Date(), ss.getSpreadsheetTimeZone()) };
}

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
function parsePayload_(p) {
  if (!p) return null;
  p = String(p).trim();
  const m = p.match(/[?&]id=([^&]+)/i);          // allow a URL form ...?id=C001-AB12
  if (m) p = decodeURIComponent(m[1]);
  const parts = p.split('-');
  const id = (parts[0] || '').trim().toUpperCase();
  const token = parts.length > 1 ? (parts[1] || '').trim().toUpperCase() : '';
  if (!id) return null;
  return { id: id, token: token };
}
function isYes_(v) {
  const s = String(v || '').trim().toUpperCase();
  return v === true || s === 'Y' || s === 'YES' || s === '是' || s === 'TRUE' || s === '1';
}
function fmt_(d, tz) {
  try { return Utilities.formatDate(new Date(d), tz, 'HH:mm:ss'); } catch (e) { return ''; }
}
function logScan_(ss, when, id, name, checkpoint, hall, action, organiser) {
  const sh = ss.getSheetByName(SHEET.LOG);
  sh.appendRow([when, id, name, checkpoint, hall, action, organiser]);
}
function colLetter_(n) { // 1-based -> A1 column letter
  let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}
/** Look up the actual room number for a RoomGroup from the Rooms tab (A=group, B=number). */
function lookupRoomNumber_(ss, group) {
  group = String(group || '').trim();
  if (!group) return '';
  const sh = ss.getSheetByName(SHEET.ROOMS);
  if (!sh) return '';
  const d = sh.getDataRange().getValues();
  for (let r = 1; r < d.length; r++) {
    if (String(d[r][0]).trim() === group) return String(d[r][1] || '').trim();
  }
  return '';
}

// ----------------------------------------------------------------------------
// SETUP — run ONCE. Builds every tab, headers, validation, dashboard.
// Safe to re-run: it only adds what is missing and never deletes your data.
// ----------------------------------------------------------------------------
function setupSheet() {
  const ss = SpreadsheetApp.getActive();

  // ---- Attendees ----
  let at = ss.getSheetByName(SHEET.ATTENDEES) || ss.insertSheet(SHEET.ATTENDEES);
  const headers = PROFILE_COLS.concat(CHECKPOINTS.map(c => c.label)).concat([HALL_COL]);
  const firstCell = at.getRange(1, 1).getValue();
  if (!firstCell) {
    at.getRange(1, 1, 1, headers.length).setValues([headers]);
    // a couple of sample rows so you can test immediately
    at.getRange(2, 1, 2, PROFILE_COLS.length).setValues([
      ['C001','AB12','Sample Attendee 测试','0123456789','Attendee','Group A','Y','Y','R01','','',''],
      ['C002','CD34','Sample Organiser 测试','0129876543','Organiser','Logistics','N','N','R02','','','']
    ]);
  }
  at.setFrozenRows(1); at.setFrozenColumns(3);
  at.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#fff');

  // validation dropdowns
  const lastR = 1000;
  setValidation_(at, 'Role', headers, ['Attendee', 'Organiser', 'Leader'], lastR);
  setValidation_(at, 'BusTo', headers, ['Y', 'N'], lastR);
  setValidation_(at, 'BusBack', headers, ['Y', 'N'], lastR);
  setValidation_(at, HALL_COL, headers, HALLS, lastR);

  // ---- ScanLog ----
  let lg = ss.getSheetByName(SHEET.LOG) || ss.insertSheet(SHEET.LOG);
  if (!lg.getRange(1, 1).getValue()) {
    lg.getRange(1, 1, 1, 7).setValues([['Time', 'ID', 'Name', 'Checkpoint', 'Hall', 'Action', 'Organiser']]);
    lg.setFrozenRows(1);
    lg.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#5f6368').setFontColor('#fff');
  }

  // ---- Rooms (room-group planning + key tracking) ----
  // One row per planned room. Fill RoomGroup + planned members BEFORE camp.
  // At 3pm, type the real RoomNumber once per row — it auto-stamps to each member on check-in.
  const rgCol = colLetter_(PROFILE_COLS.indexOf('RoomGroup') + 1);                 // Attendees RoomGroup col
  const ckCol = colLetter_(PROFILE_COLS.length + CHECKPOINTS.findIndex(c => c.key === 'checkin') + 1);  // 领房卡 col
  const coCol = colLetter_(PROFILE_COLS.length + CHECKPOINTS.findIndex(c => c.key === 'checkout') + 1); // 退房卡 col
  let rm = ss.getSheetByName(SHEET.ROOMS) || ss.insertSheet(SHEET.ROOMS);
  if (!rm.getRange(1, 1).getValue()) {
    rm.getRange(1, 1, 1, 7).setValues([['RoomGroup', 'RoomNumber (fill at 3pm)', 'Planned members', 'Assigned (auto)', 'KeyIssued (auto)', 'KeyReturned (auto)', 'Notes']]);
    rm.getRange(2, 1, 2, 3).setValues([['R01', '', '陈大文 + family'], ['R02', '', '林美丽']]);
    rm.setFrozenRows(1);
    rm.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#5f6368').setFontColor('#fff');
    // auto-fill counts for ALL room rows you add (no need to drag formulas)
    rm.getRange('D2').setFormula('=ARRAYFORMULA(IF(A2:A="","",COUNTIF(Attendees!$' + rgCol + '$2:$' + rgCol + ',A2:A)))');
    rm.getRange('E2').setFormula('=ARRAYFORMULA(IF(A2:A="","",COUNTIFS(Attendees!$' + rgCol + '$2:$' + rgCol + ',A2:A,Attendees!$' + ckCol + '$2:$' + ckCol + ',"<>")))');
    rm.getRange('F2').setFormula('=ARRAYFORMULA(IF(A2:A="","",COUNTIFS(Attendees!$' + rgCol + '$2:$' + rgCol + ',A2:A,Attendees!$' + coCol + '$2:$' + coCol + ',"<>")))');
    rm.setColumnWidth(2, 160); rm.setColumnWidth(3, 200);
  }

  // ---- Schedule (EDITABLE checkpoint times — change a cell, no redeploy) ----
  let sc = ss.getSheetByName(SHEET.SCHED) || ss.insertSheet(SHEET.SCHED);
  if (!sc.getRange(1, 1).getValue()) {
    sc.getRange(1, 1, 1, 6).setValues([['Key', 'Checkpoint', 'Date (yyyy-mm-dd)', 'Start (e.g. 8:00pm)', 'End', 'Open mins before']]);
    const rows = CHECKPOINTS.map(c => [c.key, c.label, CAMP_DATES[c.day] || '', to12h_(c.start), to12h_(c.end), defaultLead_(c)]);
    sc.getRange(2, 1, rows.length, 6).setValues(rows);
    const er = rows.length + 3;
    sc.getRange(er, 1).setValue('Enforce time windows? (Y/N)').setFontWeight('bold');
    sc.getRange(er, 2).setValue('N').setFontWeight('bold').setBackground('#fff3cd');
    sc.getRange(er + 1, 1).setValue('↑ set to Y on camp day · 改时间只需改上面格子，立即生效（无需重新部署）').setFontColor('#666');
    sc.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#5f6368').setFontColor('#fff');
    sc.getRange(2, 3, rows.length, 3).setNumberFormat('@');   // keep date/time as typed text
    sc.setFrozenRows(1); sc.setColumnWidth(2, 230); sc.setColumnWidth(3, 150); sc.setColumnWidth(4, 140); sc.setColumnWidth(5, 120);
  }

  // ---- Dashboard ----
  buildDashboard_(ss, headers);

  // ---- passcode ----
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ORG_PASSCODE')) props.setProperty('ORG_PASSCODE', DEFAULT_PASSCODE);

  SpreadsheetApp.getActive().toast('Setup complete. Passcode = ' + getPasscode_(), 'Camp Check-in', 8);
}

function setValidation_(sheet, headerName, headers, values, lastRow) {
  const c = headers.indexOf(headerName); if (c < 0) return;
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build();
  sheet.getRange(2, c + 1, lastRow - 1, 1).setDataValidation(rule);
}

function buildDashboard_(ss, headers) {
  let d = ss.getSheetByName(SHEET.DASH) || ss.insertSheet(SHEET.DASH, 0);
  ss.setActiveSheet(d); ss.moveActiveSheet(1);
  d.clear();
  d.getRange('A1').setValue('🏕  CAMP CHECK-IN — LIVE DASHBOARD').setFontSize(16).setFontWeight('bold');
  d.getRange('A2').setValue('Auto-updates as people are scanned. Refresh the page to recalc.').setFontColor('#666');

  const colOf = name => colLetter_(headers.indexOf(name) + 1);
  const idCol = colOf('ID');
  const totalRef = 'COUNTA(Attendees!$' + idCol + '$2:$' + idCol + ')';

  // summary table
  d.getRange('A4:D4').setValues([['Checkpoint', 'Checked-in', 'Total', '%']])
    .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#fff');
  const start = 5;
  CHECKPOINTS.forEach((cp, i) => {
    const L = colOf(cp.label); const r = start + i;
    d.getRange(r, 1).setValue(cp.label);
    d.getRange(r, 2).setFormula('=COUNTA(Attendees!$' + L + '$2:$' + L + ')');
    d.getRange(r, 3).setFormula('=' + totalRef);
    d.getRange(r, 4).setFormula('=IFERROR(B' + r + '/C' + r + ',0)').setNumberFormat('0%');
  });
  d.getRange(start, 4, CHECKPOINTS.length, 1).setNumberFormat('0%');

  // seminar hall distribution
  const hCol = colOf(HALL_COL); let hr = start + CHECKPOINTS.length + 1;
  d.getRange(hr, 1).setValue('专题讲座分布 Seminar halls').setFontWeight('bold');
  HALLS.forEach((h, i) => {
    d.getRange(hr + 1 + i, 1).setValue(h);
    d.getRange(hr + 1 + i, 2).setFormula('=COUNTIF(Attendees!$' + hCol + '$2:$' + hCol + ',"' + h + '")');
  });

  // ===== Outstanding trackers — the two live lists you watch =====
  const nameCol = colOf('Name'), grpCol = colOf('Group'), rgCol = colOf('RoomGroup');
  const busToFlag = colOf('BusTo'), busBackFlag = colOf('BusBack');
  const busToScan = colOf(CHECKPOINTS.find(c => c.key === 'bus_to').label);
  const busBackScan = colOf(CHECKPOINTS.find(c => c.key === 'bus_back').label);
  const checkinCol = colOf(CHECKPOINTS.find(c => c.key === 'checkin').label);
  const rng = c => 'Attendees!' + c + '2:' + c;

  // 🚌 去程巴士 — 还没上车 (确认全到齐才开车)
  d.getRange('F4').setValue('🚌 去程未上车 Bus to venue — NOT boarded').setFontWeight('bold').setBackground('#fbbc04');
  d.getRange('F5').setFormula('="已上车 " & COUNTIFS(' + rng(busToFlag) + ',"Y",' + rng(busToScan) + ',"<>") & " / " & COUNTIF(' + rng(busToFlag) + ',"Y")').setFontWeight('bold');
  d.getRange('F6').setFormula('=IFERROR(FILTER(' + rng(nameCol) + '&" · "&' + rng(grpCol) + ', ' + rng(busToFlag) + '="Y", ' + rng(busToScan) + '=""), "✅ 全到齐 All aboard")');

  // 🔑 领房卡 — 还没领 (按房间/家庭，一间一行)
  const rmRooms = 'COUNTA(Rooms!$A$2:$A)';
  d.getRange('H4').setValue('🔑 未领房卡 No key yet (by room)').setFontWeight('bold').setBackground('#fbbc04');
  d.getRange('H5').setFormula('="已领 " & COUNTIF(Rooms!$E$2:$E,">0") & " / " & ' + rmRooms + ' & " 间 rooms"').setFontWeight('bold');
  d.getRange('H6').setFormula('=IFERROR(FILTER(Rooms!A2:A&" "&Rooms!B2:B&" · "&Rooms!C2:C, Rooms!E2:E=0, Rooms!A2:A<>""), "✅ 全部领取 All collected")');

  // 🔑 退房卡 — 还没还 (按房间/家庭)
  d.getRange('J4').setValue('🔑 未还房卡 Key not returned (by room)').setFontWeight('bold').setBackground('#fbbc04');
  d.getRange('J5').setFormula('="已还 " & COUNTIF(Rooms!$F$2:$F,">0") & " / " & ' + rmRooms + ' & " 间 rooms"').setFontWeight('bold');
  d.getRange('J6').setFormula('=IFERROR(FILTER(Rooms!A2:A&" "&Rooms!B2:B&" · "&Rooms!C2:C, Rooms!F2:F=0, Rooms!A2:A<>""), "✅ 全部归还 All returned")');

  // 🚌 返程巴士 — 还没上车 (按人)
  d.getRange('L4').setValue('🚌 返程未上车 Return bus — NOT boarded').setFontWeight('bold').setBackground('#fbbc04');
  d.getRange('L5').setFormula('="已上车 " & COUNTIFS(' + rng(busBackFlag) + ',"Y",' + rng(busBackScan) + ',"<>") & " / " & COUNTIF(' + rng(busBackFlag) + ',"Y")').setFontWeight('bold');
  d.getRange('L6').setFormula('=IFERROR(FILTER(' + rng(nameCol) + '&" · "&' + rng(grpCol) + ', ' + rng(busBackFlag) + '="Y", ' + rng(busBackScan) + '=""), "✅ 全到齐 All aboard")');

  d.setColumnWidth(1, 230); d.setColumnWidth(6, 230); d.setColumnWidth(8, 250); d.setColumnWidth(10, 250); d.setColumnWidth(12, 230);
  d.setFrozenRows(4);
}

// ----------------------------------------------------------------------------
// MENU (appears in the Sheet) — Setup, passcode, link
// ----------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🏕 Camp Check-in')
    .addItem('① Setup / Rebuild sheets', 'setupSheet')
    .addItem('② Change organiser passcode', 'menuSetPasscode_')
    .addItem('③ Save check-in link', 'menuSetUrl_')
    .addItem('④ Show check-in link', 'menuShowUrl_')
    .addToUi();
}
function menuSetPasscode_() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('New organiser passcode', 'Everyone scanning will type this once:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() === ui.Button.OK) {
    const v = res.getResponseText().trim();
    if (v) { PropertiesService.getScriptProperties().setProperty('ORG_PASSCODE', v); ui.alert('Passcode set to: ' + v); }
  }
}
/**
 * Paste the REAL web-app URL here once. Get it from:
 *   Deploy > Manage deployments > (your Web app) > copy the URL ending in /exec
 * We store it instead of trusting ScriptApp.getService().getUrl(), which can
 * return the wrong deployment when several exist.
 */
function menuSetUrl_() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Save check-in link',
    'Paste the Web app URL from Deploy > Manage deployments (ends with /exec):',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() === ui.Button.OK) {
    const v = res.getResponseText().trim();
    if (v) { PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', v); ui.alert('Saved:\n\n' + v); }
  }
}
function menuShowUrl_() {
  const saved = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL');
  if (saved) { SpreadsheetApp.getUi().alert('Check-in link (share this):\n\n' + saved); return; }
  let url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  SpreadsheetApp.getUi().alert(
    (url ? ('Auto-detected (may be wrong if you have multiple deployments):\n\n' + url + '\n\n') : '') +
    '➡️ Use "③ Save check-in link" with the URL from Deploy > Manage deployments.');
}
