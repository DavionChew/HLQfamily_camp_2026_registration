# 🏕 Church Camp Check-in System

QR + manual check-in for ~280 people across a 3-day / 2-night camp.
**No cost, no app install.** A Google Sheet is the live database + dashboard;
the Apps Script is the data API; a phone web-page (on GitHub Pages) scans the QR
on the back of each name tag and writes to it. Every organiser uses the same link
on their own phone, in real time.

> **Why GitHub Pages for the scanner?** Apps Script serves its web app inside a
> cross-origin iframe that browsers block from using the camera. So the camera
> scanner is hosted on GitHub Pages (a top-level page, camera works) and talks to
> Apps Script as a JSON API. The in-Apps-Script `Index.html` still works for
> **manual entry** as a backup.

## Repo layout

```
docs/
  index.html     CAMERA SCANNER -> served by GitHub Pages (share this with the team)
apps_script/
  Code.gs        backend API + setup    -> paste into Google Apps Script
  Index.html     manual-entry backup    -> paste into Apps Script (HTML file named "Index")
tools/
  make_template.py        builds the blank attendee template
  generate_nametags.py    list -> printable tags (front=name, back=QR) + Sheet import
data/
  Attendee_List_Template.xlsx   fill this with your names
  demo_attendees.csv            fake data for testing
samples/
  sample_nametags.pdf     example tags (from demo data)
  sample_import.xlsx      example import file
```

> ⚠️ **Privacy:** your real attendee list and generated tags hold names/phones.
> `.gitignore` keeps them out of git — commit only the template, demo, and samples.

## Quick start

**1. Build the system (~10 min, one time)**
1. New Google Sheet → **Extensions → Apps Script**.
2. Paste `apps_script/Code.gs` into the editor.
3. **+ → HTML**, name it exactly `Index`, paste `apps_script/Index.html`.
4. Run `setupSheet` once (authorise). It builds the `Dashboard`, `Attendees`, `ScanLog`, `Rooms` tabs.
5. **Deploy → New deployment → Web app** · Execute as **Me** · Access **Anyone with link** → Deploy.
6. Get the real link from **Deploy → Manage deployments** → copy the URL ending in **`/exec`**.
   *(Don't rely on the menu's auto-detect — with multiple deployments it can show the wrong one.)*
7. In the Sheet: **② Change passcode** (default `camp2026`).

**1b. Turn on the camera scanner (GitHub Pages)**
1. Put your **`/exec`** URL into `docs/index.html` — edit the `API_URL = "…"` line near the top.
2. Commit & push: `git add -A && git commit -m "set API_URL" && git push`.
3. On GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `/docs`** → Save.
4. After ~1 min your scanner is live at
   `https://<you>.github.io/<repo>/` — **this is the link you share** with the team (+ passcode).

> If you later change `Code.gs`, redeploy: **Deploy → Manage deployments → ✏️ Edit →
> Version: New version → Deploy**. The `/exec` URL stays the same, so nothing else changes.

**2. Load attendees**
```bash
cd tools
python3 make_template.py                       # (optional) regenerate the blank template
python3 generate_nametags.py ../data/your_list.xlsx --event "Your Camp 2026"
```
Produces `nametags.pdf` + `attendees_import.xlsx`. Paste columns **A:L** of the
import file into the Sheet's **Attendees** tab at row 2.

**3. Print tags** — `nametags.pdf` is 4/A4-page. Print **double-sided, flip on LONG edge**,
test one page first, then cut on the corner marks.

**4. Rooming (room numbers only known at 3pm)**
Before camp: give everyone sharing a room the same **RoomGroup** code (e.g. `R01`) and
list each room on the **Rooms** tab. Leave the `Room` column blank. At 3pm, type the real
**RoomNumber** once per row on the Rooms tab — when you scan a person at check-in, the
system auto-stamps their room and shows the key to hand over (until then it shows
"🔑 房号未定 Room TBD").

