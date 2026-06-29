#!/usr/bin/env node
/*
 * Load / concurrency test for the camp check-in API (your own Apps Script /exec).
 * Measures latency + detects lock queueing (BUSY) under load.
 *
 * USAGE (run on YOUR machine; Node 18+):
 *   node loadtest.js <execURL> <passcode> [concurrency=8] [total=280] [checkpointKey=theme1]
 *
 * Examples:
 *   node loadtest.js https://script.google.com/macros/s/XXX/exec camp2026
 *   node loadtest.js https://.../exec camp2026 20 280 theme1     # stress: 20 at once
 *   node loadtest.js https://.../exec camp2026 4 280 checkin     # 4 lanes, room check-in
 *
 * ⚠️ This writes real check-ins (force=true). Run it against a TEST COPY of the sheet,
 *    or afterwards use the Sheet menu  🧹 Clear ALL check-ins  to reset.
 */
const URL = process.argv[2], PASS = process.argv[3];
const CONC = +(process.argv[4] || 8), TOTAL = +(process.argv[5] || 280), CP = process.argv[6] || 'theme1';
if (!URL || !PASS) {
  console.error('Usage: node loadtest.js <execURL> <passcode> [concurrency=8] [total=280] [checkpointKey=theme1]');
  process.exit(1);
}
const id = i => 'C' + String((i % TOTAL) + 1).padStart(3, '0');

async function one(i) {
  const body = JSON.stringify({ action: 'scan', pass: PASS, payload: id(i), checkpointKey: CP,
                                hall: 'Jade Main Hall', organiser: 'loadtest', force: true });
  const t = Date.now();
  try {
    const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
    const j = await r.json().catch(() => ({}));
    return { ms: Date.now() - t, ok: !!j.ok, err: j.error || (r.ok ? null : 'HTTP' + r.status) };
  } catch (e) { return { ms: Date.now() - t, ok: false, err: 'NETWORK' }; }
}

(async () => {
  console.log(`\nFiring ${TOTAL} requests · concurrency ${CONC} · checkpoint "${CP}"`);
  const results = []; let next = 0;
  const start = Date.now();
  async function worker() { while (next < TOTAL) { const i = next++; results.push(await one(i)); process.stdout.write('.'); } }
  await Promise.all(Array.from({ length: CONC }, worker));
  const wall = (Date.now() - start) / 1000;
  const lat = results.map(r => r.ms).sort((a, b) => a - b);
  const pct = q => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
  const ok = results.filter(r => r.ok).length;
  const busy = results.filter(r => r.err === 'BUSY').length;
  const errs = {};
  results.filter(r => !r.ok).forEach(r => { errs[r.err] = (errs[r.err] || 0) + 1; });
  console.log('\n\n──────── results ────────');
  console.log(`wall time : ${wall.toFixed(1)}s`);
  console.log(`throughput: ${(TOTAL / wall).toFixed(1)}/s  (${Math.round(TOTAL / wall * 60)}/min)`);
  console.log(`latency ms: p50 ${pct(.5)} · p90 ${pct(.9)} · p95 ${pct(.95)} · max ${lat[lat.length - 1]}`);
  console.log(`ok: ${ok} · BUSY (lock queue): ${busy} · other errors: ${TOTAL - ok - busy}`);
  if (Object.keys(errs).length) console.log('errors:', errs);
  console.log('\nReading: real arrival is ~14/min at your busiest. If throughput here is well');
  console.log('above that and BUSY is low, you are fine. High BUSY only appears under synthetic bursts.');
})();
