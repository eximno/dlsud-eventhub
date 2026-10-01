/* =============================================================================
 * Unit tests for the frontend business rules (node:test - no dependencies).
 *
 * Why this file exists in addition to RegistrationServiceTests.cs:
 * the examination's unit-testing task is delivered in xUnit, but the rules the
 * *website* actually enforces live in frontend/js/validation.js and
 * frontend/js/registration.js. These tests pin those rules so the JavaScript
 * and the C# cannot drift apart silently, and they run with nothing more than
 * the Node.js that is already installed.
 *
 * Run with:  node --test tests/
 * ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Validation = require('../frontend/js/validation.js');
const Registration = require('../frontend/js/registration.js');

const NOW = new Date('2026-10-01T08:00:00Z').getTime();

/* ---------------------------------------------------------------------------
 * DLSU-D student e-mail rule
 * ------------------------------------------------------------------------- */

test('accepts valid DLSU-D student e-mail addresses', () => {
    [
        'student@dlsud.edu.ph',
        'juan.delacruz@dlsud.edu.ph',
        'maria_santos@dlsud.edu.ph',
        'jose-rizal@dlsud.edu.ph',
        'student123@dlsud.edu.ph',
        '  Student@DLSUD.edu.ph  '
    ].forEach((email) => {
        assert.equal(Validation.isValidStudentEmail(email), true, email);
    });
});

test('rejects addresses from other schools and providers', () => {
    [
        'student@gmail.com',
        'student@yahoo.com',
        'student@dlsu.edu.ph',
        'student@dlsud.edu',
        'student@dlsud.edu.ph.fake.com',
        'student@sub.dlsud.edu.ph',
        'student@dlsud.edu.ph.'
    ].forEach((email) => {
        assert.equal(Validation.isValidStudentEmail(email), false, email);
    });
});

test('rejects malformed addresses', () => {
    [
        '', '   ', 'student', 'student@', '@dlsud.edu.ph',
        'student@@dlsud.edu.ph', 'a@b@dlsud.edu.ph',
        '.student@dlsud.edu.ph', 'student.@dlsud.edu.ph',
        'stu..dent@dlsud.edu.ph', 'stu dent@dlsud.edu.ph',
        'stu<dent@dlsud.edu.ph', "'; DROP TABLE users;--@dlsud.edu.ph"
    ].forEach((email) => {
        assert.equal(Validation.isValidStudentEmail(email), false, JSON.stringify(email));
    });
});

test('rejects null and undefined without throwing', () => {
    assert.equal(Validation.isValidStudentEmail(null), false);
    assert.equal(Validation.isValidStudentEmail(undefined), false);
});

test('rejects an oversized address', () => {
    const local = 'a'.repeat(Validation.MAX_EMAIL_LENGTH);
    assert.equal(Validation.isValidStudentEmail(`${local}@dlsud.edu.ph`), false);
});

test('error messages explain the domain rule', () => {
    const result = Validation.validateEmail('student@gmail.com');
    assert.equal(result.valid, false);
    assert.match(result.message, /dlsud\.edu\.ph/);
});

/* ---------------------------------------------------------------------------
 * Other field rules
 * ------------------------------------------------------------------------- */

test('full name accepts letters, hyphens, apostrophes and accents', () => {
    ['Juan Dela Cruz', 'María Ñoño', "O'Brien-Santos"].forEach((name) => {
        assert.equal(Validation.validateFullName(name).valid, true, name);
    });
});

test('full name rejects injection payloads, digits and oversized input', () => {
    ["Robert'); DROP TABLE users;--", '<script>alert(1)</script>',
     'Juan 123', 'J', '', 'A'.repeat(101)
    ].forEach((name) => {
        assert.equal(Validation.validateFullName(name).valid, false, JSON.stringify(name));
    });
});

test('student number accepts 6 to 12 digits and tolerates separators', () => {
    assert.equal(Validation.validateStudentId('20211001').value, '20211001');
    assert.equal(Validation.validateStudentId('2021-1001').value, '20211001');
    assert.equal(Validation.validateStudentId(' 2021 1001 ').value, '20211001');
});

test('student number rejects letters, short and long values', () => {
    ['', '12', '2021ABCD', '1234567890123', '2021;--'].forEach((id) => {
        assert.equal(Validation.validateStudentId(id).valid, false, JSON.stringify(id));
    });
});

test('department must be one of the ids the database offers', () => {
    assert.equal(Validation.validateDepartment('1', [1, 2, 3]).valid, true);
    assert.equal(Validation.validateDepartment('99', [1, 2, 3]).valid, false);
    assert.equal(Validation.validateDepartment('', [1, 2, 3]).valid, false);
    assert.equal(Validation.validateDepartment('1 OR 1=1', [1, 2, 3]).valid, false);
});

test('event id from the query string is only accepted as a positive integer', () => {
    assert.equal(Validation.validateEventId('3').value, 3);
    ['0', '-1', '1.5', 'abc', '', '1; DROP TABLE events', '1e3', ' ']
        .forEach((raw) => {
            assert.equal(Validation.validateEventId(raw).valid, false, JSON.stringify(raw));
        });
});

test('search text is clamped instead of rejected', () => {
    const long = 'x'.repeat(500);
    assert.equal(Validation.sanitizeSearchTerm(long).length, Validation.MAX_SEARCH_LENGTH);
    assert.equal(Validation.sanitizeSearchTerm('  tech   talk  '), 'tech talk');
    assert.equal(Validation.sanitizeSearchTerm(null), '');
});

