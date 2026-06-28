# 🏕 Church Camp Check-in System

QR + manual check-in for ~280 people across a 3-day / 2-night camp.
**No cost, no app install.** A Google Sheet is the live database + dashboard; a
phone web-page scans the QR on the back of each name tag and writes to it. Every
organiser uses the same link on their own phone, in real time.

## Repo layout

```
apps_script/
  Code.gs        backend logic   -> paste into Google Apps Script
  Index.html     phone scanner   -> paste into Apps Script (HTML file named "Index")
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
7. In the Sheet: **🏕 Camp Check-in → ③ Save check-in link** (paste that `/exec` URL),
   then **② Change passcode** (default `camp2026`).
8. Send the **saved link + passcode** to your organiser team.

**2. Load attendees**
```bash
cd tools
python3 make_template.py                       # (optional) regenerate the blank template
python3 generate_nametags.py ../data/your_list.xlsx --event "Your Camp 2026"
```
Produces `nametags.pdf` + `attendees_import.xlsx`. Paste columns **A:K** of the
import file into the Sheet's **Attendees** tab at row 2.

**3. Print tags** — `nametags.pdf` is 4/A4-page. Print **double-sided, flip on LONG edge**,
test one page first, then cut on the corner marks.

## The 12 checkpoints
Church bus · **Venue check-in (+ room key)** · 主题信息1 · 敬拜 Day2 ·
专题讲座 (Hall 1/2/3, free choice + switch handling) · 大型游戏 · BBQ · 灵修1 · 灵修2 ·
主题信息2 · Check-out (key returned + bus reminder) · Return bus.
Edit them in one place: the `CHECKPOINTS` list at the top of `apps_script/Code.gs`.

## Organiser usage (phone)
Open link → name + passcode → pick checkpoint → 📷 scan (or **Manual** by ID/name).
Green = checked in (room shows at check-in); amber = already done; 🔁 = hall switch.
**📊 Stats** shows live counts on any phone; the **Dashboard** tab shows the full picture.

## Setup dependencies (for the tag generator)
```bash
pip install qrcode pillow reportlab openpyxl
```
