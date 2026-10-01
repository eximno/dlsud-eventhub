/* =============================================================================
 * validation.js - pure business rules for DLSUD EventHub.
 *
 * This module is deliberately free of DOM access, database access and global
 * state so that:
 *   1. it can be unit tested directly (see tests/validation.test.mjs), and
 *   2. there is exactly ONE definition of each rule in the frontend.
 *
 * The same rules are mirrored, by design, in:
 *   - database/schema.sql   (CHECK constraints - last line of defence)
 *   - backend/RegistrationService.cs (RegistrationRules - exam deliverable)
 * If you change a rule here, change it in those two places too.
 * ========================================================================== */
(function (root, factory) {
    'use strict';
    var api = factory();
    /* Browser: attach to window. Node (tests): export as CommonJS. */
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.Validation = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ---------------------------------------------------------------------
     * Constants. Input ceilings exist so that an oversized paste cannot be
     * pushed into the database or into the DOM.
     * ------------------------------------------------------------------- */
    var STUDENT_EMAIL_DOMAIN = 'dlsud.edu.ph';
    var MAX_EMAIL_LENGTH = 100;
    var MAX_NAME_LENGTH = 100;
    var MIN_NAME_LENGTH = 2;
    var MIN_STUDENT_ID_LENGTH = 6;
    var MAX_STUDENT_ID_LENGTH = 12;
    var MAX_SEARCH_LENGTH = 80;

    /* Local part: starts and ends alphanumeric, may contain . _ - inside.
     * Anchored at both ends, so "a@dlsud.edu.ph.fake.com" cannot match and
     * neither can "a@b@dlsud.edu.ph". */
    var LOCAL_PART_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

    /* Unicode letters, spaces, hyphen, apostrophe and period. Digits,
     * angle brackets, parentheses and semicolons are rejected, which removes
     * the most obvious HTML- and SQL-injection payloads at the source.
     * \p{L} keeps this identical to the C# rule in RegistrationService.cs. */
    var NAME_PATTERN = /^[\p{L}.'\- ]+$/u;

    var DIGITS_ONLY_PATTERN = /^[0-9]+$/;

    /* ---------------------------------------------------------------------
     * Helpers
     * ------------------------------------------------------------------- */

    /** Collapse whitespace and trim. Never throws; always returns a string. */
    function cleanText(value) {
        if (value === null || value === undefined) { return ''; }
        return String(value).replace(/\s+/g, ' ').trim();
    }

    /** Canonical form of an e-mail address: trimmed, whitespace-free, lower. */
    function normalizeEmail(value) {
        if (value === null || value === undefined) { return ''; }
        return String(value).trim().toLowerCase();
    }

    /** Parse a value that must be a positive whole number. Returns null if not. */
    function parsePositiveInt(value) {
        if (typeof value === 'number') {
            return Number.isInteger(value) && value > 0 ? value : null;
        }
        var text = cleanText(value);
        /* Reject "3.5", "1e3", "0x2", " 3 4", "+3" and other loose forms that
         * Number() would happily accept. */
        if (!/^[0-9]{1,9}$/.test(text)) { return null; }
        var parsed = Number(text);
        return parsed > 0 ? parsed : null;
    }

    function ok(value) { return { valid: true, value: value, message: '' }; }
    function fail(message) { return { valid: false, value: null, message: message }; }

    /* ---------------------------------------------------------------------
     * Field rules
     * ------------------------------------------------------------------- */

    /**
     * DLSU-D student e-mail rule.
     * VALID:   juan.delacruz@dlsud.edu.ph
     * INVALID: @gmail.com, @dlsu.edu.ph, @dlsud.edu, @dlsud.edu.ph.fake.com
     */
    function validateEmail(rawValue) {
        var email = normalizeEmail(rawValue);

        if (email === '') {
            return fail('Enter your DLSU-D student e-mail address.');
        }
        if (/\s/.test(email)) {
            return fail('E-mail addresses cannot contain spaces.');
        }
        if (email.length > MAX_EMAIL_LENGTH) {
            return fail('E-mail address is too long (maximum ' + MAX_EMAIL_LENGTH + ' characters).');
        }

        var atCount = (email.match(/@/g) || []).length;
        if (atCount !== 1) {
            return fail('Enter a single valid e-mail address, for example juan.delacruz@dlsud.edu.ph.');
        }

        var parts = email.split('@');
        var localPart = parts[0];
        var domain = parts[1];

        if (domain !== STUDENT_EMAIL_DOMAIN) {
            return fail('Only @' + STUDENT_EMAIL_DOMAIN + ' student e-mail addresses can register.');
        }
        if (localPart === '') {
            return fail('The part before @' + STUDENT_EMAIL_DOMAIN + ' cannot be empty.');
        }
        if (localPart.indexOf('..') !== -1) {
            return fail('E-mail address cannot contain two dots in a row.');
        }
        if (!LOCAL_PART_PATTERN.test(localPart)) {
            return fail('Use only letters, numbers, dots, hyphens and underscores before @' + STUDENT_EMAIL_DOMAIN + '.');
        }
        return ok(email);
    }

    /** True/false convenience wrapper used by tests and by the C# mirror. */
    function isValidStudentEmail(rawValue) {
        return validateEmail(rawValue).valid;
    }

    function validateFullName(rawValue) {
        var name = cleanText(rawValue);
        if (name === '') {
            return fail('Enter your full name.');
        }
        if (name.length < MIN_NAME_LENGTH) {
            return fail('Full name must be at least ' + MIN_NAME_LENGTH + ' characters.');
        }
        if (name.length > MAX_NAME_LENGTH) {
            return fail('Full name is too long (maximum ' + MAX_NAME_LENGTH + ' characters).');
        }
        if (!NAME_PATTERN.test(name)) {
            return fail('Full name may only contain letters, spaces, hyphens, apostrophes and periods.');
        }
        return ok(name);
    }

    function validateStudentId(rawValue) {
        var id = cleanText(rawValue).replace(/[\s-]/g, '');
        if (id === '') {
            return fail('Enter your student number.');
        }
        if (!DIGITS_ONLY_PATTERN.test(id)) {
            return fail('Student number must contain digits only.');
        }
        if (id.length < MIN_STUDENT_ID_LENGTH || id.length > MAX_STUDENT_ID_LENGTH) {
            return fail('Student number must be ' + MIN_STUDENT_ID_LENGTH + ' to ' + MAX_STUDENT_ID_LENGTH + ' digits.');
        }
        return ok(id);
    }

    /**
     * Department must be one of the ids the database actually offers, so the
     * allowed list is passed in rather than hard-coded here.
     */
    function validateDepartment(rawValue, allowedIds) {
        var id = parsePositiveInt(rawValue);
        if (id === null) {
            return fail('Select your college or department.');
        }
        if (Array.isArray(allowedIds) && allowedIds.length > 0 &&
            allowedIds.indexOf(id) === -1) {
            return fail('Select your college or department from the list.');
        }
        return ok(id);
    }

    /** Event ids arrive from the query string, so they are never trusted. */
    function validateEventId(rawValue) {
        var id = parsePositiveInt(rawValue);
        if (id === null) {
            return fail('That event link is not valid.');
        }
        return ok(id);
    }

    /** Search text is clamped rather than rejected - a search cannot "fail". */
    function sanitizeSearchTerm(rawValue) {
        return cleanText(rawValue).slice(0, MAX_SEARCH_LENGTH);
    }

    /* ---------------------------------------------------------------------
     * Whole-form rule
     * ------------------------------------------------------------------- */

    /**
     * Validates the registration form as a unit.
     * @returns {{valid: boolean, values: object, errors: object, order: string[]}}
     *          `errors` is keyed by field name; `order` lists the field names
     *          in DOM order so the caller can focus the first failing field.
     */
    function validateRegistrationForm(input, allowedDepartmentIds) {
        var data = input || {};
        var checks = [
            ['fullName', validateFullName(data.fullName)],
            ['studentId', validateStudentId(data.studentId)],
            ['email', validateEmail(data.email)],
            ['departmentId', validateDepartment(data.departmentId, allowedDepartmentIds)]
        ];

        var errors = {};
        var values = {};
        var order = [];

        checks.forEach(function (entry) {
            var field = entry[0];
            var result = entry[1];
            order.push(field);
            if (result.valid) {
                values[field] = result.value;
            } else {
                errors[field] = result.message;
            }
        });

        return {
            valid: Object.keys(errors).length === 0,
            values: values,
            errors: errors,
            order: order
        };
    }

    return {
        STUDENT_EMAIL_DOMAIN: STUDENT_EMAIL_DOMAIN,
        MAX_EMAIL_LENGTH: MAX_EMAIL_LENGTH,
        MAX_NAME_LENGTH: MAX_NAME_LENGTH,
        MAX_SEARCH_LENGTH: MAX_SEARCH_LENGTH,
        cleanText: cleanText,
        normalizeEmail: normalizeEmail,
        parsePositiveInt: parsePositiveInt,
        validateEmail: validateEmail,
        isValidStudentEmail: isValidStudentEmail,
        validateFullName: validateFullName,
        validateStudentId: validateStudentId,
        validateDepartment: validateDepartment,
        validateEventId: validateEventId,
        sanitizeSearchTerm: sanitizeSearchTerm,
        validateRegistrationForm: validateRegistrationForm
    };
}));
