# 🧪 Test Plan

> Tip: test on a **copy of the sheet** (File → Make a copy → deploy a web app from the copy),
> or reset anytime with the Sheet menu **🏕 Camp Check-in → 🧹 Clear ALL check-ins**.

## 0. Load the 280-person mock (for realistic scale)
```bash
cd tools && python3 make_mock.py        # -> ../samples/mock_280_import.xlsx
```
Paste columns **A:L** into the Attendees tab (row 2). Now the sheet has 280 rows, so timings are realistic.
(For camera testing, use the 12 demo tags in `samples/sample_nametags.pdf` — IDs C001–C012.)

## 1. Functional checklist (camera + manual)
- [ ] Simple scan (e.g. 主题信息1): green ✅, name shows, logged in ScanLog.
- [ ] Re-scan same person → amber "已报到" with original time (no double count).
- [ ] Continuous scan: leave camera on, scan several in a row — all recorded.
- [ ] Manual entry: search a name/ID → tap → checks in.
- [ ] **Undo**: tap ↩︎ on a result → that check-in is reversed.
- [ ] Room check-in: scan one family member → room # shows; whole RoomGroup marked (👪 N).
- [ ] Room TBD: before a RoomNumber is set on the Rooms tab → shows "🔑 房号未定".
- [ ] Seminar: pick a hall, scan; re-scan in another hall → 🔁 switch.
- [ ] Check-out: scan → "收回房卡"; bus-return person → reminder line.
- [ ] Dashboard: 未上车 / 未领房卡 / 未还房卡 lists shrink as you scan.
- [ ] Time window: set Schedule "Enforce = Y", scan outside time → blocked + "仍然记录" override.
      (Set it back to **N** for free testing — today is outside the Aug windows.)
- [ ] Info QR: scan a tag with the **normal phone camera** → opens the schedule page.

## 2. Concurrency / lock test (the "will it jam?" test)
Each scan briefly **locks** the sheet (needed for correct room assignment + dup detection),
so writes are serialized. Run the load tester from your machine (Node 18+):
```bash
node tools/loadtest.js <execURL> <passcode> <concurrency> <total> <checkpointKey>
```
- **Realistic** (4 lanes): `... 4 280 theme1` — expect low latency, ~0 BUSY.
- **Stress** (everyone at once): `... 20 280 theme1` — bursts may queue; some BUSY is normal here.
- **Room path** (heavier): `... 4 280 checkin`.

**How to read it:** your real busiest moment is ~14 scans/min. If throughput is comfortably
above that and BUSY ≈ 0 at concurrency 4–6, the camp is fine. BUSY only shows up under
artificial bursts far beyond real arrival rates.

**If it's slower than you like**, ask and I can optimize: skip the lock for simple/hall
checkpoints (only room/checkout truly need it) and avoid the full-sheet read — that multiplies
throughput. Worth doing only if the numbers above disappoint.

After any load run: **🧹 Clear ALL check-ins** to reset.
