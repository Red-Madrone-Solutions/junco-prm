# Measurements

Constants in this project that were measured rather than derived. Each entry
records the date, the plan the account was on, and the observation, because a
Cloudflare limit can change and a number with no provenance cannot be rechecked.

Reproduce any of this with the throwaway Worker in `spike/`. See plan 1, Task 0.

---

## Run of 2026-08-24

- **Account plan: Cloudflare Workers Free.** Confirmed in the dashboard; the $5
  Workers Paid tier was shown as an available upgrade, not as the current plan.
  This matters more than any other line in this file: the whole point of the
  measurement is what a stranger deploying their own instance will hit, and a
  paid-plan number would not transfer.
- Wrangler 4.125.0, `compatibility_date` 2026-08-01
- D1 database `junco-prm-spike`, region WNAM
- CPU figures read from `wrangler tail`, never from inside the Worker: `Date.now()`
  is frozen between I/O in Workers, so a compute loop cannot time itself.

### Question 1: does a `db.batch()` of N statements spend N queries or one?

**Answer: not N.** Every size tested succeeded, well past the printed cap.

| statements | outcome | CPU (ms) |
|---:|---|---:|
| 49 | ok | 0 |
| 50 | ok | 2 |
| 60 | ok | 3 |
| 200 | ok | 1 |
| 500 | ok | 3 |

Each size was run in its own invocation, twice, and the second run is reported -
the first invocation after a deploy pays cold-start cost that is not part of the
answer.

**Consequence: the withdrawn derivation was wrong in the direction that mattered,
and the D1 query budget does not bound an import chunk.** Cloudflare's Workers
limits page lists 50 external subrequests against 1,000 to internal services, and
D1 is an internal service; D1's own limits page prints 50 queries per invocation.
The observation matches the first reading. 500 statements inside one `batch()`
went through with 3 ms of CPU and no error.

**Still true and still binding: 100 bound parameters per statement.**
`roster_entries` has 16 columns, so `UPSERT_ROWS_PER_STATEMENT` stays at 6. That
figure was never in question and is unaffected.

### Question 2: how much CPU does one roster row cost?

**Answer: ~0.033 ms.** And the limit it was being measured against does not
exist as documented.

Each row is normalized field by field, canonicalized twice, and hashed twice -
once over the identity subset for `external_row_key`, once over the whole row for
`content_hash` - against a row carrying a 400-character bio.

| rows | CPU (ms) | wall (ms) | ms/row |
|---:|---:|---:|---:|
| 10 | 2 | 3 | - |
| 25 | 1 | 2 | - |
| 50 | 5 | 6 | - |
| 100 | 18 | 26 | - |
| 150 | 11 | 13 | - |
| 300 | 11 | 12 | - |
| 600 | 25 | 27 | 0.042 |
| 1200 | 45 | 49 | 0.038 |
| 2500 | 84 | 86 | 0.034 |
| 5000 | 163 | 168 | 0.033 |

The small sizes are noise: V8 has not warmed up, and `wrangler tail` reports CPU
as whole milliseconds, so anything under ~50 rows is below the resolution of the
instrument. The three largest samples agree closely and are the trustworthy ones.

**THE SPEC'S 10 ms FREE-PLAN CPU LIMIT IS STALE.** A 5000-row invocation spent
**163 ms of CPU and completed**, on a free account. No ceiling was found; the
probe stops at 5000 because that is where the spike's input validation caps it,
not because anything failed. Two smaller runs had already exceeded 10 ms without
being killed, so this is not a boundary effect.

**Consequence: nothing on the platform bounds the import chunk any more.** At
0.033 ms/row, a 150-row chunk costs about 5 ms of CPU and 25 upsert statements -
both of which the measurements above show are far inside what a free invocation
survives. Even 500 rows would be ~17 ms and 84 statements.

### Question 3: is the `[[ratelimits]]` binding available on a free plan?

**Answer: yes.**

The binding was declared in `spike/wrangler.jsonc`, `wrangler deploy` accepted it
and listed it - `env.SPIKE_LIMIT (100 requests/60s)  Rate Limit` - and it is
present and functional at runtime:

```json
{ "question": "ratelimit binding", "bound": true, "first_call_success": true }
```

**`RATE_LIMIT_STRATEGY = "binding"`.** Plan 2 Task 8 builds the Workers
rate-limiting binding, not the KV token-bucket fallback. The reviewer who
believed it was paid-only and would fail the deploy was mistaken.

Note for anyone re-running this: a local `wrangler dev` reports `bound: true`
regardless, because Miniflare simulates the binding. Only a remote deploy answers
this question.

---

## Constants this run set

| Constant | Value | Bounded by |
|---|---|---|
| `IMPORT_BATCH_LIMIT` | 150 | **Not the platform.** See below. |
| `UPSERT_ROWS_PER_STATEMENT` | 6 | 100 bound parameters ÷ 16 columns. Unchanged. |
| `KEY_LOOKUP_CHUNK` | 99 | The same parameter cap. Unchanged. |
| `RATE_LIMIT_STRATEGY` | `"binding"` | Question 3. |

**`IMPORT_BATCH_LIMIT` keeps its value and loses its justification.** It was
always 150, first as a derivation from the D1 query budget and then as a
placeholder pending this measurement. Both platform limits it was meant to
respect turn out not to bind at any chunk size this protocol would use.

What bounds it now is **the model, not the runtime**: a chunk is roster rows a
language model has to emit as JSON in a single tool call, at roughly 50 to 100
tokens per row. 150 rows is 7,500 to 15,000 tokens of tool input, which is a
sensible amount to ask a model to produce in one call and to re-produce if the
call has to be retried. 500 rows would be 25,000 to 50,000, which is not.

That is a real constraint and worth stating plainly, but it is a judgment about
model behavior rather than a measured platform limit, and this file should not
pretend otherwise. The number is unchanged; the reason it is that number is
entirely different, and a future reader raising it should be arguing about tool
call size rather than about Cloudflare.

---

## What was NOT established

- **The actual free-plan CPU ceiling.** The probe found no failure up to 163 ms
  and stopped there. Someone who needs the real number should raise the spike's
  input cap above 5000 and keep going.
- **Whether any of this holds on a different account or region.** One account,
  one D1 region (WNAM), one day.
- **Whether `batch()` has an upper bound on statement count at all.** 500 worked.
  Larger was not tried, because no plausible chunk needs it.
