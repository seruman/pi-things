---
name: sumocli
description: Query Sumo Logic operational logs from the command line using sumocli. Use when the user asks to search Sumo logs, find production errors, count events by field, investigate a service/pod/host, or otherwise read data from Sumo Logic. Covers query syntax basics, time ranges, result modes (messages vs aggregation records), and output formats suitable for jq/awk/duckdb.
---

# sumocli

`sumocli` is a small Go CLI that wraps the Sumo Logic Search Job API. It is
read-only: create job → poll → paginate results → delete job. No tenancy
management, no mutations.

## Core command

```
sumocli query '<query>' [flags]
```

Exit code is non-zero on any error. The job ID is written to stderr on
stdout-clean runs, e.g. `search job 4070B2C30BAE2884`.

### Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--from` | `-15m` | `now`, relative (`-15m`, `-1h30m`, `-7d`, `-1w`), or RFC3339 (`2025-04-16T08:30:00Z`) |
| `--to` | `now` | same formats |
| `--limit` | `1000` | `0` = no limit (API cap is 100k messages) |
| `--mode` | `auto` | `auto`, `messages`, or `records` |
| `-o`, `--output` | `ndjson` | `ndjson`, `json`, or `tsv` |
| `--poll-interval` | `1s` | initial poll; backs off to 5s |
| `--by-receipt-time` | `false` | search by receipt time instead of message time |
| `--no-header` | `false` | omit header row in tsv output |

## Always write results to a file first

Log results can be huge (tens of thousands of rows, many MB). Dumping raw
results into the conversation burns context and often truncates. **Always
redirect `sumocli` output to a file, then inspect it with targeted tools
(`jq`, `rg`, `wc`, `head`, `duckdb`).** Do not dump raw unfiltered
`sumocli` output into the conversation; filtered or aggregated output is fine.

Use a predictable scratch location so files can be cleaned up later:

```bash
mkdir -p /tmp/sumocli
out=/tmp/sumocli/$(date +%s).ndjson

sumocli query 'cluster=prod error' --from=-1h --limit 10000 > "$out"
wc -l "$out"                                   # how many rows
jq -r '._raw' "$out" | head -50                # peek
jq -r '[._messagetime, ._sourcehost, ._raw] | @tsv' "$out" | rg -i timeout
```

The job ID is written to stderr, so redirecting stdout does not hide it:

```bash
sumocli query '...' --from=-15m > "$out"       # job id still visible on stderr
```

### Analyse ndjson with duckdb

For anything beyond simple filtering — grouping, joins, windowed counts,
percentiles — use duckdb against the ndjson file. It reads ndjson natively
and is far faster and less error-prone than long `jq` pipelines.

```bash
duckdb -c "
  select _sourcehost, count(*) n
  from read_json_auto('$out', format='newline_delimited')
  group by 1 order by n desc limit 20;
"
```

For a one-off filtered export, create a temporary table in the same command:

```bash
duckdb -c "
  create temp table logs as
    select * from read_json_auto('$out', format='newline_delimited');
  select _messagetime, _sourcehost, _raw
  from logs
  where lower(_raw) like '%timeout%'
  limit 50;
"
```

For aggregations (records mode), result sets are almost always small and
can be read in full:

```bash
sumocli query 'cluster=prod | count by pod' --from=-1h > /tmp/sumocli/by_pod.ndjson
cat /tmp/sumocli/by_pod.ndjson | jq -r '[._count, .pod] | @tsv' | sort -rn
```

## Prefer ndjson when piping

`ndjson` (default) writes one JSON object per line — best for `jq`, `awk`,
`duckdb`, streaming, and for feeding results into other tools. Keep it as
the default.

Use `--output json` only for small results where a single pretty array is
more convenient. Use `--output tsv` when piping into `column`, `sort`, or
spreadsheets.

## Start narrow, then widen

When investigating, start with a small `--limit` and a short `--from`
window to validate the query shape cheaply, then widen once the query is
known to be correct.

```bash
# 1. sanity check — 50 rows, last 5 minutes
sumocli query '_sourceCategory=prod/api error' --from=-5m --limit 50 \
  > /tmp/sumocli/probe.ndjson

# 2. if the shape looks right, widen
sumocli query '_sourceCategory=prod/api error' --from=-1h --limit 10000 \
  > /tmp/sumocli/full.ndjson
```

## Messages vs records — what `--mode auto` does

Sumo has two result shapes:

- **Messages** — raw log rows. Produced by non-aggregation queries.
- **Records** — aggregation output (from `| count by ...`, `| sum ...`, etc.).

`--mode auto` (default) picks records when the job's `recordCount > 0`,
otherwise messages. Force with `--mode messages` or `--mode records` if the
heuristic picks the wrong one (e.g. for queries that produce both but you
only want one shape).

**Rule of thumb**: if the query contains a `|` followed by an aggregation
operator (`count`, `sum`, `avg`, `min`, `max`, `pct`, `stddev`), expect
records.

## Query syntax crib sheet

Sumo queries use keyword search up front, then `|` to pipe through operators.

