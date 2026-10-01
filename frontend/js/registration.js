/* =============================================================================
 * registration.js - seat-availability and registration domain rules.
 *
 * The decision "may this person register?" is a PURE function of the event's
 * capacity, its confirmed-registration count, its date, and whether the
 * student already holds a confirmed seat. It deliberately knows nothing about
 * the DOM or the database, so it can be unit tested and so the UI cannot be
 * the only thing enforcing capacity.
 *
 * Mirrored in backend/RegistrationService.cs (RegistrationRules).
 * ========================================================================== */
(function (root, factory) {
    'use strict';
    var api = factory(
        typeof require === 'function' ? require('./validation.js')
                                      : (root && root.Validation)
    );
    if (typeof module === 'object' && module.exports) { module.exports = api; }
    if (root) { root.Registration = api; }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Validation) {
    'use strict';

    /* Outcome codes. The UI maps these to messages; tests assert on them. */
    var OUTCOME = {
        ALLOWED: 'ALLOWED',
        EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
        EVENT_PAST: 'EVENT_PAST',
        EVENT_FULL: 'EVENT_FULL',
        DUPLICATE: 'DUPLICATE',
        INVALID_EVENT_STATE: 'INVALID_EVENT_STATE'
    };

    var MESSAGES = {
        EVENT_NOT_FOUND: 'That event could not be found. It may have been removed.',
        EVENT_PAST: 'This event has already taken place, so registration is closed.',
        EVENT_FULL: 'This event is already at full capacity. No seats remain.',
        DUPLICATE: 'This student e-mail address is already registered for this event.',
        INVALID_EVENT_STATE: 'This event has an invalid capacity and is not open for registration.'
    };

    /** Whole number >= 0, rejecting NaN/Infinity/floats/strings-with-junk. */
    function toCount(value) {
        var n = typeof value === 'number' ? value : Number(Validation.cleanText(value));
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) { return null; }
        return n;
    }

    /**
     * Seat maths. Single source of truth for "how many seats are left".
     *
     * Defensive by design:
     *   - capacity must be a whole number > 0, otherwise the event is invalid;
     *   - a negative or non-integer confirmed count is treated as corrupt;
     *   - `remaining` is clamped at 0, so an over-subscribed event (corrupted
     *     state) reports 0 seats instead of a negative number, and stays full.
     *
     * @returns {{valid: boolean, capacity: number, confirmed: number,
     *            remaining: number, isFull: boolean, state: string,
     *            percentFilled: number}}
     */
    function assessAvailability(capacityInput, confirmedInput) {
        var capacity = toCount(capacityInput);
        var confirmed = toCount(confirmedInput);

        if (capacity === null || capacity === 0 || confirmed === null) {
            return {
                valid: false,
                capacity: capacity === null ? 0 : capacity,
                confirmed: confirmed === null ? 0 : confirmed,
                remaining: 0,
                isFull: true,
                state: 'invalid',
                percentFilled: 100
            };
        }

        var remaining = Math.max(capacity - confirmed, 0);
        var isFull = confirmed >= capacity;
        var percent = Math.min(100, Math.round((confirmed / capacity) * 100));
        var state = 'open';
        if (isFull) {
            state = 'full';
        } else if (remaining <= Math.max(1, Math.ceil(capacity * 0.1))) {
            state = 'tight';   /* last 10% (or last seat) of a small event */
        }

        return {
            valid: true,
            capacity: capacity,
            confirmed: confirmed,
            remaining: remaining,
            isFull: isFull,
            state: state,
            percentFilled: percent
        };
    }

    /** ISO 'YYYY-MM-DDTHH:MM' -> epoch ms, or null when unparseable. */
    function parseEventDate(value) {
        var text = Validation.cleanText(value);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) { return null; }
        var ms = new Date(text).getTime();
        return Number.isFinite(ms) ? ms : null;
    }

    function hasPassed(eventDate, now) {
        var ms = parseEventDate(eventDate);
        if (ms === null) { return false; }   /* unknown date -> do not block */
        var reference = now instanceof Date ? now.getTime()
                      : (typeof now === 'number' ? now : Date.now());
        return ms < reference;
    }

    /**
     * The registration decision.
     *
     * @param {object|null} event  { capacity, confirmedCount, event_date? }
     * @param {object} context     { alreadyRegistered: boolean, now?: Date|number }
     * @returns {{allowed: boolean, code: string, message: string,
     *            availability: object|null}}
     */
    function evaluate(event, context) {
        var ctx = context || {};

        if (!event || typeof event !== 'object') {
            return {
                allowed: false,
                code: OUTCOME.EVENT_NOT_FOUND,
                message: MESSAGES.EVENT_NOT_FOUND,
                availability: null
            };
        }

        var availability = assessAvailability(event.capacity, event.confirmedCount);

        if (!availability.valid) {
            return {
                allowed: false,
                code: OUTCOME.INVALID_EVENT_STATE,
                message: MESSAGES.INVALID_EVENT_STATE,
                availability: availability
            };
        }

        /* Duplicate is checked before capacity: telling an already-registered
         * student "this event is full" would be misleading. */
        if (ctx.alreadyRegistered === true) {
            return {
                allowed: false,
                code: OUTCOME.DUPLICATE,
                message: MESSAGES.DUPLICATE,
                availability: availability
            };
        }

        if (hasPassed(event.event_date || event.eventDate, ctx.now)) {
            return {
                allowed: false,
                code: OUTCOME.EVENT_PAST,
                message: MESSAGES.EVENT_PAST,
                availability: availability
            };
        }

        if (availability.isFull) {
            return {
                allowed: false,
                code: OUTCOME.EVENT_FULL,
                message: MESSAGES.EVENT_FULL,
                availability: availability
            };
        }

        return {
            allowed: true,
            code: OUTCOME.ALLOWED,
            message: '',
            availability: availability
        };
    }

    /** Human-readable seat sentence - shared by cards, detail page and admin. */
    function describeSeats(availability) {
        if (!availability || !availability.valid) {
            return 'Seat information unavailable';
        }
        if (availability.isFull) {
            return 'Full - 0 of ' + availability.capacity + ' seats left';
        }
        if (availability.remaining === 1) {
            return 'Last seat available (1 of ' + availability.capacity + ')';
        }
        return availability.remaining + ' of ' + availability.capacity + ' seats left';
    }

    return {
        OUTCOME: OUTCOME,
        MESSAGES: MESSAGES,
        assessAvailability: assessAvailability,
        parseEventDate: parseEventDate,
        hasPassed: hasPassed,
        evaluate: evaluate,
        describeSeats: describeSeats
    };
}));
