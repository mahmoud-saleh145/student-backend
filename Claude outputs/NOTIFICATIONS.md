# Announcements

Phase 4. Targeted, scheduled, recurring broadcasts.

Phases 1–3 dealt with money. This one deals with something that cannot be
refunded: a push notification, once delivered, cannot be edited, recalled or
apologised for. Nearly every design decision below follows from that.

## What was already there

The inbox and push split predates this phase and is unchanged. A notification
row is written synchronously and the push is queued afterwards, so a Redis
outage loses the buzz and never the message. Preferences are applied at send
time in `push.processor.ts`, absent preferences default to enabled, and security
and administrative messages are never suppressed by one.

What did not exist: any targeting beyond three nullable columns, any scheduler
at all, and any notion of recurrence. `publishNow: false` wrote a draft that
nothing would ever publish.

## The audience is a rule, not a list

Stored on the announcement, re-evaluated on every send.

```
within a dimension  →  OR    (year 2 OR year 3)
across dimensions   →  AND   (year 2-or-3 AND pharmacy AND enrolled)
exclusions          →  removed last, unconditionally
```

A weekly reminder aimed at second-year pharmacy students reaches whoever is a
second-year pharmacy student *that week*. Freezing the recipient list at
creation would quietly stop reaching anyone who enrolled afterwards — a
recurring message that silently narrows over months, which reads as a bug rather
than a policy.

Dimensions: university, faculty, department, academic year, course + enrollment
state, subject, role, account status, and an explicit exclusion list.

**The client never sends a filter.** It sends ids and enum members;
`compileAudience` builds the `where`. Nothing is interpolated, every id lands
inside a parameterised `in`, and deleted accounts are unreachable by any rule.

### The empty-array trap

`{ in: [] }` is valid Prisma that matches zero rows. A rule carrying
`academicYearIds: []` would compile cleanly, send to nobody, and report success
— indistinguishable from a working send, which makes it the worst failure mode
available to a broadcast system. An omitted dimension means "any"; an empty one
is refused, at the DTO and again in the compiler.

Legacy announcements are read through `ruleFromLegacyColumns`, so there is one
evaluation path rather than two and no data migration was needed.

## Scheduling stores local time, not an instant

An announcement fires at a **wall-clock time in a timezone** — 19:00 in
Africa/Cairo — not at a UTC instant. Egypt reintroduced daylight saving in 2023,
so the instant behind "19:00 Cairo" moves by an hour twice a year. Storing the
instant would drift every evening announcement to 18:00 for half the year.

Frequencies: `ONCE`, `DAILY`, `WEEKLY` (ISO weekdays), `MONTHLY` (clamped — "the
31st" means the end of every month, not eight of them). Bounded by a start date,
an end date, and a maximum occurrence count.

Cron expressions were considered and rejected. One wrong field in an admin form
sends a push to every student every minute, and there is no undo.

### The two DST edge cases, stated honestly

Egypt's transitions happen at midnight, so only a send scheduled between 00:00
and 01:00 meets them:

- **Spring forward** deletes the wall time. The send lands just past the gap
  (00:30 becomes 01:30 that day, then returns to 00:30) rather than being
  skipped.
- **Fall back** repeats it. The first is used, and the dispatch claim makes the
  second a no-op — so it fires once, not twice.

## Exactly once

The whole mechanism is one unique constraint:

```prisma
@@unique([announcementId, occurrenceAt])
```

A worker claims an occurrence by **inserting** `AnnouncementDispatch` and only
then fans out. Two workers racing on the same minute produce one send and one
`P2002`, which is treated as ordinary rather than as an error — with several
replicas, racing is the normal case.

Three consequences worth stating:

1. **The claim precedes the work.** If the send came first, a crash between the
   two would resend everything on the next tick.
2. **`occurrenceAt` is the scheduled instant**, never the time the worker
   happened to run. Two workers milliseconds apart must compute the same key.
3. **A failed fan-out keeps its claim.** Releasing it would retry next minute
   and resend to everyone already reached before the error. The error is
   recorded on the row instead, where it is visible.

`SENDING` is included in the dispatcher's selection deliberately: a worker
killed mid-fan-out leaves the row in that state, and excluding it would strand
the announcement forever. The dispatch row, not the status, is what prevents a
double send.

## Missed occurrences are skipped

The next occurrence is computed from **now**, not from the occurrence that just
fired. A worker down for three days sends once when it returns, not three times.
Three days of stale reminders arriving together is worse than the gap that
caused them.

## Preview before send

`POST /admin/announcements/preview` returns the recipient count, a sample of
names, whether the rule filters on anything at all, and whether it exceeds the
send limit. It writes nothing and enqueues nothing.

An audience builder without a dry run is how someone sends the wrong message to
eight thousand people at two in the morning. The `targetsEveryone` flag exists
because "everyone" and "a rule whose filters were dropped by a client bug" are
otherwise indistinguishable at the point of sending.

`MAX_AUDIENCE_SIZE` (50 000) is a refusal, not a warning, and the fan-out pages
at 2 000 so a large audience never becomes one enormous array or one enormous
queue payload.

## Editing is refused after the first send

The text is what people received. Editing it afterwards would make the record
disagree with every inbox holding it. Cancel and create a new one.

Cancelling stops future occurrences and touches nothing already delivered —
those notifications belong to the students who received them.

## API

All `@AdminOnly()`. A teacher can already notify their own course's students
through the course routes; reaching an arbitrary audience is a platform-wide
power and is not delegated.

| Method | Path | |
|---|---|---|
| `POST` | `/admin/announcements/preview` | dry run — count, sample, warnings |
| `GET` | `/admin/announcements` | newest first, filterable by status |
| `GET` | `/admin/announcements/:id` | with dispatch history |
| `POST` | `/admin/announcements` | create, scheduled or immediate |
| `PATCH` | `/admin/announcements/:id` | refused once sent |
| `DELETE` | `/admin/announcements/:id` | stop future occurrences |
| `POST` | `/admin/announcements/:id/send-now` | claims first, so twice sends once |

The two legacy endpoints on `NotificationsController` still work unchanged and
write the same rows.

## Scheduler

A BullMQ repeatable job every minute, registered by `MaintenanceScheduler`
alongside the existing sweeps. Repeatable rather than a decorator cron for the
reason that file already documents: with several API replicas a decorator-based
cron fires once per replica.

The job is a single indexed query when nothing is due, which is almost always.
Workers run only where `RUN_WORKERS=true`, so the API deployment schedules and
the worker deployment dispatches.

## Migration

Purely additive. The three legacy targeting columns are kept and still read when
`audienceRule` is null, so no existing announcement changed and no data was
migrated.

## Not built yet

Dashboard UI for the audience builder — which is where this feature becomes
usable, since a rule composed by hand in JSON is not something an admin will do.
The preview endpoint exists specifically to back that UI.
