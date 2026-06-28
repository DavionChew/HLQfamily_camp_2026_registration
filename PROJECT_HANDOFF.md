# 🏕 Camp Check-in — Project Handoff & Next Steps

_Last updated: 2026-06-28_

## TL;DR

A QR + manual check-in system for a 3D2N church camp (~280 people, 12 checkpoints)
is **built and working**, except for one thing: **where to host the camera scanner page.**

- ✅ Backend (Google Sheet + Apps Script API): done, deployed, working.
- ✅ Name-tag + QR generator: done and tested.
- ✅ Manual check-in: works today.
- ⚠️ **Camera scanning needs the scanner page hosted on a normal HTTPS site.**
  It can't run inside the Apps Script web app (browser blocks the camera in
  Apps Script's cross-origin iframe). GitHub Pages would work but needs a *public*
  repo — which you don't want. **Pick any other static host (2-minute job).**

You do **not** need a full re-plan. The system is ~95% complete. See "Decision" below.

---

## What exists (files in this repo)

```
docs/index.html      Camera scanner UI (top-level page). Calls the Apps Script API
                     via fetch. Your /exec URL is already baked into API_URL.
apps_script/
  Code.gs            Backend: setup, data model, recordScan logic, doPost JSON API,
                     LockService concurrency, passcode auth, dashboard builder.
  Index.html         In-Apps-Script page (manual entry works; camera does NOT — see blocker).
tools/
  generate_nametags.py   attendee list -> nametags.pdf (front=name, back=QR) + import xlsx
  make_template.py       builds the blank attendee template
data/
  Attendee_List_Template.xlsx   fill with real names (gitignored when named attendees*)
  demo_attendees.csv            fake data for testing
samples/
  sample_nametags.pdf / sample_import.xlsx   example outputs from demo data
README.md, .gitignore
```

---

## How it works (architecture)

```
[Name tag QR: "C001-7F3K"]
        │  scan on phone
        ▼
[ Scanner page (docs/index.html) on an HTTPS host ]
        │  fetch POST (Content-Type: text/plain, body = JSON {action,...})
        ▼
[ Apps Script Web App  doPost()  → recordScan / manualSearch / getStats / getConfig ]
        │  read/write with LockService
        ▼
[ Google Sheet ]  Attendees · ScanLog · Rooms · Dashboard (live)
```

Why `text/plain`: it makes the request a CORS "simple request", so the browser
skips the preflight `OPTIONS` call that Apps Script can't answer. The redirected
`googleusercontent.com` response carries permissive CORS, so the reply is readable.

### Apps Script API contract (`doPost`)
Request body (JSON string): `{ "action": "...", ...params }`

| action | params | returns |
|---|---|---|
| `config` | – | `{ checkpoints:[{key,label,type}], halls:[...] }` |
| `scan`   | `pass, payload, checkpointKey, hall, organiser` | `{ ok, name, id, room, hall, type, time, duplicate, switched, ... }` |
| `search` | `pass, query` | `{ ok, results:[{id,token,name,group,role,room}] }` |
| `stats`  | `pass` | `{ ok, total, organisers, rows:[{label,count,total}], halls:{...} }` |

- **Auth:** `pass` must equal the Script Property `ORG_PASSCODE` (Sheet menu → ② Change passcode).
- **Web app URL (/exec):** `https://script.google.com/macros/s/AKfycbwPC_cczRP1z3RMpTYha7pi4FiPFfubYn1ZwGRclMOe-g1M3TfP-dcy4p9pZSuGRfTc/exec`

### Data model
- **Attendees** (one row/person): `ID, Token, Name, Phone, Role, Group, BusTo, BusBack, RoomGroup, Room, RoomNote, Notes` + one timestamp column per checkpoint + `SeminarHall`.
- **RoomGroup → Room workflow:** `RoomGroup` (e.g. `R01`) is pre-assigned; `Room` is left blank and
  **auto-stamped at check-in** from the Rooms tab (organiser types the real room number once per
  room at 3pm). Until set, the scanner shows "Room TBD".
- **ScanLog**: append-only audit (`Time, ID, Name, Checkpoint, Hall, Action, Organiser`).
- **Rooms**: `RoomGroup, RoomNumber, Planned members, Assigned, KeyIssued, Notes`.
- **Dashboard**: checkpoint counts + two live "outstanding" lists — **bus not-yet-boarded**
  (to/return) and **room key not-yet-collected**. `getStats` also returns these as
  `busTo/busBack/key = {total, done, pending[]}` for the in-app 📊 Stats.
