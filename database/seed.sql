-- =============================================================================
-- DLSUD EventHub - Seed data (SQLite)
-- NOTE: This is PROTOTYPE / DEMONSTRATION data for an academic laboratory
--       exercise. The events below are sample campus events invented for the
--       prototype. They are NOT official De La Salle University-Dasmarinas
--       events, and the students below are fictitious.
-- Run AFTER database/schema.sql.
-- =============================================================================

PRAGMA foreign_keys = ON;

DELETE FROM registrations;
DELETE FROM users;
DELETE FROM events;
DELETE FROM departments;
DELETE FROM sqlite_sequence
 WHERE name IN ('registrations', 'users', 'events', 'departments');

-- -----------------------------------------------------------------------------
-- Departments (DLSU-D colleges, used by the registration form)
-- -----------------------------------------------------------------------------
INSERT INTO departments (department_id, code, name) VALUES
    (1, 'CSCS',  'College of Science and Computer Studies'),
    (2, 'CBAA',  'College of Business Administration and Accountancy'),
    (3, 'CEAT',  'College of Engineering, Architecture and Technology'),
    (4, 'CLAC',  'College of Liberal Arts and Communication'),
    (5, 'CCJE',  'College of Criminal Justice Education'),
    (6, 'CIHTM', 'College of International Hospitality and Tourism Management'),
    (7, 'CTHM',  'College of Tourism and Hospitality Management'),
    (8, 'COED',  'College of Education');

-- -----------------------------------------------------------------------------
-- Events - sample campus events (prototype data)
-- Dates are deliberately spread so the catalog shows upcoming AND past events.
-- -----------------------------------------------------------------------------
INSERT INTO events (event_id, title, description, event_date, location, capacity, category) VALUES
    (1, 'Tech Career Talk 2026',
        'Sample campus event. Alumni working in software engineering, data and IT operations share how they moved from thesis defense to their first role, what interviewers actually look for, and which skills matter in the first two years of practice.',
        '2026-10-15T09:00', 'Ayuntamiento Hall', 120, 'Career'),

    (2, 'Cybersecurity Awareness Workshop',
        'Sample campus event. A hands-on session on phishing, password hygiene, multi-factor authentication and safe handling of student records. Participants work through a guided exercise on spotting a credential-harvesting page.',
        '2026-10-22T13:00', 'CSCS Computer Laboratory 3', 60, 'Workshop'),

    (3, 'Student Organization Fair',
        'Sample campus event. All accredited student organizations set up booths for one afternoon. Walk through, talk to officers, and sign up for the organizations you want to join this academic year.',
        '2026-10-28T08:00', 'University Oval', 500, 'Organization'),

    (4, 'Leadership Seminar for Student Officers',
        'Sample campus event. A seminar for incoming organization officers covering meeting facilitation, budgeting, delegation and writing activity proposals that actually get approved.',
        '2026-11-05T10:00', 'Paggawa Auditorium', 80, 'Leadership'),

    (5, 'Research and Innovation Day',
        'Sample campus event. Undergraduate research presentations and a poster exhibit across the colleges, followed by a panel on turning a capstone project into something that survives past graduation.',
        '2026-11-12T08:30', 'University Library Conference Hall', 200, 'Research'),

    (6, 'Developer Workshop: Web Fundamentals',
        'Sample campus event. A small-group workshop on semantic HTML, accessible forms, responsive CSS and debugging JavaScript in the browser. Bring a laptop; seats are limited to keep it hands-on.',
        '2026-11-19T13:30', 'CSCS Computer Laboratory 1', 40, 'Technology'),

    (7, 'Internship Preparation Seminar',
        'Sample campus event. Resume review, mock interviews and a walkthrough of the on-the-job training requirements and paperwork you need before deployment.',
        '2026-12-03T09:00', 'CBAA Lecture Room 204', 150, 'Seminar'),

    (8, 'Campus Tech Summit 2026',
        'Sample campus event that has already taken place. Kept in the seed data so the catalog can demonstrate how past events are presented and why they are closed for registration.',
        '2026-08-20T09:00', 'Ayuntamiento Hall', 100, 'Technology');

