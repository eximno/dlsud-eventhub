-- =============================================================================
-- DLSUD EventHub - Relational Schema (SQLite)
-- Target: SQLite 3.x (executed in the browser through sql.js / WebAssembly,
--         and loadable by any sqlite3 client for inspection).
-- Normal form: 3NF. Every non-key attribute depends on the whole primary key
--              and nothing but the primary key. Department names are stored
--              once in `departments` instead of being repeated per user, and
--              seat counts are DERIVED (see the `event_availability` view)
--              rather than stored, so no value can drift out of sync.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- DEPARTMENTS - lookup table. Extracted from `users` so that a department name
-- is not functionally dependent on a non-key column (3NF).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
    department_id INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    NOT NULL UNIQUE
                          CHECK (length(code) BETWEEN 2 AND 16
                                 AND code = upper(code)),
    name          TEXT    NOT NULL UNIQUE
                          CHECK (length(trim(name)) BETWEEN 3 AND 100)
);

-- -----------------------------------------------------------------------------
-- USERS - DLSU-D students who may register for events.
-- The institutional e-mail rule lives in the CHECK constraint so the database
-- enforces the same business rule as the frontend and the C# service:
--   * must end in exactly "@dlsud.edu.ph"
--   * must have a non-empty local part
--   * must contain exactly one "@"
--   * stored lower-case (canonical form -> UNIQUE actually prevents duplicates)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    TEXT    NOT NULL UNIQUE
                          CHECK (length(student_id) BETWEEN 6 AND 12
                                 AND student_id NOT GLOB '*[^0-9]*'),
    full_name     TEXT    NOT NULL
                          CHECK (length(trim(full_name)) BETWEEN 2 AND 100),
    email         TEXT    NOT NULL UNIQUE
                          CHECK (email = lower(email)
                                 AND length(email) <= 100
                                 AND email LIKE '%_@dlsud.edu.ph'
                                 AND email NOT LIKE '%@%@%'
                                 AND email NOT LIKE '% %'),
    department_id INTEGER NOT NULL
                          REFERENCES departments (department_id)
                          ON UPDATE CASCADE
                          ON DELETE RESTRICT,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- -----------------------------------------------------------------------------
-- EVENTS - campus events open for registration.
-- `capacity` is the only seat-related stored value; the number of registered
-- attendees is always counted from `registrations`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL
                        CHECK (length(trim(title)) BETWEEN 3 AND 120),
    description TEXT    NOT NULL
                        CHECK (length(trim(description)) BETWEEN 10 AND 2000),
    event_date  TEXT    NOT NULL
                        -- ISO-8601 local date-time, e.g. 2026-10-15T09:00
                        -- `IS` (not `=`) so that an unparseable value, for
                        -- which strftime() returns NULL, is REJECTED rather
                        -- than silently accepted by three-valued logic.
                        CHECK (event_date IS strftime('%Y-%m-%dT%H:%M', event_date)),
    location    TEXT    NOT NULL
                        CHECK (length(trim(location)) BETWEEN 3 AND 120),
    capacity    INTEGER NOT NULL
                        CHECK (capacity > 0 AND capacity <= 5000),
    category    TEXT    NOT NULL
                        CHECK (category IN ('Career', 'Technology', 'Seminar',
                                            'Workshop', 'Research',
                                            'Organization', 'Leadership')),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- The same event title cannot be scheduled twice at the same moment.
    UNIQUE (title, event_date)
);

-- -----------------------------------------------------------------------------
-- REGISTRATIONS - resolves the many-to-many relationship between users and
-- events. The composite UNIQUE constraint is the authoritative guard against
-- duplicate registration; the UI and the C# service check it too, but the
-- database is the last line of defence.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registrations (
    registration_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL
                            REFERENCES users (user_id)
                            ON UPDATE CASCADE
                            ON DELETE CASCADE,
    event_id        INTEGER NOT NULL
                            REFERENCES events (event_id)
                            ON UPDATE CASCADE
                            ON DELETE CASCADE,
    registered_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    status          TEXT    NOT NULL DEFAULT 'confirmed'
                            CHECK (status IN ('confirmed', 'cancelled')),
    UNIQUE (user_id, event_id)
);

-- -----------------------------------------------------------------------------
-- INDEXES
-- SQLite indexes UNIQUE constraints automatically, but NOT plain foreign keys,
-- so every foreign-key column gets an explicit index.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_department_id
    ON users (department_id);                       -- FK -> departments

CREATE INDEX IF NOT EXISTS idx_registrations_user_id
    ON registrations (user_id);                     -- FK -> users

CREATE INDEX IF NOT EXISTS idx_registrations_event_id
    ON registrations (event_id);                    -- FK -> events

-- Seat availability is the hottest query in the app: count confirmed rows
-- for one event. A covering index on (event_id, status) answers it directly.
CREATE INDEX IF NOT EXISTS idx_registrations_event_status
    ON registrations (event_id, status);

-- The catalog is always ordered by date and often filtered by category.
CREATE INDEX IF NOT EXISTS idx_events_event_date
    ON events (event_date);

CREATE INDEX IF NOT EXISTS idx_events_category
    ON events (category);

-- -----------------------------------------------------------------------------
-- VIEW: event_availability
-- Single source of truth for seat maths, shared by the catalog, the event page
-- and the admin dashboard. `remaining_seats` is clamped at 0 so that a
-- corrupted state (more confirmed rows than capacity) can never produce a
-- negative number of seats or re-open a full event.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS event_availability;
CREATE VIEW event_availability AS
SELECT  e.event_id,
        e.title,
        e.description,
        e.event_date,
        e.location,
        e.category,
        e.capacity,
        COUNT(r.registration_id)                              AS confirmed_count,
        MAX(e.capacity - COUNT(r.registration_id), 0)         AS remaining_seats,
        CASE WHEN COUNT(r.registration_id) >= e.capacity
             THEN 1 ELSE 0 END                                AS is_full
FROM        events e
LEFT JOIN   registrations r
        ON  r.event_id = e.event_id
       AND  r.status   = 'confirmed'
GROUP BY    e.event_id;