```
# keyword/boolean
cluster=prod and error and not _sourceCategory=healthz

# field equality comes from metadata or parsed fields
_sourceHost=web-01 _sourceCategory=prod/nginx

# parse, then filter, then aggregate
_sourceCategory=prod/api
| parse "status=*" as status
| where status >= 500
| count by status, _sourceHost

# time series
_sourceCategory=prod/api error
| timeslice 1m
| count by _timeslice

# top N
_sourceCategory=prod/api
| count by pod
| top 10 pod by _count
```

Values containing spaces or special characters must be double-quoted:
`"skc-mysql-toyblast-20260410103157"`.

## Time ranges

All times are UTC. Two formats are accepted:

- **Relative**: `now`, `-15m`, `-1h30m`, `-7d`, `-1w`, `-2d6h` — units `s m h d w`.
- **RFC3339**: `2025-04-16T08:30:00Z`, `2025-04-16T10:30:00+02:00` (converted to UTC).

Naive ISO (`2025-04-16T08:30:00`), date-only, and epoch timestamps are **not**
accepted; they fail with a clear error. If you have an epoch timestamp, convert
first:

```bash
sumocli query '...' --from="$(date -u -r 1744804800 -Iseconds)"
```

Default window is `-15m` to `now`. Common patterns:

```bash
# last hour of errors
sumocli query '_sourceCategory=prod/api error' --from=-1h

# a specific window (UTC)
sumocli query '...' --from=2025-04-16T08:00:00Z --to=2025-04-16T09:00:00Z
```

Note: values starting with `-` must use `=` (e.g. `--from=-1h`, not `--from -1h`),
otherwise kong's flag parser treats the value as a missing argument.

## Patterns

All examples write to `/tmp/sumocli/*.ndjson` first, then inspect.

### Count something by a field

```bash
sumocli query 'cluster=prod | count by _sourceHost' --from=-1h \
  > /tmp/sumocli/hosts.ndjson
jq -r '[._count, ._sourcehost] | @tsv' /tmp/sumocli/hosts.ndjson | sort -rn | head
```

### Find recent errors in a service

```bash
sumocli query '_sourceCategory=prod/api (error or exception)' \
  --from=-30m --limit 200 \
  > /tmp/sumocli/errors.ndjson
wc -l /tmp/sumocli/errors.ndjson
jq -r '[._messagetime, ._sourcehost, ._raw] | @tsv' /tmp/sumocli/errors.ndjson \
  | head -50
```

### Trace a specific identifier

```bash
sumocli query '"req-abc-123"' --from=-6h --limit 100 \
  > /tmp/sumocli/trace.ndjson
jq -r '._raw' /tmp/sumocli/trace.ndjson
```

### Histogram-like time series

```bash
sumocli query '_sourceCategory=prod/api error | timeslice 5m | count by _timeslice' \
  --from=-6h --mode records -o tsv \
  > /tmp/sumocli/timeseries.tsv
cat /tmp/sumocli/timeseries.tsv
```

### Group and rank with duckdb

```bash
sumocli query '_sourceCategory=prod/api error' --from=-1h --limit 10000 \
  > /tmp/sumocli/errs.ndjson

duckdb -c "
  select _sourcehost, count(*) n
  from read_json_auto('/tmp/sumocli/errs.ndjson', format='newline_delimited')
  group by 1 order by n desc limit 20;
"
```

## Gotchas

- **Rate limits**: 4 req/s per user, 10 concurrent requests per access key,
  200 concurrent search jobs per org. If a burst errors with `HTTP 429`,
  wait and retry.
- **100k message cap**: non-aggregate queries cannot return more than 100k
  messages. For bigger result sets, split the time range or aggregate.
- **State `FORCE PAUSED`** means the 100k cap was hit — `sumocli` treats it
  as "done" and fetches what's available.
- **Ctrl-C cleans up**: the CLI always deletes the job on exit, including
  on signal. No manual cleanup needed.
- **Timestamps are strings**: all fields in `ndjson` output (including
  `_messagetime`, `_size`, etc.) are returned as strings by the API. Coerce
  with `jq 'tonumber'` or duckdb `CAST(... AS BIGINT)` if needed.
- **Field names are lowercase** in results, regardless of how they appear
  in queries (`_sourceHost` in the query → `_sourcehost` in output).

## Failure triage

| Symptom | Likely cause |
| --- | --- |
| `HTTP 400 parse.error` | Query syntax error — fix the query |
| `HTTP 400 invalid.timestamp.from/to` | Bad time; use relative (`-1h`) or RFC3339 |
| `HTTP 404 jobid.invalid` on follow-up | Job was cancelled (inactivity or Ctrl-C); rerun the query |
| `HTTP 429 rate.limit.exceeded` | Too many requests or jobs; back off and retry |

## When not to use this

- **Live tailing**: `sumocli` does not stream. For `tail -f`-style streaming,
  use Sumo's separate `livetail-cli`.
- **Tenancy changes** (collectors, monitors, users, dashboards): out of scope.
  Use the Sumo UI or the Sumo Logic Terraform provider.
