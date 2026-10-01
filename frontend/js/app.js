/* =============================================================================
 * app.js - application layer: shared UI helpers, boot sequence and the three
 * page controllers (catalog, event detail, admin).
 *
 * Layering used in this project:
 *   validation.js   pure field rules        (no DOM, no SQL)
 *   registration.js pure seat/duplicate rules (no DOM, no SQL)
 *   database.js     SQLite via sql.js, parameter-bound queries only
 *   events.js       event queries + event DOM rendering
 *   app.js          page wiring, forms, state, error handling  <-- this file
 * ========================================================================== */
(function (window, document) {
    'use strict';

    var DB = window.EventHubDB;
    var Events = window.EventHubEvents;
    var Registration = window.Registration;
    var Validation = window.Validation;

    /* =====================================================================
     * 1. Shared helpers
     * =================================================================== */

    function byId(id) { return document.getElementById(id); }

    /** Build an alert box. Text only - no innerHTML anywhere. */
    function setAlert(container, kind, heading, body) {
        if (!container) { return; }
        container.textContent = '';
        if (!kind) {
            container.className = 'alert';
            container.removeAttribute('data-kind');
            return;
        }
        container.className = 'alert alert--' + kind;
        container.setAttribute('data-kind', kind);

        var icon = document.createElement('span');
        icon.className = 'alert__icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = kind === 'success' ? '✓'
                         : (kind === 'error' ? '✕'
                         : (kind === 'warn' ? '⚠︎' : 'i'));
        container.appendChild(icon);

        var content = document.createElement('div');
        if (heading) {
            var title = document.createElement('h3');
            title.textContent = heading;
            content.appendChild(title);
        }
        if (body) {
            var text = document.createElement('p');
            text.textContent = body;
            content.appendChild(text);
        }
        container.appendChild(content);
    }

    function clearAlert(container) { setAlert(container, null); }

    /** Push text into an aria-live region so screen readers hear the change. */
    function announce(region, message) {
        if (!region) { return; }
        region.textContent = message;
    }

    function debounce(fn, delay) {
        var timer = null;
        return function () {
            var args = arguments;
            var self = this;
            window.clearTimeout(timer);
            timer = window.setTimeout(function () { fn.apply(self, args); }, delay);
        };
    }

    function setBusy(button, busy, busyLabel) {
        if (!button) { return; }
        if (busy) {
            button.dataset.idleLabel = button.dataset.idleLabel || button.textContent;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.textContent = busyLabel || 'Working…';
        } else {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            if (button.dataset.idleLabel) { button.textContent = button.dataset.idleLabel; }
        }
    }

    /**
     * Replace a container with an "empty / error" state box.
     * @param {string} [level] heading level for the state's title. Pass 'h1'
     *        when this state IS the page's main content, so the page is not
     *        left without a level-one heading.
     */
    function showState(container, heading, message, level) {
        container.textContent = '';
        var box = document.createElement('div');
        box.className = 'state';
        var title = document.createElement(level || 'h3');
        title.textContent = heading;
        box.appendChild(title);
        if (message) {
            var text = document.createElement('p');
            text.textContent = message;
            box.appendChild(text);
        }
        container.appendChild(box);
    }

    /**
     * Make a container's links and buttons ignore pointer input briefly after
     * its contents have been replaced, so a queued click from a rapid
     * double-click cannot activate a control the user never saw.
     */
    function settle(container, milliseconds) {
        if (!container) { return; }
        container.classList.add('panel--settling');
        window.setTimeout(function () {
            container.classList.remove('panel--settling');
        }, milliseconds || 500);
    }

    function skeletons(container, count) {
        container.textContent = '';
        for (var i = 0; i < count; i += 1) {
            var item = document.createElement('li');
            item.className = 'skeleton-card';
            item.setAttribute('aria-hidden', 'true');
            container.appendChild(item);
        }
    }

    function markCurrentNav(page) {
        var links = document.querySelectorAll('.site-nav a[data-nav]');
        Array.prototype.forEach.call(links, function (link) {
            if (link.dataset.nav === page) {
                link.setAttribute('aria-current', 'page');
            } else {
                link.removeAttribute('aria-current');
            }
        });
    }

    /** Surface any database warnings (e.g. storage disabled) once, politely. */
    function reportDbWarnings(container) {
        var warnings = DB.consumeWarnings();
        if (warnings.length && container) {
            setAlert(container, 'warn', 'Heads up', warnings.join(' '));
        }
    }

    function fatal(container, error) {
        setAlert(container, 'error', 'The prototype could not start',
            (error && error.message ? error.message : String(error)) +
            ' Reload the page to try again. If this keeps happening, the site must be served over http:// ' +
            'or https:// (not opened directly from the file system) so the browser can load the SQLite files.');
        if (window.console && window.console.error) { window.console.error(error); }
    }

    /* =====================================================================
     * 2. Registration transaction
     *
     * Capacity and duplicate checks happen INSIDE the transaction, immediately
     * before the INSERT, using freshly read counts. A stale page, a second
     * tab, or two rapid clicks therefore cannot push an event past capacity.
     * =================================================================== */

    function buildReference(eventId, registrationId) {
        return 'EH-' + String(eventId).padStart(3, '0') +
               '-' + String(registrationId).padStart(4, '0');
    }

    function submitRegistration(eventId, values) {
        return DB.transaction(function () {
            var event = DB.one(
                'SELECT e.event_id, e.title, e.capacity, e.event_date, ' +
                '       (SELECT COUNT(*) FROM registrations r ' +
                '         WHERE r.event_id = e.event_id AND r.status = \'confirmed\') AS confirmed ' +
                '  FROM events e WHERE e.event_id = ?',
                [eventId]
            );

            if (!event) {
                return { ok: false, code: Registration.OUTCOME.EVENT_NOT_FOUND,
                         message: Registration.MESSAGES.EVENT_NOT_FOUND };
            }

            var user = DB.one(
                'SELECT user_id, student_id, full_name, department_id ' +
                '  FROM users WHERE email = ?',
                [values.email]
            );

            /* The e-mail address is the identity in this prototype. If it is
             * already on file under a different student number, stop: silently
             * overwriting someone else's record would be worse than an error. */
            if (user && user.student_id !== values.studentId) {
                return { ok: false, code: 'IDENTITY_CONFLICT',
                         message: 'This e-mail address is already on file under student number ' +
                                  user.student_id + '. Check your details, or use your own e-mail address.' };
            }

            if (!user) {
                var studentIdOwner = DB.one(
                    'SELECT email FROM users WHERE student_id = ?', [values.studentId]
                );
                if (studentIdOwner) {
                    return { ok: false, code: 'IDENTITY_CONFLICT',
                             message: 'Student number ' + values.studentId +
                                      ' is already registered with a different e-mail address.' };
                }
            }

            var alreadyRegistered = false;
            if (user) {
                alreadyRegistered = Number(DB.scalar(
                    'SELECT COUNT(*) FROM registrations ' +
                    ' WHERE user_id = ? AND event_id = ? AND status = \'confirmed\'',
                    [user.user_id, eventId]
                )) > 0;
            }

            var decision = Registration.evaluate(
                { capacity: event.capacity,
                  confirmedCount: Number(event.confirmed),
                  event_date: event.event_date },
                { alreadyRegistered: alreadyRegistered }
            );

            if (!decision.allowed) {
                return { ok: false, code: decision.code, message: decision.message,
                         availability: decision.availability };
            }

            if (!user) {
                DB.run(
                    'INSERT INTO users (student_id, full_name, email, department_id) ' +
                    'VALUES (?, ?, ?, ?)',
                    [values.studentId, values.fullName, values.email, values.departmentId]
                );
                user = { user_id: DB.lastInsertId() };
            } else {
                /* Keep the stored profile current without touching identity. */
                DB.run(
                    'UPDATE users SET full_name = ?, department_id = ? WHERE user_id = ?',
                    [values.fullName, values.departmentId, user.user_id]
                );
            }

            DB.run(
                'INSERT INTO registrations (user_id, event_id, status) VALUES (?, ?, \'confirmed\')',
                [user.user_id, eventId]
            );

            var registrationId = DB.lastInsertId();
            return {
                ok: true,
                registrationId: registrationId,
                reference: buildReference(eventId, registrationId),
                eventTitle: event.title
            };
        });
    }

    /* =====================================================================
     * 3. Catalog page (index.html)
     * =================================================================== */

    function initCatalogPage() {
        var list = byId('event-list');
        var alertBox = byId('page-alert');
        var resultsMeta = byId('results-meta');
        var form = byId('filter-form');
        var searchInput = byId('search-input');
        var categorySelect = byId('category-filter');
        var whenSelect = byId('when-filter');
        var clearButton = byId('clear-filters');

        skeletons(list, 6);

        function readFiltersFromUrl() {
            var params = new URLSearchParams(window.location.search);
            searchInput.value = Validation.sanitizeSearchTerm(params.get('q') || '');
            var when = params.get('when');
            whenSelect.value = (when === 'past' || when === 'all') ? when : 'upcoming';
            var category = Validation.cleanText(params.get('category') || '');
            /* Only accept a category the <select> actually offers. */
            var options = Array.prototype.map.call(categorySelect.options, function (o) { return o.value; });
            categorySelect.value = options.indexOf(category) !== -1 ? category : '';
        }

        function writeFiltersToUrl(filters) {
            var params = new URLSearchParams();
            if (filters.search) { params.set('q', filters.search); }
            if (filters.category) { params.set('category', filters.category); }
            if (filters.when !== 'upcoming') { params.set('when', filters.when); }
            var query = params.toString();
            var url = window.location.pathname + (query ? '?' + query : '');
            /* replaceState, not pushState: typing in the search box should not
             * bury the previous page behind dozens of history entries. */
            window.history.replaceState(null, '', url);
        }

        function currentFilters() {
            return {
                search: Validation.sanitizeSearchTerm(searchInput.value),
                category: categorySelect.value,
                when: whenSelect.value
            };
        }

        function describeResults(count, filters) {
            if (count === 0) { return 'No events match your filters.'; }
            var scope = filters.when === 'past' ? 'past event'
                      : (filters.when === 'all' ? 'event' : 'upcoming event');
            var text = count + ' ' + scope + (count === 1 ? '' : 's');
            if (filters.search) { text += ' matching “' + filters.search + '”'; }
            if (filters.category) { text += ' in ' + filters.category; }
            return text + '.';
        }

        function render() {
            var filters = currentFilters();
            writeFiltersToUrl(filters);
            try {
                var rows = Events.listEvents(filters);
                if (rows.length === 0) {
                    showState(list,
                        'No events found',
                        filters.search || filters.category
                            ? 'Try a different keyword, choose another category, or clear the filters to see everything.'
                            : 'There are no events in this view yet. Switch to "All events" to see past events.');
                } else {
                    Events.renderCatalog(list, rows, { search: filters.search });
                }
                announce(resultsMeta, describeResults(rows.length, filters));
            } catch (error) {
                showState(list, 'Events could not be loaded',
                    'Something went wrong while reading the local database. Reload the page to try again.');
                announce(resultsMeta, 'Events could not be loaded.');
                if (window.console) { window.console.error(error); }
            }
        }

        function renderSummary() {
            var stats = Events.summary();
            var upcoming = byId('stat-upcoming');
            var seats = byId('stat-seats');
            var registrations = byId('stat-registrations');
            if (upcoming) { upcoming.textContent = String(stats.upcoming); }
            if (seats) { seats.textContent = stats.seatsLeft.toLocaleString('en-US'); }
            if (registrations) { registrations.textContent = stats.registrations.toLocaleString('en-US'); }
        }

        function populateCategories() {
            Events.listCategories().forEach(function (category) {
                var option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                categorySelect.appendChild(option);
            });
        }

        DB.init().then(function () {
            populateCategories();
            readFiltersFromUrl();
            renderSummary();
            render();
            reportDbWarnings(alertBox);

            /* Enter inside the filter form must not reload the page. */
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                render();
            });
            searchInput.addEventListener('input', debounce(render, 180));
            searchInput.addEventListener('search', render);  /* native clear (x) */
            categorySelect.addEventListener('change', render);
            whenSelect.addEventListener('change', render);

            clearButton.addEventListener('click', function () {
                searchInput.value = '';
                categorySelect.value = '';
                whenSelect.value = 'upcoming';
                render();
                searchInput.focus();
            });

            /* Back/forward within the catalog restores the filters shown. */
            window.addEventListener('popstate', function () {
                readFiltersFromUrl();
                render();
            });
        }).catch(function (error) {
            list.textContent = '';
            fatal(alertBox, error);
            announce(resultsMeta, 'The event catalog is unavailable.');
        });
    }

    /* =====================================================================
     * 4. Event detail page (event.html)
     * =================================================================== */

    function initEventPage() {
        var alertBox = byId('page-alert');
        var article = byId('event-detail');
        var panel = byId('registration-panel');
        var crumb = byId('breadcrumb-current');

        function renderMissing(message) {
            article.textContent = '';
            panel.textContent = '';
            document.title = 'Event not found - DLSUD EventHub';
            if (crumb) { crumb.textContent = 'Event not found'; }
            showState(article, 'Event not found', message, 'h1');
            var back = document.createElement('p');
            var link = document.createElement('a');
            link.className = 'btn btn--primary';
            link.href = 'index.html';
            link.textContent = 'Back to all events';
            back.appendChild(link);
            article.appendChild(back);
        }

        DB.init().then(function () {
            var params = new URLSearchParams(window.location.search);
            var idCheck = Validation.validateEventId(params.get('id'));

            if (!idCheck.valid) {
                renderMissing('The address is missing a valid event number, so there is nothing to show. ' +
                              'Open an event from the catalog instead.');
                return;
            }

            var row = Events.getEvent(idCheck.value);
            if (!row) {
                renderMissing('Event number ' + idCheck.value + ' does not exist in this prototype. ' +
                              'It may have been removed, or the link may be mistyped.');
                return;
            }

            renderEventDetail(row);
            reportDbWarnings(alertBox);
        }).catch(function (error) {
            article.textContent = '';
            panel.textContent = '';
            fatal(alertBox, error);
        });

        /* ---------------------------------------------------------------- */

        function renderEventDetail(row) {
            var when = Events.formatEventDate(row.event_date);
            var availability = Registration.assessAvailability(row.capacity, row.confirmed_count);
            var isPast = Registration.hasPassed(row.event_date);

            document.title = row.title + ' - DLSUD EventHub';
            if (crumb) { crumb.textContent = row.title; }

            article.textContent = '';

            var header = Events.el('header', 'detail__header');
            var badges = Events.el('p');
            badges.appendChild(Events.el('span', 'badge badge--category', row.category));
            badges.appendChild(document.createTextNode(' '));
            badges.appendChild(Events.seatBadge(availability, isPast));
            header.appendChild(badges);
            header.appendChild(Events.el('h1', null, row.title));
            header.appendChild(Events.el('p', 'detail__lead', 'Sample campus event - prototype data for an academic exercise.'));
            article.appendChild(header);

            var meta = Events.el('dl', 'detail__meta');
            [['Date and time', when.long],
             ['Venue', row.location],
             ['Category', row.category],
             ['Capacity', row.capacity + ' seats']
            ].forEach(function (pair) {
                meta.appendChild(Events.el('dt', null, pair[0]));
                meta.appendChild(Events.el('dd', null, pair[1]));
            });
            article.appendChild(meta);

            article.appendChild(Events.el('h2', null, 'About this event'));
            article.appendChild(Events.el('p', null, row.description));

            renderPanel(row, availability, isPast);
        }

        function renderPanel(row, availability, isPast) {
            var isRerender = panel.childElementCount > 0;
            panel.textContent = '';
            if (isRerender) { settle(panel); }

            var heading = Events.el('h2', null, 'Registration');
            panel.appendChild(heading);

            var seats = Events.el('div', 'panel__seats');
            seats.appendChild(Events.seatMeter(availability));
            panel.appendChild(seats);

            var panelAlert = Events.el('div', 'alert');
            panelAlert.id = 'form-alert';
            panelAlert.setAttribute('role', 'alert');
            panel.appendChild(panelAlert);

            if (isPast) {
                setAlert(panelAlert, 'info', 'Registration closed',
                    'This event has already taken place. It is kept in the catalog for reference.');
                return;
            }
            if (!availability.valid) {
                setAlert(panelAlert, 'error', 'Registration unavailable',
                    Registration.MESSAGES.INVALID_EVENT_STATE);
                return;
            }
            if (availability.isFull) {
                setAlert(panelAlert, 'warn', 'This event is full',
                    Registration.MESSAGES.EVENT_FULL + ' Browse the catalog for events with seats available.');
                var browse = document.createElement('a');
                browse.className = 'btn btn--secondary btn--block';
                browse.href = 'index.html';
                browse.textContent = 'Find another event';
                panel.appendChild(browse);
                return;
            }

            panel.appendChild(buildForm(row));
        }

        /* Called both on first paint and after a refused submit, so the
         * click shield belongs here rather than at every call site. */

        /* ---------------------------------------------------------------- */

        var FIELDS = [
            { name: 'fullName', id: 'full-name', label: 'Full name',
              hint: 'As printed on your student ID.', type: 'text',
              autocomplete: 'name', maxlength: Validation.MAX_NAME_LENGTH },
            { name: 'studentId', id: 'student-id', label: 'Student number',
              hint: '6 to 12 digits, for example 20211001.', type: 'text',
              autocomplete: 'off', maxlength: 12, inputmode: 'numeric' },
            { name: 'email', id: 'email', label: 'DLSU-D student e-mail',
              hint: 'Must end in @' + Validation.STUDENT_EMAIL_DOMAIN + '.', type: 'email',
              autocomplete: 'email', maxlength: Validation.MAX_EMAIL_LENGTH }
        ];

        function buildForm(row) {
            var form = document.createElement('form');
            form.id = 'registration-form';
            form.noValidate = true;        /* we own the messages, not the browser */
            form.setAttribute('novalidate', 'novalidate');

            var legendWrap = document.createElement('fieldset');
            legendWrap.style.border = '0';
            legendWrap.style.margin = '0';
            legendWrap.style.padding = '0';
            var legend = document.createElement('legend');
            legend.className = 'visually-hidden';
            legend.textContent = 'Register for ' + row.title;
            legendWrap.appendChild(legend);

            FIELDS.forEach(function (spec) {
                var wrap = Events.el('div', 'field');
                var label = document.createElement('label');
                label.htmlFor = spec.id;
                label.textContent = spec.label;
                wrap.appendChild(label);

                var hint = Events.el('span', 'field__hint', spec.hint);
                hint.id = spec.id + '-hint';
                wrap.appendChild(hint);

                var input = document.createElement('input');
                input.type = spec.type;
                input.id = spec.id;
                input.name = spec.name;
                input.required = true;
                input.maxLength = spec.maxlength;
                input.autocomplete = spec.autocomplete;
                if (spec.inputmode) { input.setAttribute('inputmode', spec.inputmode); }
                input.setAttribute('aria-describedby', spec.id + '-hint ' + spec.id + '-error');
                wrap.appendChild(input);

                var error = Events.el('span', 'field__error');
                error.id = spec.id + '-error';
                /* Polite, not assertive: the error is also announced by the
                 * summary alert, and double-announcing is noisy. */
                error.setAttribute('aria-live', 'polite');
                wrap.appendChild(error);

                legendWrap.appendChild(wrap);
            });

            /* Department select, populated from the departments table. */
            var deptWrap = Events.el('div', 'field');
            var deptLabel = document.createElement('label');
            deptLabel.htmlFor = 'department';
            deptLabel.textContent = 'College or department';
            deptWrap.appendChild(deptLabel);
            var deptHint = Events.el('span', 'field__hint', 'Choose the college you are enrolled in.');
            deptHint.id = 'department-hint';
            deptWrap.appendChild(deptHint);

            var select = document.createElement('select');
            select.id = 'department';
            select.name = 'departmentId';
            select.required = true;
            select.setAttribute('aria-describedby', 'department-hint department-error');
            var placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Select your college…';
            select.appendChild(placeholder);

            var departments = Events.listDepartments();
            departments.forEach(function (department) {
                var option = document.createElement('option');
                option.value = String(department.department_id);
                option.textContent = department.code + ' - ' + department.name;
                select.appendChild(option);
            });
            deptWrap.appendChild(select);
            var deptError = Events.el('span', 'field__error');
            deptError.id = 'department-error';
            deptError.setAttribute('aria-live', 'polite');
            deptWrap.appendChild(deptError);
            legendWrap.appendChild(deptWrap);

            form.appendChild(legendWrap);

            var submit = document.createElement('button');
            submit.type = 'submit';
            submit.className = 'btn btn--primary btn--block';
            submit.textContent = 'Reserve my seat';
            form.appendChild(submit);

            var note = Events.el('p', 'field__hint',
                'Prototype only: your details are stored in this browser, not on a university server.');
            note.style.marginTop = '.75rem';
            form.appendChild(note);

            var allowedDepartmentIds = departments.map(function (d) { return d.department_id; });
            wireForm(form, row, allowedDepartmentIds);
            return form;
        }

        function wireForm(form, row, allowedDepartmentIds) {
            var submitting = false;   /* guards rapid double submits */

            function fieldError(name, message) {
                var map = { fullName: 'full-name', studentId: 'student-id',
                            email: 'email', departmentId: 'department' };
                var id = map[name];
                var input = byId(id);
                var slot = byId(id + '-error');
                if (slot) { slot.textContent = message || ''; }
                if (input) {
                    if (message) {
                        input.setAttribute('aria-invalid', 'true');
                    } else {
                        input.removeAttribute('aria-invalid');
                    }
                }
                return input;
            }

            function clearErrors() {
                ['fullName', 'studentId', 'email', 'departmentId'].forEach(function (name) {
                    fieldError(name, '');
                });
                clearAlert(byId('form-alert'));
            }

            /* Validate a single field when the user leaves it, so mistakes are
             * reported early instead of all at once on submit. */
            form.addEventListener('focusout', function (event) {
                var target = event.target;
                if (!target.name || submitting) { return; }
                /* An empty field is not "wrong" yet - the student may simply
                 * not have filled it in. Submit reports those. */
                if (Validation.cleanText(target.value) === '') { return; }
                var result = Validation.validateRegistrationForm(
                    readValues(), allowedDepartmentIds
                );
                fieldError(target.name, result.errors[target.name] || '');
            });

            form.addEventListener('input', function (event) {
                if (event.target.getAttribute('aria-invalid') === 'true') {
                    fieldError(event.target.name, '');
                }
            });

            function readValues() {
                return {
                    fullName: form.elements.fullName.value,
                    studentId: form.elements.studentId.value,
                    email: form.elements.email.value,
                    departmentId: form.elements.departmentId.value
                };
            }

            form.addEventListener('submit', function (event) {
                event.preventDefault();
                if (submitting) { return; }

                clearErrors();
                var check = Validation.validateRegistrationForm(readValues(), allowedDepartmentIds);

                if (!check.valid) {
                    var firstInvalid = null;
                    check.order.forEach(function (name) {
                        var input = fieldError(name, check.errors[name]);
                        if (check.errors[name] && !firstInvalid) { firstInvalid = input; }
                    });
                    var count = Object.keys(check.errors).length;
                    setAlert(byId('form-alert'), 'error',
                        count === 1 ? 'One field needs attention' : count + ' fields need attention',
                        'Check the highlighted fields below and try again.');
                    if (firstInvalid) { firstInvalid.focus(); }
                    return;
                }

                submitting = true;
                var button = form.querySelector('button[type="submit"]');
                setBusy(button, true, 'Reserving…');

                /* Yield once so the busy state actually paints before SQLite
                 * work begins on the same thread. */
                window.setTimeout(function () {
                    var result;
                    try {
                        result = submitRegistration(row.event_id, check.values);
                    } catch (error) {
                        result = {
                            ok: false,
                            code: 'UNEXPECTED',
                            message: 'The registration could not be saved because of an unexpected error. ' +
                                     'Nothing was recorded; please try again.'
                        };
                        if (window.console) { window.console.error(error); }
                    }

                    submitting = false;
                    setBusy(button, false);

                    if (result.ok) {
                        DB.persist();
                        renderSuccess(row, check.values, result);
                        return;
                    }

                    if (result.code === Registration.OUTCOME.DUPLICATE) {
                        fieldError('email', result.message);
                    }
                    setAlert(byId('form-alert'), 'error', 'Registration not completed', result.message);
                    reportDbWarnings(byId('page-alert'));

                    /* Capacity or event state changed under us: re-read and
                     * re-render so the panel stops offering a dead form. */
                    if (result.code === Registration.OUTCOME.EVENT_FULL ||
                        result.code === Registration.OUTCOME.EVENT_NOT_FOUND ||
                        result.code === Registration.OUTCOME.EVENT_PAST ||
                        result.code === Registration.OUTCOME.INVALID_EVENT_STATE) {
                        var fresh = Events.getEvent(row.event_id);
                        if (fresh) {
                            renderPanel(fresh,
                                Registration.assessAvailability(fresh.capacity, fresh.confirmed_count),
                                Registration.hasPassed(fresh.event_date));
                            setAlert(byId('form-alert'), 'warn', 'Registration not completed', result.message);
                        }
                    }
                    var alertNode = byId('form-alert');
                    if (alertNode) { alertNode.scrollIntoView({ block: 'nearest' }); }
                }, 0);
            });
        }

        function renderSuccess(row, values, result) {
            var fresh = Events.getEvent(row.event_id) || row;
            var availability = Registration.assessAvailability(fresh.capacity, fresh.confirmed_count);

            panel.textContent = '';
            panel.appendChild(Events.el('h2', null, 'You are registered'));

            var seats = Events.el('div', 'panel__seats');
            seats.appendChild(Events.seatMeter(availability));
            panel.appendChild(seats);

            var success = Events.el('div', 'alert');
            success.setAttribute('role', 'status');
            panel.appendChild(success);
            setAlert(success, 'success', 'Seat reserved',
                'Your seat for ' + row.title + ' is confirmed. Keep the reference number below.');

            var receipt = Events.el('dl', 'receipt');
            [['Reference number', result.reference],
             ['Event', row.title],
             ['Name', values.fullName],
             ['Student number', values.studentId],
             ['E-mail', values.email]
            ].forEach(function (pair) {
                receipt.appendChild(Events.el('dt', null, pair[0]));
                receipt.appendChild(Events.el('dd', null, pair[1]));
            });
            panel.appendChild(receipt);

            var back = document.createElement('a');
            back.className = 'btn btn--secondary btn--block';
            back.href = 'index.html';
            back.textContent = 'Browse more events';
            back.style.marginTop = '1rem';
            panel.appendChild(back);

            /* Move focus to the confirmation so keyboard and screen-reader
             * users are not left on a button that no longer exists. */
            panel.setAttribute('tabindex', '-1');
            panel.focus();

            /* A second click from a double-click must not follow the link that
             * now sits where the submit button was. */
            settle(panel);
        }
    }

    /* =====================================================================
     * 5. Admin page (admin.html)
     * =================================================================== */

    function initAdminPage() {
        var alertBox = byId('page-alert');
        var statsList = byId('admin-stats');
        var eventsBody = byId('admin-events-body');
        var attendeesBody = byId('attendee-body');
        var attendeeCaption = byId('attendee-caption');
        var eventSelect = byId('attendee-event');
        var attendeeMeta = byId('attendee-meta');
        var resetButton = byId('reset-data');

        function cell(text, className) {
            var td = document.createElement('td');
            if (className) { td.className = className; }
            td.textContent = text;
            return td;
        }

        function renderStats() {
            var totals = DB.one(
                'SELECT (SELECT COUNT(*) FROM events) AS events, ' +
                '       (SELECT COUNT(*) FROM registrations WHERE status = \'confirmed\') AS confirmed, ' +
                '       (SELECT COUNT(*) FROM registrations WHERE status = \'cancelled\') AS cancelled, ' +
                '       (SELECT COUNT(*) FROM users) AS students'
            ) || {};
            var seats = Number(DB.scalar(
                'SELECT COALESCE(SUM(remaining_seats), 0) FROM event_availability'
            )) || 0;

            statsList.textContent = '';
            [['Events', totals.events],
             ['Confirmed registrations', totals.confirmed],
             ['Cancelled registrations', totals.cancelled],
             ['Registered students', totals.students],
             ['Seats remaining', seats]
            ].forEach(function (pair) {
                var item = document.createElement('div');
                item.className = 'stat';
                item.appendChild(Events.el('dt', null, pair[0]));
                item.appendChild(Events.el('dd', null, Number(pair[1] || 0).toLocaleString('en-US')));
                statsList.appendChild(item);
            });
        }

        function renderEvents() {
            var rows = DB.all(
                'SELECT event_id, title, event_date, location, capacity, ' +
                '       confirmed_count, remaining_seats, is_full ' +
                '  FROM event_availability ORDER BY event_date DESC'
            );
            eventsBody.textContent = '';

            if (rows.length === 0) {
                var empty = document.createElement('tr');
                var td = cell('No events exist in the prototype database.');
                td.colSpan = 6;
                empty.appendChild(td);
                eventsBody.appendChild(empty);
                return rows;
            }

            rows.forEach(function (row) {
                var availability = Registration.assessAvailability(row.capacity, row.confirmed_count);
                var isPast = Registration.hasPassed(row.event_date);
                var when = Events.formatEventDate(row.event_date);

                var tr = document.createElement('tr');

                var th = document.createElement('th');
                th.scope = 'row';
                var link = document.createElement('a');
                link.href = Events.eventHref(row.event_id);
                link.textContent = row.title;
                th.appendChild(link);
                tr.appendChild(th);

                tr.appendChild(cell(when.date + ', ' + when.time));
                tr.appendChild(cell(String(row.capacity), 'num'));
                tr.appendChild(cell(String(row.confirmed_count), 'num'));
                tr.appendChild(cell(String(availability.remaining), 'num'));

                var statusCell = document.createElement('td');
                statusCell.appendChild(Events.seatBadge(availability, isPast));
                tr.appendChild(statusCell);

                eventsBody.appendChild(tr);
            });
            return rows;
        }

        function populateEventSelect(rows) {
            var previous = eventSelect.value;
            eventSelect.textContent = '';
            rows.forEach(function (row) {
                var option = document.createElement('option');
                option.value = String(row.event_id);
                option.textContent = row.title;
                eventSelect.appendChild(option);
            });
            if (previous && eventSelect.querySelector('option[value="' + CSS.escape(previous) + '"]')) {
                eventSelect.value = previous;
            }
        }

        function renderAttendees() {
            var idCheck = Validation.validateEventId(eventSelect.value);
            attendeesBody.textContent = '';

            if (!idCheck.valid) {
                attendeeCaption.textContent = 'Attendees';
                announce(attendeeMeta, 'Select an event to list its attendees.');
                return;
            }

            var event = Events.getEvent(idCheck.value);
            if (!event) {
                attendeeCaption.textContent = 'Attendees';
                announce(attendeeMeta, 'That event no longer exists.');
                return;
            }

            var rows = DB.all(
                'SELECT u.full_name, u.student_id, u.email, d.code AS department, ' +
                '       r.registered_at, r.status ' +
                '  FROM registrations r ' +
                '  JOIN users u       ON u.user_id = r.user_id ' +
                '  JOIN departments d ON d.department_id = u.department_id ' +
                ' WHERE r.event_id = ? ' +
                ' ORDER BY r.status, r.registered_at, u.full_name',
                [idCheck.value]
            );

            attendeeCaption.textContent = 'Attendees for ' + event.title;

            if (rows.length === 0) {
                var empty = document.createElement('tr');
                var td = cell('No one has registered for this event yet.');
                td.colSpan = 6;
                empty.appendChild(td);
                attendeesBody.appendChild(empty);
                announce(attendeeMeta, 'No registrations for ' + event.title + ' yet.');
                return;
            }

            rows.forEach(function (row) {
                var tr = document.createElement('tr');
                var th = document.createElement('th');
                th.scope = 'row';
                th.textContent = row.full_name;
                tr.appendChild(th);
                tr.appendChild(cell(row.student_id));
                tr.appendChild(cell(row.email));
                tr.appendChild(cell(row.department));
                tr.appendChild(cell(String(row.registered_at).replace('T', ' ').replace('Z', ' UTC')));
                var statusCell = document.createElement('td');
                statusCell.appendChild(Events.el('span',
                    'badge ' + (row.status === 'confirmed' ? 'badge--open' : 'badge--cancelled'),
                    row.status));
                tr.appendChild(statusCell);
                attendeesBody.appendChild(tr);
            });

            var confirmed = rows.filter(function (row) { return row.status === 'confirmed'; }).length;
            announce(attendeeMeta,
                rows.length + ' registration' + (rows.length === 1 ? '' : 's') +
                ' listed for ' + event.title + ', of which ' + confirmed + ' confirmed.');
        }

        function renderAll() {
            renderStats();
            var rows = renderEvents();
            populateEventSelect(rows);
            renderAttendees();
        }

        DB.init().then(function () {
            renderAll();
            reportDbWarnings(alertBox);
            eventSelect.addEventListener('change', renderAttendees);

            resetButton.addEventListener('click', function () {
                var confirmed = window.confirm(
                    'Reset the prototype database?\n\n' +
                    'All registrations made in this browser will be deleted and the ' +
                    'original sample data will be restored.'
                );
                if (!confirmed) { return; }
                setBusy(resetButton, true, 'Resetting…');
                DB.reset().then(function () {
                    renderAll();
                    setBusy(resetButton, false);
                    setAlert(alertBox, 'success', 'Prototype data restored',
                        'The database was rebuilt from database/schema.sql and database/seed.sql.');
                }).catch(function (error) {
                    setBusy(resetButton, false);
                    setAlert(alertBox, 'error', 'Reset failed',
                        (error && error.message) ? error.message : 'The database could not be rebuilt.');
                });
            });
        }).catch(function (error) {
            fatal(alertBox, error);
            showState(byId('admin-content'), 'Dashboard unavailable',
                'The prototype database could not be opened, so there is nothing to display.', 'h2');
        });
    }

    /* =====================================================================
     * 6. Boot
     * =================================================================== */

    var CONTROLLERS = {
        catalog: initCatalogPage,
        event: initEventPage,
        admin: initAdminPage
    };

    function boot() {
        var page = document.body.getAttribute('data-page');
        markCurrentNav(page);
        var controller = CONTROLLERS[page];
        if (typeof controller === 'function') {
            try {
                controller();
            } catch (error) {
                fatal(byId('page-alert'), error);
            }
        }
    }

    /* Surface otherwise-silent async failures instead of leaving a dead page. */
    window.addEventListener('unhandledrejection', function (event) {
        if (window.console) { window.console.error('Unhandled rejection:', event.reason); }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
}(window, document));
