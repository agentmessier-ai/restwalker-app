# 5h Cap Prediction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture `five_hour_resets_at` from the Anthropic API and add a 5th prediction card to the UI that shows whether the user will hit the 5h hard cap (100%) before the window resets.

**Architecture:** The Anthropic API already returns `five_hour.resets_at` but the current code drops it. We thread it through the data pipeline (API → UsageData → DB snapshot → /status endpoint) and use it in the frontend's existing `renderPredictions()` function to compute a reset-aware prediction. No new endpoints, no new MCP tools.

**Tech Stack:** TypeScript/Node.js (Fastify, Drizzle ORM, better-sqlite3), vanilla JS frontend (Chart.js), SQLite.

## Global Constraints

- No new API endpoints or MCP tools
- Follow existing migration pattern: `ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info()` check
- Frontend uses vanilla JS — no build step, edit `index.html` directly
- All timestamps stored as ISO 8601 strings (`TEXT` column, UTC)
- Column `five_hour_resets_at` is nullable (file-fallback source has no reset time)

---

## File Map

| File | Change |
|---|---|
| `node/scheduler.ts` | Add `five_hour_resets_at: string \| null` to `UsageData`; populate from `fiveH.resets_at` in `fetchUsageFromApi()` |
| `node/schema.ts` | Add `five_hour_resets_at` column to `usageSnapshots` Drizzle table definition |
| `node/db/snapshots.ts` | Update `Snapshot` type, `recordSnapshot()` signature, pass-through in `usageHistory()` bucket (no change needed there — it doesn't select this column) |
| `node/db/migrate.ts` | Add `ALTER TABLE usage_snapshots ADD COLUMN five_hour_resets_at TEXT` guarded by PRAGMA check |
| `node/routes/usage.ts` | Add `five_hour_resets_at` to `/status` response schema and body; pass new arg to `recordSnapshot()` in `/sync` and `doSync()` |
| `index.html` | In `renderPredictions()`: add 5th card with reset-aware logic; add `fmtTime()` helper for "at HH:MM TZ" formatting |

---

### Task 1: Thread `five_hour_resets_at` through the data layer

**Files:**
- Modify: `node/scheduler.ts`
- Modify: `node/schema.ts`
- Modify: `node/db/snapshots.ts`
- Modify: `node/db/migrate.ts`

**Interfaces:**
- Produces: `UsageData.five_hour_resets_at: string | null` (ISO 8601 string or null)
- Produces: `recordSnapshot(fiveHourPct, weeklyPct, weeklyResetsAt, fiveHourResetsAt)` (4-arg signature)
- Produces: `Snapshot.five_hour_resets_at: string | null`

- [ ] **Step 1: Add `five_hour_resets_at` to `UsageData` in `scheduler.ts`**

In `node/scheduler.ts`, update the `UsageData` interface and `fetchUsageFromApi()`:

```typescript
// UsageData interface — add one field:
export interface UsageData {
  five_hour_pct:      number
  weekly_pct:         number
  weekly_resets_at:   string | null
  five_hour_resets_at:string | null   // <-- ADD THIS
  age_s:              number
  stale:              boolean
  source:             'api' | 'file'
}
```

In `fetchUsageFromApi()`, populate the new field (the file-fallback doesn't have this, so it stays null there):

```typescript
// Inside fetchUsageFromApi(), update the return object:
return {
  five_hour_pct:       fiveH.utilization,
  weekly_pct:          sevenD.utilization,
  weekly_resets_at:    sevenD.resets_at ?? null,
  five_hour_resets_at: fiveH.resets_at  ?? null,   // <-- ADD THIS
  age_s:               0,
  stale:               false,
  source:              'api',
}
```

In `readUsageFromFile()`, add the field as null (file format has no reset time):

```typescript
return {
  five_hour_pct:       fiveHPct,
  weekly_pct:          weeklyPct,
  weekly_resets_at:    resetsEpoch ? new Date(resetsEpoch * 1000).toISOString() : null,
  five_hour_resets_at: null,   // <-- ADD THIS
  age_s:               ageS,
  stale:               ageS > cacheStaleS,
  source:              'file',
}
```

- [ ] **Step 2: Add column to Drizzle schema in `node/schema.ts`**

```typescript
// In the usageSnapshots table definition, add after weekly_resets_at:
export const usageSnapshots = sqliteTable('usage_snapshots', {
  id:                 integer('id').primaryKey({ autoIncrement: true }),
  five_hour_pct:      real('five_hour_pct').notNull(),
  weekly_pct:         real('weekly_pct').notNull(),
  weekly_resets_at:   text('weekly_resets_at'),
  five_hour_resets_at:text('five_hour_resets_at'),   // <-- ADD THIS
  recorded_at:        text('recorded_at').notNull().default(NOW),
})
```

- [ ] **Step 3: Update `Snapshot` type and `recordSnapshot()` in `node/db/snapshots.ts`**

```typescript
// Update Snapshot interface:
export interface Snapshot {
  id:                  number
  five_hour_pct:       number
  weekly_pct:          number
  weekly_resets_at:    string | null
  five_hour_resets_at: string | null   // <-- ADD THIS
  recorded_at:         string
}

// Update recordSnapshot signature:
export function recordSnapshot(
  fiveHourPct:       number,
  weeklyPct:         number,
  weeklyResetsAt:    string | null,
  fiveHourResetsAt:  string | null,   // <-- ADD THIS
): void {
  db.insert(schema.usageSnapshots)
    .values({
      five_hour_pct:       fiveHourPct,
      weekly_pct:          weeklyPct,
      weekly_resets_at:    weeklyResetsAt,
      five_hour_resets_at: fiveHourResetsAt,   // <-- ADD THIS
    })
    .run()
}
```

- [ ] **Step 4: Add DB migration in `node/db/migrate.ts`**

After the existing `usage_snapshots` column migration block (near the bottom of `migrate()`), add:

```typescript
// After the existing taskCols / providerCols migration blocks, add:
const snapCols = (client.prepare('PRAGMA table_info(usage_snapshots)').all() as { name: string }[]).map(c => c.name)
if (snapCols.length && !snapCols.includes('five_hour_resets_at')) {
  client.exec('ALTER TABLE usage_snapshots ADD COLUMN five_hour_resets_at TEXT')
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/yibeihe/dev/restwalker/node && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/yibeihe/dev/restwalker
git add node/scheduler.ts node/schema.ts node/db/snapshots.ts node/db/migrate.ts
git commit -m "feat: capture five_hour_resets_at from Anthropic API through data layer"
```

---

### Task 2: Surface `five_hour_resets_at` in `/status` endpoint

**Files:**
- Modify: `node/routes/usage.ts`

**Interfaces:**
- Consumes: `recordSnapshot(fiveHourPct, weeklyPct, weeklyResetsAt, fiveHourResetsAt)` (4-arg, from Task 1)
- Consumes: `UsageData.five_hour_resets_at: string | null` (from Task 1)
- Produces: `/status` response includes `usage.five_hour_resets_at: string | null`

- [ ] **Step 1: Update `doSync()` call to `recordSnapshot()` in `node/routes/usage.ts`**

`doSync()` currently calls `db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at)`. Update both call sites (in `doSync()` and in the `/sync` POST handler) to pass the 4th arg:

```typescript
// doSync() — line ~10:
db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at, usage.five_hour_resets_at)

// /sync POST handler — line ~29:
db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at, usage.five_hour_resets_at)
```

- [ ] **Step 2: Add `five_hour_resets_at` to the `/status` response schema**

In the `/status` GET route's `response` schema (around line 73 in the current file), inside the `usage` properties object, add:

```typescript
// Inside usage.properties:
five_hour_resets_at: { type: 'string', nullable: true },
```

- [ ] **Step 3: Add `five_hour_resets_at` to the `/status` handler body**

In the `/status` handler's return object, inside the `usage` key:

```typescript
usage: {
  five_hour_pct:       usage?.five_hour_pct       ?? null,
  weekly_pct:          usage?.weekly_pct           ?? null,
  weekly_resets_at:    usage?.weekly_resets_at     ?? null,
  five_hour_resets_at: usage?.five_hour_resets_at  ?? null,   // <-- ADD THIS
  cache_age_s:         usage?.age_s != null ? Math.round(usage.age_s * 10) / 10 : null,
  stale:               usage?.stale ?? true,
  source:              usage?.source ?? null,
},
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/yibeihe/dev/restwalker/node && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Smoke-test the endpoint manually**

Start or restart the daemon, then:

```bash
curl -s http://localhost:47290/status | python3 -m json.tool | grep five_hour
```

Expected output includes both:
```
"five_hour_pct": <number>,
"five_hour_resets_at": "<ISO string or null>",
```

- [ ] **Step 6: Commit**

```bash
cd /Users/yibeihe/dev/restwalker
git add node/routes/usage.ts
git commit -m "feat: surface five_hour_resets_at in /status response"
```

---

### Task 3: Add 5th prediction card to UI

**Files:**
- Modify: `index.html` — `renderPredictions()` function (around line 973) and a new `fmtTime()` helper

**Interfaces:**
- Consumes: `status.usage.five_hour_resets_at: string | null` (from Task 2 endpoint)
- Consumes: `hoursUntil(cur, target, slope)` — existing helper (returns null if slope ≤ 0, 0 if already at target, hours as number otherwise)
- Consumes: `fmtHours(h)` — existing helper
- Consumes: `tzAbbr(tz)` — existing helper
- Consumes: `tz` — existing global var (user's configured timezone string)

- [ ] **Step 1: Add `fmtTime()` helper just before `renderPredictions()`**

Find the line `// ── Predictions ──` (around line 971) and add the helper above it:

```javascript
function fmtTime(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: tz,
  }) + ' ' + tzAbbr(tz);
}
```

- [ ] **Step 2: Update `renderPredictions()` to add the 5th card**

The function currently reads `fiveH`, `weekly`, `resets`, `t5`, etc. Add `fiveHResets` from the status object and compute the new card value.

Replace the entire `renderPredictions` function body as follows (keeping the existing 4 items array intact and adding a 5th):

```javascript
function renderPredictions(status, history) {
  const el  = document.getElementById('predictions');
  const thr = status.thresholds || {};
  const fiveH       = status.usage?.five_hour_pct;
  const weekly      = status.usage?.weekly_pct;
  const resets      = status.usage?.weekly_resets_at;
  const fiveHResets = status.usage?.five_hour_resets_at;   // <-- ADD
  const t5 = thr.five_hour_pause_pct  ?? 75;
  const tw = thr.weekly_reserve_pct   ?? 35;
  const ts = thr.weekly_hard_stop_pct ?? 90;

  const cutoff = Date.now() - 6*3600000;
  const recent = history.filter(h => new Date(h.bucket).getTime() > cutoff);
  const s5  = slope(recent.map(h=>({x:new Date(h.bucket).getTime(), y:h.five_hour_pct})));
  const sWk = slope(recent.map(h=>({x:new Date(h.bucket).getTime(), y:h.weekly_pct})));

  const h5   = hoursUntil(fiveH,  t5,       s5);
  const hw   = hoursUntil(weekly, 100-tw,   sWk);
  const hws  = hoursUntil(weekly, ts,       sWk);

  // 5th card: will we hit the hard cap (100%) before the window resets?
  const hCap      = hoursUntil(fiveH, 100, s5);   // hours until 5h hits 100%
  const resetMs   = fiveHResets ? new Date(fiveHResets).getTime() : null;
  const hoursToReset = resetMs ? (resetMs - Date.now()) / 3600000 : null;
  let capValue, capCls;
  if (fiveH >= 100) {
    capValue = 'At cap';
    capCls = 'red';
  } else if (hCap === null && hoursToReset !== null) {
    // Slope flat/falling — won't hit cap
    capValue = `won't hit · resets ${fmtTime(fiveHResets)}`;
    capCls = 'green';
  } else if (hCap !== null && hoursToReset !== null && hoursToReset < hCap) {
    // Reset comes before cap
    capValue = `won't hit · resets ${fmtTime(fiveHResets)}`;
    capCls = 'green';
  } else if (hCap !== null) {
    const capAt = new Date(Date.now() + hCap * 3600000);
    capValue = `in ~${fmtHours(hCap)} (${fmtTime(capAt.toISOString())})`;
    capCls = hCap < 2 ? 'red' : hCap < 4 ? 'amber' : 'green';
  } else {
    capValue = `${Math.round(fiveH ?? 0)}% — healthy`;
    capCls = 'green';
  }

  const resetStr = resets ? new Date(resets).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:tz})+' '+tzAbbr(tz) : '—';

  const items = [
    { icon:'⏱', title:`5h hits pause (${t5}%)`,       value: h5===0?'Already paused':h5?'in ~'+fmtHours(h5):`${Math.round(fiveH??0)}% — healthy`,  cls: h5===0?'red':h5&&h5<2?'amber':'green' },
    { icon:'🔴', title:'5h hits cap (100%)',            value: capValue, cls: capCls },
    { icon:'📅', title:`Weekly hits pause (${100-tw}%)`, value: hw===0?'Already paused':hw?'in ~'+fmtHours(hw):`${Math.round(weekly??0)}% — healthy`, cls: hw===0?'red':hw&&hw<12?'amber':'green' },
    { icon:'🛑', title:`Weekly hard stop (${ts}%)`,     value: hws===0?'Already stopped':hws?'in ~'+fmtHours(hws):`${Math.round(weekly??0)}% — safe`, cls: hws===0?'red':hws&&hws<24?'amber':'green' },
    { icon:'🔄', title:'Weekly budget resets',           value: resetStr, cls:'green' },
  ];
  el.innerHTML = items.map(i=>`
    <div class="pred-item">
      <div class="pred-icon">${i.icon}</div>
      <div><div class="pred-title">${i.title}</div><div class="pred-value ${i.cls}">${i.value}</div></div>
    </div>`).join('');
}
```

- [ ] **Step 3: Update the `.predictions` grid to accommodate 5 cards**

The current CSS is `grid-template-columns: repeat(2, 1fr)` (2-column, so 4 cards = 2 rows). 5 cards = 2 rows with 1 orphan. No change needed — CSS grid auto-flows correctly with `repeat(2, 1fr)`. Verify it looks right visually in Step 4.

- [ ] **Step 4: Open the UI and verify the 5th card renders**

```bash
open http://localhost:47290
```

Check:
- 5 prediction cards visible (5h pause, **5h hard cap**, weekly pause, weekly hard stop, weekly reset)
- "5h hits cap (100%)" card shows either "won't hit · resets HH:MM TZ" or "in ~Xh (HH:MM TZ)"
- Color matches severity (green / amber / red)
- When `five_hour_resets_at` is null (file-source fallback), the card gracefully shows `X% — healthy` or `in ~Xh`

- [ ] **Step 5: Commit**

```bash
cd /Users/yibeihe/dev/restwalker
git add index.html
git commit -m "feat: add 5h cap prediction card — reset-aware, shows won't-hit vs ETA"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Capture `five_hour_resets_at` from API — Task 1, `scheduler.ts`
- [x] Store in DB — Task 1, `schema.ts` + `snapshots.ts` + migration in `migrate.ts`
- [x] Surface in `/status` — Task 2, `routes/usage.ts`
- [x] MCP auto-inherits (status tool returns full `/status` JSON) — no action needed
- [x] 5th prediction card with reset-aware logic — Task 3, `index.html`
- [x] "won't hit" branch when reset comes first — Task 3 Step 2
- [x] "in ~X (at T)" branch when cap comes first — Task 3 Step 2
- [x] Graceful null fallback when no `five_hour_resets_at` (file source) — Task 3 Step 2
- [x] Colors: green > 4h or won't hit, amber 2–4h, red < 2h or at cap — Task 3 Step 2

**Type consistency:**
- `recordSnapshot` 4-arg signature defined in Task 1 → used in Task 2 ✓
- `five_hour_resets_at` property name consistent across `UsageData`, `Snapshot`, response schema, and frontend ✓
- `fmtTime()` defined before it's called in `renderPredictions()` ✓
