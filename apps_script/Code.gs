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
const SHEET = { ATTENDEES: 'Attendees', LOG: 'ScanLog', ROOMS: 'Rooms', DASH: 'Dashboard' };

const DEFAULT_PASSCODE = 'camp2026';   // change after setup via the Camp menu

// Single source of truth for the checkpoints. Order = display order.
// type:  simple   = just record time
//        room     = record time + show the person's hotel room / key
//        hall     = free-choice seminar, asks which Hall, handles switches
//        checkout = record time = "room key returned"
const CHECKPOINTS = [
  { key: 'bus_to',   label: '1. 教会乘车报到 Church Bus',       type: 'simple'   },
  { key: 'checkin',  label: '2. 会场报到·领房卡 Venue Check-in', type: 'room'     },
  { key: 'theme1',   label: '3. 主题信息1 Theme Msg 1',         type: 'simple'   },
  { key: 'worship2', label: '4. 敬拜 Day2 Worship',             type: 'simple'   },
  { key: 'seminar',  label: '5. 专题讲座 Seminar',              type: 'hall'     },
  { key: 'biggame',  label: '6. 大型游戏 Big Game',             type: 'simple'   },
  { key: 'bbq',      label: '7. BBQ Dinner',                    type: 'simple'   },
  { key: 'devo1',    label: '8. 灵修1 Devotion 1',              type: 'simple'   },
  { key: 'devo2',    label: '9. 灵修2 Devotion 2',              type: 'simple'   },
  { key: 'theme2',   label: '10. 主题信息2 Theme Msg 2',        type: 'simple'   },
  { key: 'checkout', label: '11. 退房·还房卡 Check-out',        type: 'checkout' },
  { key: 'bus_back', label: '12. 返程乘车报到 Return Bus',      type: 'simple'   },
];

const HALLS = ['Hall 1', 'Hall 2', 'Hall 3'];

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

/** Public config for the UI (no passcode needed — just labels). */
function getConfig() {
  return { checkpoints: CHECKPOINTS, halls: HALLS };
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

    // ROOM CHECK-IN: stamp the actual room number from the Rooms tab (by RoomGroup).
    // You type the real number on the Rooms tab once at 3pm; it lands here on scan.
    if (cp.type === 'room') {
      if (!room && roomGroup) {
        const rn = lookupRoomNumber_(ss, roomGroup);
        if (rn) { room = rn; sh.getRange(rowNum, idx['Room'] + 1).setValue(rn); }
      }
    }

    logScan_(ss, now, parsed.id, name, cp.label, (cp.type === 'hall' ? (req.hall || '') : ''), action, req.organiser || '');

    return {
      ok: true,
      id: parsed.id, name: name, group: group, role: role,
      room: room, roomGroup: roomGroup,
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

  // ---- outstanding lists: bus boarding & room-key collection ----
  const labelOf = k => (CHECKPOINTS.find(c => c.key === k) || {}).label;
  const busToCol = idx[labelOf('bus_to')], busBackCol = idx[labelOf('bus_back')], checkinCol = idx[labelOf('checkin')];
  const nm = i => String(data[i][idx['Name']] || '');
  const gp = i => String(data[i][idx['Group']] || '');
  const rg = i => (idx['RoomGroup'] !== undefined ? String(data[i][idx['RoomGroup']] || '') : '');
  const isDone = v => v !== '' && v != null;

  const busTo = { total: 0, done: 0, pending: [] };
  const busBack = { total: 0, done: 0, pending: [] };
  const key = { total: 0, done: 0, pending: [] };
  for (let r = 1; r < data.length; r++) {
    if (!String(data[r][idx['ID']]).trim()) continue;
    // bus to venue (only those on the bus list)
    if (isYes_(data[r][idx['BusTo']])) {
      busTo.total++;
      if (busToCol !== undefined && isDone(data[r][busToCol])) busTo.done++;
      else busTo.pending.push(nm(r) + (gp(r) ? ' · ' + gp(r) : ''));
    }
    // bus return
    if (isYes_(data[r][idx['BusBack']])) {
      busBack.total++;
      if (busBackCol !== undefined && isDone(data[r][busBackCol])) busBack.done++;
      else busBack.pending.push(nm(r) + (gp(r) ? ' · ' + gp(r) : ''));
    }
    // room key (everyone)
    key.total++;
    if (checkinCol !== undefined && isDone(data[r][checkinCol])) key.done++;
    else key.pending.push(nm(r) + (rg(r) ? ' · ' + rg(r) : ''));
  }

  return { ok: true, total: total, organisers: organisers, rows: rows, halls: hallCounts,
           busTo: busTo, busBack: busBack, key: key,
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
  setValidation_(at, 'Role', headers, ['Attendee', 'Organiser'], lastR);
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
  const ckCol = colLetter_(PROFILE_COLS.length + CHECKPOINTS.findIndex(c => c.key === 'checkin') + 1); // checkin col
  let rm = ss.getSheetByName(SHEET.ROOMS) || ss.insertSheet(SHEET.ROOMS);
  if (!rm.getRange(1, 1).getValue()) {
    rm.getRange(1, 1, 1, 6).setValues([['RoomGroup', 'RoomNumber (fill at 3pm)', 'Planned members', 'Assigned (auto)', 'KeyIssued (auto)', 'Notes']]);
    rm.getRange(2, 1, 2, 3).setValues([['R01', '', '陈大文 + family'], ['R02', '', '林美丽']]);
    rm.setFrozenRows(1);
    rm.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#5f6368').setFontColor('#fff');
    for (let r = 2; r <= 3; r++) {
      rm.getRange(r, 4).setFormula('=COUNTIF(Attendees!$' + rgCol + '$2:$' + rgCol + ', A' + r + ')');
      rm.getRange(r, 5).setFormula('=COUNTIFS(Attendees!$' + rgCol + '$2:$' + rgCol + ', A' + r + ', Attendees!$' + ckCol + '$2:$' + ckCol + ', "<>")');
    }
    rm.setColumnWidth(2, 160); rm.setColumnWidth(3, 200);
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

  // 🔑 房卡 — 还没领取
  d.getRange('H4').setValue('🔑 未领房卡 No room key yet').setFontWeight('bold').setBackground('#fbbc04');
  d.getRange('H5').setFormula('="已领 " & COUNTA(' + rng(checkinCol) + ') & " / " & ' + totalRef).setFontWeight('bold');
  d.getRange('H6').setFormula('=IFERROR(FILTER(' + rng(nameCol) + '&" · "&' + rng(rgCol) + ', ' + rng(checkinCol) + '="", ' + rng(idCol) + '<>""), "✅ 全部领取 All collected")');

  // 🚌 返程巴士 — 还没上车
  d.getRange('J4').setValue('🚌 返程未上车 Return bus — NOT boarded').setFontWeight('bold').setBackground('#fbbc04');
  d.getRange('J5').setFormula('="已上车 " & COUNTIFS(' + rng(busBackFlag) + ',"Y",' + rng(busBackScan) + ',"<>") & " / " & COUNTIF(' + rng(busBackFlag) + ',"Y")').setFontWeight('bold');
  d.getRange('J6').setFormula('=IFERROR(FILTER(' + rng(nameCol) + '&" · "&' + rng(grpCol) + ', ' + rng(busBackFlag) + '="Y", ' + rng(busBackScan) + '=""), "✅ 全到齐 All aboard")');

  d.setColumnWidth(1, 230); d.setColumnWidth(6, 230); d.setColumnWidth(8, 230); d.setColumnWidth(10, 230);
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
