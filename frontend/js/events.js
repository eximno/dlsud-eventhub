/* =============================================================================
 * events.js - event queries and event rendering.
 *
 * All SQL here uses NAMED BOUND PARAMETERS. Search text is passed as a
 * parameter, never concatenated, and LIKE wildcards inside the search term are
 * escaped so that typing "%" or "_" searches for those characters instead of
 * silently matching everything.
 *
 * All DOM output is built with createElement/textContent. No user-supplied or
 * database-supplied value is ever assigned to innerHTML, which removes the
 * stored-XSS path entirely.
 * ========================================================================== */
window.EventHubEvents = (function (DB, Registration, Validation) {
    'use strict';

    var CATALOG_COLUMNS =
        'event_id, title, description, event_date, location, category, ' +
        'capacity, confirmed_count, remaining_seats, is_full';

    /* ---------------------------------------------------------------------
     * Queries
     * ------------------------------------------------------------------- */

    /** Escape the LIKE metacharacters so they are matched literally. */
    function escapeLike(term) {
        return term.replace(/[\\%_]/g, function (match) { return '\\' + match; });
    }

    function nowIsoMinutes(reference) {
        var date = reference instanceof Date ? reference : new Date();
        function pad(value) { return String(value).padStart(2, '0'); }
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' +
               pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' +
               pad(date.getMinutes());
    }

    function listCategories() {
        return DB.all(
            'SELECT DISTINCT category FROM events ORDER BY category'
        ).map(function (row) { return row.category; });
    }

    function listDepartments() {
        return DB.all(
            'SELECT department_id, code, name FROM departments ORDER BY name'
        );
    }

    /**
     * @param {object} filters { search, category, when: 'upcoming'|'past'|'all' }
     * @returns {object[]} rows from the event_availability view
     */
    function listEvents(filters) {
        var options = filters || {};
        var search = Validation.sanitizeSearchTerm(options.search || '').toLowerCase();
        var category = Validation.cleanText(options.category || '');
        var when = options.when === 'past' || options.when === 'all'
            ? options.when : 'upcoming';

        var rows = DB.all(
            'SELECT ' + CATALOG_COLUMNS + ' FROM event_availability ' +
            'WHERE (:search = \'\' ' +
            '       OR lower(title)       LIKE :pattern ESCAPE \'\\\' ' +
            '       OR lower(description) LIKE :pattern ESCAPE \'\\\' ' +
            '       OR lower(location)    LIKE :pattern ESCAPE \'\\\' ' +
            '       OR lower(category)    LIKE :pattern ESCAPE \'\\\') ' +
            '  AND (:category = \'\' OR category = :category) ' +
            '  AND (:when = \'all\' ' +
            '       OR (:when = \'upcoming\' AND event_date >= :now) ' +
            '       OR (:when = \'past\'     AND event_date <  :now)) ' +
            'ORDER BY event_date ASC',
            {
                ':search': search,
                ':pattern': '%' + escapeLike(search) + '%',
                ':category': category,
                ':when': when,
                ':now': nowIsoMinutes(options.now)
            }
        );

        /* Past events read better newest-first. */
        return when === 'past' ? rows.reverse() : rows;
    }

    /** @returns {object|null} one event, or null for an unknown id. */
    function getEvent(eventId) {
        var check = Validation.validateEventId(eventId);
        if (!check.valid) { return null; }
        return DB.one(
            'SELECT ' + CATALOG_COLUMNS + ' FROM event_availability WHERE event_id = ?',
            [check.value]
        );
    }

    /** Catalog-wide numbers for the hero panel. */
    function summary(reference) {
        var now = nowIsoMinutes(reference);
        return {
            upcoming: Number(DB.scalar(
                'SELECT COUNT(*) FROM events WHERE event_date >= ?', [now]
            )) || 0,
            seatsLeft: Number(DB.scalar(
                'SELECT COALESCE(SUM(remaining_seats), 0) FROM event_availability ' +
                'WHERE event_date >= ?', [now]
            )) || 0,
            registrations: Number(DB.scalar(
                'SELECT COUNT(*) FROM registrations WHERE status = \'confirmed\''
            )) || 0
        };
    }

    /* ---------------------------------------------------------------------
     * Rendering
     * ------------------------------------------------------------------- */

    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];

    /** 'YYYY-MM-DDTHH:MM' -> { date, time, long, iso } without Date parsing
     *  surprises. Returns a safe fallback for malformed values. */
    function formatEventDate(value) {
        var text = Validation.cleanText(value);
        var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
        if (!match) {
            return { date: 'Date to be announced', time: '', long: 'Date to be announced', iso: '' };
        }
        var year = Number(match[1]);
        var month = Number(match[2]) - 1;
        var day = Number(match[3]);
        var hour = Number(match[4]);
        var minute = match[5];
        var weekday = DAYS[new Date(year, month, day).getDay()];
        var suffix = hour < 12 ? 'AM' : 'PM';
        var hour12 = hour % 12 === 0 ? 12 : hour % 12;
        var time = hour12 + ':' + minute + ' ' + suffix;
        var shortDate = MONTHS[month].slice(0, 3) + ' ' + day + ', ' + year;

        return {
            date: shortDate,
            time: time,
            long: weekday + ', ' + MONTHS[month] + ' ' + day + ', ' + year + ' at ' + time,
            iso: text
        };
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined && text !== null) { node.textContent = String(text); }
        return node;
    }

    /**
     * Highlight the search term inside a label WITHOUT innerHTML: the text is
     * split and re-assembled from text nodes and <mark> elements.
     */
    function highlight(parent, text, term) {
        var source = String(text);
        var needle = String(term || '').trim().toLowerCase();
        if (needle === '') {
            parent.appendChild(document.createTextNode(source));
            return parent;
        }
        var haystack = source.toLowerCase();
        var cursor = 0;
        var found = haystack.indexOf(needle, cursor);
        while (found !== -1) {
            if (found > cursor) {
                parent.appendChild(document.createTextNode(source.slice(cursor, found)));
            }
            var mark = document.createElement('mark');
            mark.textContent = source.slice(found, found + needle.length);
            parent.appendChild(mark);
            cursor = found + needle.length;
            found = haystack.indexOf(needle, cursor);
        }
        if (cursor < source.length) {
            parent.appendChild(document.createTextNode(source.slice(cursor)));
        }
        return parent;
    }

    function seatBadge(availability, isPast) {
        if (isPast) { return el('span', 'badge badge--past', 'Closed'); }
        if (!availability.valid) { return el('span', 'badge badge--full', 'Unavailable'); }
        if (availability.isFull) { return el('span', 'badge badge--full', 'Full'); }
        if (availability.state === 'tight') { return el('span', 'badge badge--tight', 'Few seats'); }
        return el('span', 'badge badge--open', 'Open');
    }

    /** Seat meter. The bar is aria-hidden; the sentence carries the meaning. */
    function seatMeter(availability) {
        var wrapper = el('div', 'seats' + (availability.isFull ? ' seats--full'
                        : (availability.state === 'tight' ? ' seats--tight' : '')));
        wrapper.appendChild(el('p', 'seats__text', Registration.describeSeats(availability)));
        var bar = el('div', 'seats__bar');
        bar.setAttribute('aria-hidden', 'true');
        var fill = el('span', 'seats__fill');
        fill.style.width = (availability.valid ? availability.percentFilled : 100) + '%';
        bar.appendChild(fill);
        wrapper.appendChild(bar);
        return wrapper;
    }

    function eventHref(eventId) {
        return 'event.html?id=' + encodeURIComponent(eventId);
    }

    /** @returns {HTMLLIElement} one catalog card. */
    function renderEventCard(row, options) {
        var settings = options || {};
        var availability = Registration.assessAvailability(row.capacity, row.confirmed_count);
        var when = formatEventDate(row.event_date);
        var isPast = Registration.hasPassed(row.event_date, settings.now);

        var card = el('li', 'event-card');

        var top = el('div', 'event-card__top');
        var dateLine = el('p', 'event-card__date');
        var time = el('time');
        time.setAttribute('datetime', when.iso);
        time.textContent = when.date + ' - ' + when.time;
        dateLine.appendChild(time);
        top.appendChild(dateLine);
        top.appendChild(seatBadge(availability, isPast));
        card.appendChild(top);

        var body = el('div', 'event-card__body');
        var heading = el('h3');
        var link = document.createElement('a');
        link.href = eventHref(row.event_id);
        highlight(link, row.title, settings.search);
        heading.appendChild(link);
        body.appendChild(heading);

        var meta = el('ul', 'event-card__meta');
        [['Venue', row.location], ['Category', row.category]].forEach(function (pair) {
            var item = document.createElement('li');
            item.appendChild(el('strong', null, pair[0] + ':'));
            item.appendChild(document.createTextNode(' ' + pair[1]));
            meta.appendChild(item);
        });
        body.appendChild(meta);
        body.appendChild(el('p', 'event-card__excerpt', row.description));
        card.appendChild(body);

        var foot = el('div', 'event-card__foot');
        foot.appendChild(seatMeter(availability));
        var action = document.createElement('a');
        action.className = 'btn btn--secondary btn--sm';
        action.href = eventHref(row.event_id);
        /* The link text alone would be ambiguous in a list of links, so the
         * accessible name includes the event title. */
        action.textContent = isPast ? 'View details' : 'View and register';
        action.setAttribute('aria-label',
            (isPast ? 'View details for ' : 'View and register for ') + row.title);
        foot.appendChild(action);
        card.appendChild(foot);

        return card;
    }

    /**
     * Replace the contents of `listElement` with cards for `rows`.
     * @returns {number} how many cards were rendered.
     */
    function renderCatalog(listElement, rows, options) {
        listElement.textContent = '';
        rows.forEach(function (row) {
            listElement.appendChild(renderEventCard(row, options));
        });
        return rows.length;
    }

    return {
        escapeLike: escapeLike,
        nowIsoMinutes: nowIsoMinutes,
        listCategories: listCategories,
        listDepartments: listDepartments,
        listEvents: listEvents,
        getEvent: getEvent,
        summary: summary,
        formatEventDate: formatEventDate,
        highlight: highlight,
        seatMeter: seatMeter,
        seatBadge: seatBadge,
        eventHref: eventHref,
        renderEventCard: renderEventCard,
        renderCatalog: renderCatalog,
        el: el
    };
}(window.EventHubDB, window.Registration, window.Validation));