-- -----------------------------------------------------------------------------
-- Users - named sample students (fictitious)
-- -----------------------------------------------------------------------------
INSERT INTO users (user_id, student_id, full_name, email, department_id) VALUES
    (1,  '20211001', 'Althea Mariano',      'althea.mariano@dlsud.edu.ph',   1),
    (2,  '20211002', 'Bryan Dela Cruz',     'bryan.delacruz@dlsud.edu.ph',   1),
    (3,  '20211003', 'Camille Ocampo',      'camille.ocampo@dlsud.edu.ph',   2),
    (4,  '20211004', 'Dennis Villanueva',   'dennis.villanueva@dlsud.edu.ph',3),
    (5,  '20211005', 'Erika Santos',        'erika.santos@dlsud.edu.ph',     4),
    (6,  '20211006', 'Francis Lim',         'francis.lim@dlsud.edu.ph',      1),
    (7,  '20211007', 'Grace Pineda',        'grace.pineda@dlsud.edu.ph',     5),
    (8,  '20211008', 'Hector Ramos',        'hector.ramos@dlsud.edu.ph',     6),
    (9,  '20211009', 'Irene Bautista',      'irene.bautista@dlsud.edu.ph',   8),
    (10, '20211010', 'Joshua Aquino',       'joshua.aquino@dlsud.edu.ph',    3),
    (11, '20211011', 'Karla Mendoza',       'karla.mendoza@dlsud.edu.ph',    2),
    (12, '20211012', 'Liam Navarro',        'liam.navarro@dlsud.edu.ph',     7);

-- Filler students (user_id 100+) exist only so that the capacity rules can be
-- demonstrated with a genuinely full event and a nearly full event.
INSERT INTO users (user_id, student_id, full_name, email, department_id)
WITH RECURSIVE seq(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < 100
)
SELECT  100 + n,
        printf('2026%04d', n),
        printf('Demo Student %03d', n),
        printf('demo.student%03d@dlsud.edu.ph', n),
        ((n - 1) % 8) + 1
FROM    seq;

-- -----------------------------------------------------------------------------
-- Registrations
-- -----------------------------------------------------------------------------

-- Event 1 (Tech Career Talk, capacity 120): healthy, partially filled.
INSERT INTO registrations (user_id, event_id, registered_at, status) VALUES
    (1,  1, '2026-09-10T08:12:00Z', 'confirmed'),
    (2,  1, '2026-09-10T09:40:00Z', 'confirmed'),
    (3,  1, '2026-09-11T14:05:00Z', 'confirmed'),
    (4,  1, '2026-09-12T11:30:00Z', 'confirmed'),
    (5,  1, '2026-09-12T16:22:00Z', 'cancelled'), -- proves cancelled rows are
                                                  -- excluded from seat counts
    (6,  1, '2026-09-13T07:55:00Z', 'confirmed');

-- Event 2 (Cybersecurity Awareness Workshop, capacity 60): FULL.
-- 60 confirmed rows -> remaining_seats = 0 -> registration must be rejected.
INSERT INTO registrations (user_id, event_id, registered_at, status)
SELECT  user_id,
        2,
        '2026-09-15T08:00:00Z',
        'confirmed'
FROM    users
WHERE   user_id BETWEEN 101 AND 160;

-- Event 6 (Developer Workshop, capacity 40): 39 confirmed -> exactly one seat
-- left, so the "last seat" and "almost full" states can be demonstrated.
INSERT INTO registrations (user_id, event_id, registered_at, status)
SELECT  user_id,
        6,
        '2026-09-18T10:00:00Z',
        'confirmed'
FROM    users
WHERE   user_id BETWEEN 101 AND 139;

-- Remaining events: a light, realistic spread.
INSERT INTO registrations (user_id, event_id, registered_at, status) VALUES
    (1,  3, '2026-09-20T09:00:00Z', 'confirmed'),
    (7,  3, '2026-09-20T09:15:00Z', 'confirmed'),
    (8,  3, '2026-09-21T13:45:00Z', 'confirmed'),
    (9,  4, '2026-09-22T08:30:00Z', 'confirmed'),
    (10, 4, '2026-09-22T08:35:00Z', 'confirmed'),
    (11, 5, '2026-09-23T15:10:00Z', 'confirmed'),
    (12, 5, '2026-09-24T10:05:00Z', 'confirmed'),
    (2,  5, '2026-09-24T10:40:00Z', 'confirmed'),
    (3,  7, '2026-09-25T11:00:00Z', 'confirmed'),
    (4,  8, '2026-08-01T09:00:00Z', 'confirmed');