test('the whole form reports every failing field at once', () => {
    const result = Validation.validateRegistrationForm({
        fullName: '', studentId: 'abc', email: 'x@gmail.com', departmentId: ''
    }, [1, 2]);

    assert.equal(result.valid, false);
    assert.deepEqual(Object.keys(result.errors).sort(),
        ['departmentId', 'email', 'fullName', 'studentId']);
    assert.deepEqual(result.order, ['fullName', 'studentId', 'email', 'departmentId']);
});

test('a valid form returns normalised values', () => {
    const result = Validation.validateRegistrationForm({
        fullName: '  Juan   Dela Cruz ',
        studentId: '2021-1234',
        email: '  Juan.DelaCruz@DLSUD.edu.ph ',
        departmentId: '2'
    }, [1, 2]);

    assert.equal(result.valid, true);
    assert.deepEqual(result.values, {
        fullName: 'Juan Dela Cruz',
        studentId: '20211234',
        email: 'juan.delacruz@dlsud.edu.ph',
        departmentId: 2
    });
});

/* ---------------------------------------------------------------------------
 * Seat availability
 * ------------------------------------------------------------------------- */

test('99 of 100 seats taken still leaves a seat', () => {
    const seats = Registration.assessAvailability(100, 99);
    assert.equal(seats.valid, true);
    assert.equal(seats.isFull, false);
    assert.equal(seats.remaining, 1);
});

test('100 of 100 seats taken is full', () => {
    const seats = Registration.assessAvailability(100, 100);
    assert.equal(seats.isFull, true);
    assert.equal(seats.remaining, 0);
});

test('an over-subscribed event reports zero seats, never a negative number', () => {
    const seats = Registration.assessAvailability(100, 140);
    assert.equal(seats.isFull, true);
    assert.equal(seats.remaining, 0);
});

test('a non-positive or non-numeric capacity is an invalid event', () => {
    [[0, 0], [-1, 0], [-100, 5], ['abc', 0], [null, 0], [10.5, 0]].forEach(([cap, conf]) => {
        const seats = Registration.assessAvailability(cap, conf);
        assert.equal(seats.valid, false, `capacity ${cap}`);
        assert.equal(seats.remaining, 0);
        assert.equal(seats.isFull, true);
    });
});

test('a negative registration count is an invalid event', () => {
    assert.equal(Registration.assessAvailability(50, -3).valid, false);
});

test('seat descriptions never leak a negative number', () => {
    assert.match(Registration.describeSeats(Registration.assessAvailability(40, 39)), /Last seat/);
    assert.match(Registration.describeSeats(Registration.assessAvailability(40, 40)), /Full/);
    assert.match(Registration.describeSeats(Registration.assessAvailability(40, 60)), /Full/);
    assert.equal(Registration.describeSeats(Registration.assessAvailability(0, 0)),
        'Seat information unavailable');
});

/* ---------------------------------------------------------------------------
 * The registration decision
 * ------------------------------------------------------------------------- */

const upcoming = { capacity: 60, confirmedCount: 10, event_date: '2026-10-22T13:00' };

test('registration is allowed when seats remain', () => {
    const decision = Registration.evaluate(upcoming, { alreadyRegistered: false, now: NOW });
    assert.equal(decision.allowed, true);
    assert.equal(decision.code, 'ALLOWED');
});

test('registration is refused once capacity is reached', () => {
    const decision = Registration.evaluate(
        { ...upcoming, confirmedCount: 60 }, { alreadyRegistered: false, now: NOW });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'EVENT_FULL');
});

test('the last seat is still allowed', () => {
    const decision = Registration.evaluate(
        { ...upcoming, capacity: 40, confirmedCount: 39 }, { alreadyRegistered: false, now: NOW });
    assert.equal(decision.allowed, true);
});

test('duplicate registration is refused', () => {
    const decision = Registration.evaluate(upcoming, { alreadyRegistered: true, now: NOW });
    assert.equal(decision.code, 'DUPLICATE');
});

test('an already-registered student is told DUPLICATE, not EVENT_FULL', () => {
    const decision = Registration.evaluate(
        { ...upcoming, confirmedCount: 60 }, { alreadyRegistered: true, now: NOW });
    assert.equal(decision.code, 'DUPLICATE');
});

test('a past event is closed for registration', () => {
    const decision = Registration.evaluate(
        { ...upcoming, event_date: '2026-08-20T09:00' }, { alreadyRegistered: false, now: NOW });
    assert.equal(decision.code, 'EVENT_PAST');
});

test('a missing event is reported, not crashed on', () => {
    assert.equal(Registration.evaluate(null, { alreadyRegistered: false, now: NOW }).code,
        'EVENT_NOT_FOUND');
    assert.equal(Registration.evaluate(undefined, { alreadyRegistered: false, now: NOW }).code,
        'EVENT_NOT_FOUND');
});

test('a corrupted capacity blocks registration', () => {
    assert.equal(
        Registration.evaluate({ capacity: 0, confirmedCount: 0, event_date: '2026-10-22T13:00' },
            { alreadyRegistered: false, now: NOW }).code,
        'INVALID_EVENT_STATE');
});

test('an unparseable event date does not block registration', () => {
    // A malformed stored date must not be read as "in the past".
    const decision = Registration.evaluate(
        { capacity: 10, confirmedCount: 0, event_date: 'not-a-date' },
        { alreadyRegistered: false, now: NOW });
    assert.equal(decision.allowed, true);
});

test('every refusal carries a message a student can act on', () => {
    [
        Registration.evaluate({ ...upcoming, confirmedCount: 60 }, { alreadyRegistered: false, now: NOW }),
        Registration.evaluate(upcoming, { alreadyRegistered: true, now: NOW }),
        Registration.evaluate(null, { alreadyRegistered: false, now: NOW })
    ].forEach((decision) => {
        assert.equal(decision.allowed, false);
        assert.ok(decision.message.length > 10, decision.code);
    });
});
