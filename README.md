# DLSUD EventHub

A lightweight, browser-based campus event registration prototype for
De La Salle University–Dasmariñas, built for a 4th-year BSIT group laboratory
examination.

**Group members:** Timothy Delmoro, Justin Basilides, Aian Cuento, Calvin Bellen

> **Not an official university system.** DLSUD EventHub is a student academic
> project. It is not affiliated with, endorsed by, or connected to De La Salle
> University–Dasmariñas. Every event and every student in the database is
> sample data invented for the prototype.

---

## Contents

- [What it does](#what-it-does)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Running it locally](#running-it-locally)
- [Deploying to GitHub Pages](#deploying-to-github-pages)
- [The database](#the-database)
- [Business rules](#business-rules)
- [Testing](#testing)
- [Accessibility](#accessibility)
- [Limitations](#limitations)
- [Security disclaimer](#security-disclaimer)
- [AI usage disclosure](#ai-usage-disclosure)

---

## What it does

### For students

| Feature | Where |
|---|---|
| Browse upcoming campus events | `frontend/index.html` |
| Search by keyword (title, description, venue, category) | catalog toolbar |
| Filter by category and by upcoming / past / all | catalog toolbar |
| See remaining seats, "few seats left" and "full" states | event cards and detail page |
| Read full event details | `frontend/event.html?id=<n>` |
| Register with a DLSU-D student e-mail address | event detail page |
| Get a reference number for a confirmed seat | after registering |
| Clear validation, error and success messages | throughout |

### For administrators

| Feature | Where |
|---|---|
| Every event with capacity, registered count and remaining seats | `frontend/admin.html` |
| Summary tiles (events, confirmed, cancelled, students, seats left) | admin dashboard |
| Attendee list per event, with status | admin dashboard |
| Reset the prototype database back to the seed data | admin dashboard |

The admin page is a **demonstration** with no authentication. See
[Security disclaimer](#security-disclaimer).

---

## Technology stack

| Layer | Choice | Why |
|---|---|---|
| Markup | Vanilla HTML5 | Semantic structure, no build step |
| Styling | Vanilla CSS (one file, ~23 KB) | Custom properties are enough; no framework needed |
| Behaviour | Vanilla JavaScript (5 small modules) | No framework, no bundler, no transpiler |
| Database | SQLite via [sql.js](https://sql.js.org) 1.13.0 (WebAssembly) | Real SQL, real constraints, runs with no server |
| Persistence | `localStorage` snapshot of the SQLite file | Survives a reload without a backend |
| Backend exercise | C# (.NET 8) + `Microsoft.Data.Sqlite` | The examination's secure-data-access deliverable |
| Unit tests | xUnit + Moq (C#), `node:test` (JavaScript) | Business rules tested without a database |
| Hosting | GitHub Pages | Static, free, no server to maintain |

**Deliberately not used:** React, Next.js, Laravel, Express, any Node backend,
MySQL, PostgreSQL, Firebase, Supabase, Redux, any state-management library,
any authentication provider, any CSS framework, any bundler. The project has
**zero runtime dependencies** beyond the vendored `sql-wasm.js` /
`sql-wasm.wasm` files, which are committed to the repository so the site works
offline and without a CDN.

---

## Architecture

GitHub Pages serves static files only. It cannot run a server-side database or
a C# process. The project therefore has **two separate deliverables**, and the
distinction matters:

### 1. The public prototype — what the website actually runs

```
 Browser
 ┌──────────────────────────────────────────────────────────────┐
 │  index.html / event.html / admin.html                        │
 │        │                                                     │
 │        ├── css/styles.css                                    │
 │        │                                                     │
 │        ├── js/validation.js    pure field rules (no DOM/SQL) │
 │        ├── js/registration.js  pure seat + duplicate rules   │
 │        ├── js/database.js      SQLite via sql.js, bound params│
 │        ├── js/events.js        event queries + rendering      │
 │        └── js/app.js           page wiring, forms, errors     │
 │                     │                                        │
 │                     ▼                                        │
 │        SQLite (WebAssembly)  ◄── database/schema.sql          │
 │                              ◄── database/seed.sql            │
 │                     │                                        │
 │                     ▼                                        │
 │        localStorage snapshot (so a reload keeps your seat)    │
 └──────────────────────────────────────────────────────────────┘
          No network calls. No server. No data leaves the browser.
```

On first load the page fetches `database/schema.sql` and `database/seed.sql`,
executes them against an in-memory SQLite database compiled to WebAssembly,
and exports the resulting database file into `localStorage`. On later visits
the snapshot is restored instead, so registrations persist. If the snapshot is
missing, unreadable or built by an older schema version, it is discarded and
the database is rebuilt from the SQL files.

### 2. The examination's backend exercise — not used by the website

`backend/RegistrationService.cs` is the secure refactor required by Task 4. It
shows the same business rules implemented against a real server-side SQLite
database with parameterised SQL, deterministic resource disposal and null-safe
result handling. **The GitHub Pages frontend does not call it**, and it is not
needed to run or mark the website. It is compiled and tested on its own with
`dotnet test`.

### Why the rules are written twice

The seat, duplicate and e-mail rules exist in three places on purpose, as
layers of defence:

| Layer | File | Purpose |
|---|---|---|
| UI / client | `frontend/js/validation.js`, `frontend/js/registration.js` | Fast, specific feedback while typing |
| Server exercise | `backend/RegistrationService.cs` | How it is enforced when a server exists |
| Database | `database/schema.sql` (`CHECK`, `UNIQUE`, FKs) | Last line of defence — cannot be bypassed by any client |

If you change a rule, change it in all three. The JavaScript test suite
(`tests/validation.test.mjs`) and the xUnit suite
(`tests/RegistrationServiceTests.cs`) assert the same cases against both
implementations so they cannot drift apart silently.

---

## Repository layout

```
dlsud-eventhub/
├── index.html                      GitHub Pages entry point (forwards to frontend/)
├── .nojekyll                       serve files as-is, no Jekyll processing
├── frontend/
│   ├── index.html                  event catalog (hero, search, filters, cards)
│   ├── event.html                  event detail + registration form
│   ├── admin.html                  prototype admin dashboard
│   ├── css/styles.css              the entire stylesheet
│   ├── js/
│   │   ├── validation.js           pure field rules, unit tested
│   │   ├── registration.js         pure seat/duplicate rules, unit tested
│   │   ├── database.js             sql.js bootstrap, parameter-bound queries
│   │   ├── events.js               event queries + safe DOM rendering
│   │   └── app.js                  page controllers, forms, error handling
│   └── vendor/
│       ├── sql-wasm.js             sql.js 1.13.0 (vendored, MIT)
│       ├── sql-wasm.wasm           SQLite compiled to WebAssembly
│       └── LICENSE-sql.js
├── database/
│   ├── schema.sql                  tables, keys, constraints, indexes, view
│   └── seed.sql                    sample departments, events, students, registrations
├── backend/
│   ├── RegistrationService.cs      Task 4: secure refactor (not used by the site)
│   └── DlsudEventHub.Backend.csproj
├── tests/
│   ├── RegistrationServiceTests.cs Task 4: xUnit tests with Moq
│   ├── DlsudEventHub.Tests.csproj
│   ├── validation.test.mjs         node:test suite for the frontend rules
│   └── browser-checks.mjs          optional end-to-end browser checks
├── README.md
└── SUBMISSION.md                   examination write-up (Tasks 1–5, ERD, verification log)
```

---

## Running it locally

The page **must be served over `http://`**, not opened as a `file://` path:
browsers block `fetch()` of the `.sql` files and the WebAssembly binary from
the file system.

Any static server works. With Python (already installed on most machines):

```bash
git clone https://github.com/eximno/dlsud-eventhub.git
cd dlsud-eventhub
python3 -m http.server 8000
```

Then open <http://localhost:8000/> — the root page forwards to
`frontend/index.html`.

Equivalent alternatives:

```bash
npx serve .            # Node
php -S localhost:8000  # PHP
```

Serve the **repository root**, not the `frontend/` folder, because the pages
load `../database/schema.sql`. (If you must serve `frontend/` directly, copy
`database/` inside it — `database.js` tries `database/schema.sql` as a
fallback path.)

Nothing needs to be installed or built. There is no `package.json` for the
site and no compilation step.

---

## Deploying to GitHub Pages

1. Push to GitHub.
2. **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **`main`**, folder: **`/ (root)`**
3. Save, and wait for the Pages build to finish.
4. Open `https://<your-username>.github.io/dlsud-eventhub/`.

The root `index.html` forwards to `frontend/index.html`.

Why the root and not `/frontend`: the pages read
`../database/schema.sql`, which only resolves when the repository root is the
site root.

Checks that matter for Pages, all of which this repository satisfies:

- Every path is **relative** — no `localhost`, no absolute paths, no backend URL.
- Every path matches the real filename's **case**, because Pages is
  case-sensitive even when your laptop is not.
- `.nojekyll` is present, so nothing is filtered out by Jekyll.
- `sql-wasm.wasm` is committed, so no CDN is required.

---

## The database

Four tables in **third normal form**. Seat counts are never stored; they are
always derived, so no column can drift out of sync with reality.

| Table | Purpose | Key constraints |
|---|---|---|
| `departments` | DLSU-D colleges | `code` and `name` UNIQUE, `code` must be upper-case |
| `users` | students who may register | `student_id` and `email` UNIQUE; `email` must be `@dlsud.edu.ph`, lower-case, single `@`; FK to `departments` |
| `events` | campus events | `capacity > 0` and `<= 5000`; `event_date` must be exactly `YYYY-MM-DDTHH:MM`; `category` from a fixed list; `(title, event_date)` UNIQUE |
| `registrations` | who is attending what | FKs to `users` and `events` (both `ON DELETE CASCADE`); `status` in `('confirmed','cancelled')`; **`(user_id, event_id)` UNIQUE** |

Relationships:

- `departments` 1 → many `users`
- `users` 1 → many `registrations`
- `events` 1 → many `registrations`
- `registrations` resolves the many-to-many between `users` and `events`

Indexes — SQLite indexes `UNIQUE` constraints automatically but **not** plain
foreign keys, so each FK column gets one explicitly:
`idx_users_department_id`, `idx_registrations_user_id`,
`idx_registrations_event_id`, plus `idx_registrations_event_status`
(the hot "count confirmed seats for this event" query),
`idx_events_event_date` and `idx_events_category` (the catalog's ordering and
filtering).

### The `event_availability` view

```sql
SELECT e.*, COUNT(r.registration_id)                      AS confirmed_count,
            MAX(e.capacity - COUNT(r.registration_id), 0) AS remaining_seats,
            CASE WHEN COUNT(r.registration_id) >= e.capacity THEN 1 ELSE 0 END AS is_full
FROM events e
LEFT JOIN registrations r ON r.event_id = e.event_id AND r.status = 'confirmed'
GROUP BY e.event_id;
```

Everything that displays seats — cards, detail page, admin dashboard — reads
this view, so there is one definition of "seats left". `remaining_seats` is
clamped at `0`: if the data were ever corrupted so that an event had more
confirmed registrations than its capacity, the view reports `0` seats and
`is_full = 1` rather than a negative number that would re-open a full event.

### Seed data

Nine sample events, eight colleges, 112 fictitious students and 115
registrations, deliberately including:

- a **full** event (Cybersecurity Awareness Workshop, 60/60) — proves rejection at capacity
- an **almost full** event (Developer Workshop, 39/40) — proves the "last seat" state
- an **untouched** event (Campus Mental Health Forum, 0/180) — proves the
  "all seats available" card and the empty attendee list in the admin view
- a **past** event (Campus Tech Summit) — proves registration is closed
- a **cancelled** registration — proves cancelled rows are excluded from seat counts

Every UI state the application can render is reachable from the seed data; none
of them needs you to register first to be seen.

### Inspecting the SQL outside the browser

```bash
sqlite3 /tmp/eventhub.db < database/schema.sql
sqlite3 /tmp/eventhub.db < database/seed.sql
sqlite3 /tmp/eventhub.db "SELECT title, capacity, confirmed_count, remaining_seats FROM event_availability;"
```

Or, with no `sqlite3` binary installed, using Python's bundled SQLite:

```bash
python3 -c "
import sqlite3
c = sqlite3.connect(':memory:')
c.executescript(open('database/schema.sql').read())
c.executescript(open('database/seed.sql').read())
for row in c.execute('SELECT event_id, title, capacity, confirmed_count, remaining_seats FROM event_availability'):
    print(row)
"
```

---

## Business rules

### DLSU-D student e-mail

Registration requires an institutional address. The domain is compared in
full, not with a suffix match, so look-alike domains cannot slip through.

| Address | Result |
|---|---|
| `student@dlsud.edu.ph` | accepted |
| `juan.dela-cruz@dlsud.edu.ph` | accepted |
| `Student@DLSUD.edu.ph` | accepted (trimmed and lower-cased first) |
| `student@gmail.com` | rejected — not an institutional address |
| `student@dlsu.edu.ph` | rejected — DLSU Manila, not DLSU-D |
| `student@dlsud.edu` | rejected — truncated domain |
| `student@dlsud.edu.ph.fake.com` | rejected — look-alike suffix |
| `student@sub.dlsud.edu.ph` | rejected — subdomain is not the domain |
| `a@b@dlsud.edu.ph`, `@dlsud.edu.ph`, `a..b@dlsud.edu.ph` | rejected — malformed |

### Seat availability

| Capacity | Confirmed | Result |
|---|---|---|
| 100 | 99 | registration allowed (1 seat left) |
| 100 | 100 | rejected — full |
| 100 | 105 (corrupted) | rejected — reported as full, `0` seats, never negative |
| 0 or negative (corrupted) | any | rejected — invalid event, not open for registration |

### Duplicate registration

Prevented at three levels: the form reports it against the e-mail field, the
service re-checks it inside the transaction immediately before the insert, and
`UNIQUE (user_id, event_id)` makes it impossible to commit. An
already-registered student is told "already registered", never "the event is
full", even when both are true.

### Other refusals

- A **past** event is closed for registration.
- An e-mail already on file under a **different student number** is refused
  rather than overwritten, and vice versa.
- An invalid or unknown **event id** in the URL produces a "not found" page,
  not a crash.

---

## Testing

### JavaScript business rules — runs with no installation

```bash
node --test "tests/**/*.test.mjs"
```

31 tests over the rules the website actually enforces: the e-mail rule, field
rules, search clamping, event-id parsing, seat maths, and every registration
refusal. Requires only Node.js (18+). There are no dependencies to install.

### C# business rules and the secure service

```bash
dotnet test tests/DlsudEventHub.Tests.csproj
```

Requires the **.NET 8 SDK**. The suite uses xUnit with Moq, so
`RegistrationService` is exercised against a mock `IRegistrationRepository` —
no database file is needed, and the tests can assert that a refusal writes
*nothing*.

> The environment this repository was built in had no .NET SDK available, so
> `dotnet test` has **not** been executed here; the C# was reviewed by hand
> against the rules and mirrored from the JavaScript that *is* tested. Run the
> command above on a machine with the SDK before submitting.

### Optional end-to-end browser checks

```bash
npm install --no-save playwright   # one-off, not a project dependency
python3 -m http.server 8123 &
node tests/browser-checks.mjs
```

91 checks drive a real Chromium against the running site: catalog rendering,
search and filters, wildcard and SQL-ish search input, malformed catalog query
parameters, every invalid event-id form, form validation, Enter-to-submit, a
successful registration, duplicate and identity-conflict refusals, rapid repeat
clicks, persistence across a reload, the admin dashboard with its empty and
cancelled states and its reset, three mobile widths, keyboard focus order,
blocked `localStorage`, and a simulated database-initialisation failure. It
also fails if the browser console logs a single error.

### Static analysis actually run against this repository

| Tool | Result |
|---|---|
| `node --check` on every JS file | clean |
| ESLint 9 (`no-undef`, `no-unused-vars`, `eqeqeq`, `no-eval`, …) | clean |
| `html-validate` (recommended + document + a11y presets) | clean |
| `axe-core` 4.10 on all pages and states, at 1280 px and 320 px | 0 violations |
| SQLite constraint tests (negative + positive insert cases via Python's `sqlite3`) | all constraints reject invalid data |
| Playwright end-to-end checks | 91/91, no console errors |

---

## Accessibility

Built to WCAG 2.1 AA as far as a prototype reasonably can be, and verified
with `axe-core` (0 violations) plus manual keyboard testing.

- Semantic HTML: `header`, `nav`, `main`, `section`, `article`, `aside`,
  `footer`, real `table`/`th[scope]`, `dl` for key–value data, one `h1` per
  page and no skipped heading levels.
- Every form control has a real `<label>`; hints and errors are linked with
  `aria-describedby`; invalid fields get `aria-invalid="true"`.
- On submit, the first invalid field receives focus and a summary alert names
  how many fields need attention.
- Live regions announce result counts, attendee counts and status changes.
- Visible focus ring on every interactive element.
- Nothing relies on colour alone: seat state is a sentence, badges carry text,
  errors are prefixed with a warning glyph, the current page is marked with
  `aria-current` as well as colour.
- ARIA is used only where HTML has no equivalent — the table scroll areas are
  `<section tabindex="0">`, not `<div role="region">`.
- Decorative elements (the seat bar, the logo mark, icons) are
  `aria-hidden="true"` so they are not announced.
- `prefers-reduced-motion` disables the shimmer and spinner animations.
- Touch targets are at least 44 px tall.

---

## Limitations

This is a 3-hour laboratory prototype, and these are deliberate:

1. **No real authentication.** The admin page is open to anyone who opens the
   URL. It is labelled as a demonstration on the page itself.
2. **The database is local to one browser.** Two people using the site see two
   different databases. Clearing site data erases every registration.
3. **`localStorage` has a size limit.** If a quota error occurs the prototype
   keeps working in memory and says so, but changes are lost on reload.
4. **No e-mail is sent.** A reference number is shown on screen; nothing is
   delivered, and the e-mail address is never verified.
5. **No cancellation flow in the UI.** The schema supports
   `status = 'cancelled'` and the seed data contains one, so counts and the
   admin view handle it, but students cannot cancel from the prototype.
6. **The C# service is not wired to the site**, by necessity — GitHub Pages
   cannot run it.
7. **Capacity races are only partly demonstrable.** The browser is
   single-threaded, so the client cannot truly race itself; the C# repository
   shows the correct fix (capacity enforced inside the `INSERT`).
8. **Sample data only.** The events are invented and labelled "Sample campus
   event".

---

## Security disclaimer

**Browser-side SQLite is not a secure production architecture.** It is used
here because GitHub Pages is static hosting, and because the examination asks
for a browser-based prototype.

What this means concretely:

- The database file lives in the visitor's own browser. Anyone with developer
  tools open can read it, edit it, or replace it. Nothing in it is
  authoritative, and it must never be treated as a system of record.
- Client-side validation is a **convenience**, not a control. In this
  prototype the SQLite `CHECK`, `UNIQUE` and foreign-key constraints are the
  real enforcement, and they are still only as trustworthy as the browser
  running them.
- There is no authentication, no authorisation, no audit trail and no rate
  limiting. The admin page proves nothing about identity.
- A production version would keep the database on a server, enforce every rule
  there, authenticate users against the university's identity provider, and
  treat the browser as untrusted input — which is exactly what
  `backend/RegistrationService.cs` demonstrates.

What the prototype *does* get right, and why it is worth doing even here:

- **No SQL injection surface.** Every statement, in JavaScript and in C#, uses
  bound parameters. No user value is ever concatenated into SQL. `LIKE`
  wildcards inside search text are escaped so they are matched literally.
- **No HTML injection surface.** Every piece of text is written with
  `createElement` and `textContent`. `innerHTML` is not used anywhere in this
  repository, so a hostile event title or student name renders as text.
- **Input ceilings.** Names, e-mail addresses, student numbers and search
  terms are length-limited in the UI, in the rules and in the schema.
- **Untrusted URL parameters.** Event ids from the query string are accepted
  only as plain positive integers; anything else shows a "not found" page.
- **No credentials in source control.** The C# connection string is injected
  from configuration; the repository contains no passwords, keys or tokens.
- **Honest failure.** A blocked `localStorage`, a missing `.sql` file or a
  corrupted snapshot produces a readable message and a recovery path instead
  of a silently broken page.

---

## AI usage disclosure

An AI assistant (Claude) was used during this project for: drafting the
initial architecture proposal, generating first drafts of the SQL schema, the
JavaScript modules, the C# service and the test suites, and drafting this
documentation.

Every generated artefact was then inspected, tested and corrected by hand.
The corrections are not cosmetic — testing the AI-written schema revealed a
`CHECK` constraint that silently accepted invalid dates, and testing the
AI-written registration flow revealed a double-click that navigated students
away from their own confirmation. Both are documented, with the fix, in the
verification log in [SUBMISSION.md](SUBMISSION.md).

Nothing in this repository was accepted because it "looked right" or because
the tests passed on the first run. Where a generated suggestion was more
complex than the requirements justified, it was simplified rather than kept.