- **QR payload:** `<ID>-<Token>` e.g. `C001-7F3K` (token blocks guessing other IDs).

### The 12 checkpoints (in `CHECKPOINTS` at top of `Code.gs`)
1 Church bus · 2 **Venue check-in (+room key)** · 3 主题信息1 · 4 敬拜 Day2 ·
5 专题讲座 (Hall 1/2/3, free choice + switch handling) · 6 大型游戏 · 7 BBQ ·
8 灵修1 · 9 灵修2 · 10 主题信息2 · 11 Check-out (key returned + bus reminder) · 12 Return bus.

### Requirements captured
~280 attendees · reliable venue internet · organisers scan QR on phones · manual entry
fallback · room key shown at check-in · key-return at check-out · bus-to/bus-return
manifests · halls chosen freely at the door · live view + editable data for organisers.

---

## The one blocker

**Apps Script can't access the camera.** It serves pages inside a cross-origin
iframe (`*.googleusercontent.com`) without `allow="camera"`, so `getUserMedia`
fails with `NotAllowedError: Permission denied`. This is structural — not fixable
from inside the script. The scanner therefore must live on a normal top-level
HTTPS page. (Manual entry inside Apps Script is unaffected and works now.)

---

## Decision: pick a host for `docs/index.html`

It's a single static HTML file. Any of these give an HTTPS URL where the camera works:

| Option | Effort | Repo public? | Notes |
|---|---|---|---|
| **Netlify Drop** (recommended) | ~2 min | No | Go to app.netlify.com/drop, drag `docs/index.html`, get a URL. No repo, no account needed to start. |
| Cloudflare Pages | ~10 min | No | Free; direct upload or git. Custom domain easy. |
| Vercel | ~10 min | No | Free; CLI `vercel` or drag-drop. |
| Firebase Hosting | ~15 min | No | `firebase init hosting` + `firebase deploy`. Pairs well if you later move the backend to Firebase too. |
| GitHub Pages | ~5 min | **Yes** | Only this one needs a public repo — the option you're avoiding. |

After hosting, share **that URL + the passcode** with organisers. Done.

> Whichever host: keep `API_URL` in `docs/index.html` pointing at your `/exec` URL,
> and set a strong passcode (the passcode is what protects check-ins once the URL is shareable).

---

## What to do next — choose ONE

### Path A — Finish as-is (fastest, recommended)
1. Host `docs/index.html` on **Netlify Drop** (or any host above). Copy the URL.
2. Sheet menu → **② Change passcode** to something non-trivial.
3. Open the host URL on your phone → **Start camera** → allow → test a scan with a demo tag.
4. Load real attendees: fill `data/`, run `tools/generate_nametags.py`, paste import into the Sheet, print tags.
5. Brief the organiser team: URL + passcode + how to pick the checkpoint.

### Path B — Re-plan / rebuild in Claude Code
Only if you want a single unified app instead of Sheet + Apps Script + static page
(e.g. nicer admin UI, offline support, role accounts). Open this repo in Claude Code
and paste the prompt below.

---

## Prompt to paste into Claude Code (for Path B)

> I have a church-camp QR check-in system in this repo (see `PROJECT_HANDOFF.md` for
> full context: data model, 12 checkpoints, API contract, requirements). It currently
> uses a Google Sheet + Apps Script backend with a static `docs/index.html` scanner.
> The only problem is hosting the camera scanner. I want to **re-plan the architecture**.
> Constraints: ~280 attendees, reliable venue wifi, multiple organisers scanning
> concurrently on phones, QR payload is `ID-Token`, manual-entry fallback, room key at
> check-in, key return at check-out, bus manifests, free-choice seminar halls, and a
> live editable view for organisers. It must be **free or near-free** and simple for
> non-technical volunteers to run. Propose 2–3 architecture options with trade-offs
> (e.g. keep Apps Script backend + host scanner on Netlify/Cloudflare; vs. Firebase
> Hosting + Firestore; vs. a small Next.js app on Vercel + Supabase). Recommend one,
> then implement it. Reuse the existing data model and name-tag generator where possible.

---

## Honest recommendation

The system already works. The "blocker" is just hosting one file, which **Netlify Drop
solves in two minutes (Path A)** — no repo, no public exposure, no rebuild. Only go to
Path B if you specifically want a more polished single app and have time before the camp.