## Attendee info page (one QR, two uses)
The QR on each tag encodes a URL to a **public schedule page** (`docs/info.html`):
- An **attendee** scanning with their **normal phone camera** → opens the 节目表 + 🆘 emergency contacts.
- An **organiser** scanning in the scanner app → the app reads the `?id=` and checks them in.

Setup: edit the 🆘 contact names/numbers in `docs/info.html`, push, and it's live at
`https://<you>.github.io/<repo>/info.html` (same Pages site as the scanner). The generator
already points the QR there via `--info-url` (default set in `generate_nametags.py`); pass a
different `--info-url` if your repo name differs, or `--info-url ""` to encode just the ID.
**This page is static — 280 attendees scanning it puts zero load on the check-in backend.**

## The 12 checkpoints
Church bus · **Venue check-in (+ room key)** · 主题信息1 · 敬拜 Day2 ·
专题讲座 (Jade Main Hall / Sapphire 1 / Sapphire 2, free choice + switch handling) · 大型游戏 ·
BBQ · 灵修1 · 灵修2 · 主题信息2 · Check-out (key returned + bus reminder) · Return bus.
Each carries a scheduled day + time, shown in the dropdown in 12-hour form
(e.g. "3. 主题信息1 · D1 8:00pm–10:15pm"). Edit them all in one place: the
`CHECKPOINTS` list at the top of `apps_script/Code.gs` (label, type, day, start, end).

### Camp-day toggles & tips
- **Continuous scanning:** leave the camera on and scan one person after another — each is
  auto-recorded to the selected checkpoint. The same QR is ignored for 3 s to avoid doubles.
- **Undo a mis-scan:** every confirmation card has **↩︎ 撤销 Undo** which reverses that last
  check-in (for room/checkout it reverses the whole family). Also logged in ScanLog.
- **Time-window guard (optional):** set `ENFORCE_WINDOWS = true` in `Code.gs` on camp day.
  Scans then only succeed from **30 min before** a checkpoint's start until its end — which
  stops accidental scans into the wrong checkpoint. If a session runs late, the screen offers
  **"仍然记录 Record anyway"**. Keep it `false` while testing (today's date is outside the camp
  windows, so everything would be blocked otherwise). Times/dates live in `CHECKPOINTS` + `CAMP_DATES`.
- **Wrong ID/Name?** Manual entry never free-types a check-in — you search and tap a person
  (name + ID + group shown), and the big confirmation card shows who you just recorded, so a
  slip is obvious and one tap of Undo fixes it.

## Organiser usage (phone)
Open link → name + passcode → pick checkpoint → 📷 scan (or **Manual** by ID/name).
Green = checked in (room shows at check-in); amber = already done; 🔁 = hall switch.
**📊 Stats** shows live counts on any phone; the **Dashboard** tab shows the full picture.

## Live "who's outstanding" views (Dashboard tab + 📊 Stats)
Both update automatically as people are scanned:
- **🚌 去程未上车 / 返程未上车** (per person) — among the people on the bus list, who has
  **not** boarded yet (plus "x / y boarded"). Confirm all aboard before departing.
- **🔑 未领房卡 / 未还房卡** (per room) — which **rooms/families** have not collected /
  returned their key yet (plus "x / y rooms"). Keys are handled per family, not per head.

### Room keys are per-family
A whole family shares one **RoomGroup**. Scanning **any one member** at check-in (or check-out)
marks the **entire room** done and stamps the room number to everyone in it — so you only scan
one person per family for the key, and kids never need a room number entered. (Everyone is still
scanned individually at the session checkpoints.)

### Roles
`Attendee`, `Organiser`, `Leader` (组长). Organisers and Leaders are the people who scan
(give them the link + passcode); Leaders show a 组长 badge when scanned.

## Setup dependencies (for the tag generator)
```bash
pip install qrcode pillow reportlab openpyxl
```
