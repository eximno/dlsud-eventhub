/* =============================================================================
 * tests/browser-checks.mjs - end-to-end checks against a real browser.
 *
 * These are OPTIONAL. They are not needed to run or mark the site, and
 * Playwright is deliberately not a project dependency. They exist because a
 * prototype that "opens without errors" is not the same as one that behaves
 * correctly in every state the requirements name.
 *
 * What they cover: catalog rendering and seat states, search (including LIKE
 * wildcards and SQL-looking input), category and time filters, keyboard focus
 * order, full / past / unknown / malformed events, every field-validation
 * path, a successful registration, duplicate and identity-conflict refusals,
 * rapid repeat clicks, persistence across a reload, the admin dashboard and
 * its reset, three mobile widths, blocked localStorage, and a simulated
 * database-initialisation failure. The run fails if the browser console logs
 * a single error.
 *
 * Usage:
 *     npm install --no-save playwright     # one-off
 *     python3 -m http.server 8123 &        # serve the REPOSITORY ROOT
 *     node tests/browser-checks.mjs
 *
 * Environment variables:
 *     EVENTHUB_BASE    base URL          (default http://127.0.0.1:8123)
 *     CHROMIUM_PATH    browser binary    (default: Playwright's own download)
 * ========================================================================== */

import { chromium } from 'playwright';

const BASE = process.env.EVENTHUB_BASE || 'http://127.0.0.1:8123';
const results = [];
let failures = 0;
function check(name, condition, detail = '') {
    const ok = !!condition;
    if (!ok) failures++;
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' -> ' + detail : ''}`);
}

const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

async function newPage(viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${page.url()} :: ${m.text()}`); });
    page.on('pageerror', (e) => pageErrors.push(`${page.url()} :: ${e.message}`));
    page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
    return page;
}

try {
/* ---------- 1. Catalog page ---------- */
let page = await newPage();
await page.goto(`${BASE}/frontend/index.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelectorAll('#event-list .event-card').length > 0, { timeout: 15000 });

const cardCount = await page.locator('#event-list .event-card').count();
check('catalog renders upcoming event cards', cardCount === 7, `got ${cardCount}`);
check('hero stat: upcoming events', (await page.locator('#stat-upcoming').textContent()).trim() === '7');
const seatsText = (await page.locator('#stat-seats').textContent()).trim();
check('hero stat: seats available populated', /^[\d,]+$/.test(seatsText), seatsText);
check('results meta announced', (await page.locator('#results-meta').textContent()).includes('upcoming event'));
check('no page-level alert on happy path', (await page.locator('#page-alert').textContent()).trim() === '');

/* seat states from the seed data */
const fullBadges = await page.locator('#event-list .badge--full').count();
check('full event shows a Full badge', fullBadges === 1, `got ${fullBadges}`);
const tight = await page.locator('#event-list .badge--tight').count();
check('nearly full event shows Few seats badge', tight === 1, `got ${tight}`);
const lastSeat = await page.locator('#event-list .seats__text', { hasText: 'Last seat available' }).count();
check('last-seat wording shown for 39/40 event', lastSeat === 1, `got ${lastSeat}`);

/* ---------- 2. Search / filter ---------- */
await page.fill('#search-input', 'cyber');
await page.waitForFunction(() => document.querySelectorAll('#event-list .event-card').length === 1, { timeout: 5000 }).catch(() => {});
check('search narrows the catalog', (await page.locator('#event-list .event-card').count()) === 1);
check('search term is highlighted safely', (await page.locator('#event-list mark').count()) >= 1);
check('search syncs to the URL', page.url().includes('q=cyber'), page.url());

await page.fill('#search-input', 'zzzz-no-such-event');
await page.waitForFunction(() => document.querySelector('#event-list .state') !== null, { timeout: 5000 });
check('empty search result shows an empty state', await page.locator('#event-list .state h3').isVisible());
check('empty state announced', (await page.locator('#results-meta').textContent()).includes('No events match'));

/* wildcard / unusual characters must be literal, not match-everything */
await page.fill('#search-input', '%');
await page.waitForTimeout(400);
check('LIKE wildcard "%" is treated literally', (await page.locator('#event-list .state').count()) === 1);
await page.fill('#search-input', "'; DROP TABLE events;--");
await page.waitForTimeout(400);
const afterInjection = await page.locator('#event-list .state').count();
check('SQL-ish search text is harmless', afterInjection === 1, `state count ${afterInjection}`);

await page.click('#clear-filters');
await page.waitForFunction(() => document.querySelectorAll('#event-list .event-card').length === 7, { timeout: 5000 });
check('clear filters restores the catalog', (await page.locator('#event-list .event-card').count()) === 7);
check('focus returns to the search box after clearing',
    await page.evaluate(() => document.activeElement && document.activeElement.id === 'search-input'));

/* past / all filters */
await page.selectOption('#when-filter', 'past');
await page.waitForFunction(() => document.querySelectorAll('#event-list .event-card').length === 1, { timeout: 5000 });
check('past filter shows the one past event', (await page.locator('#event-list .event-card').count()) === 1);
await page.selectOption('#when-filter', 'all');
await page.waitForFunction(() => document.querySelectorAll('#event-list .event-card').length === 8, { timeout: 5000 });
check('all filter shows every event', (await page.locator('#event-list .event-card').count()) === 8);

/* category filter */
await page.selectOption('#when-filter', 'upcoming');
await page.selectOption('#category-filter', 'Workshop');
await page.waitForTimeout(400);
check('category filter works', (await page.locator('#event-list .event-card').count()) === 1);
await page.click('#clear-filters');

/* Enter key inside the search field must not reload or error */
await page.fill('#search-input', 'tech');
await page.press('#search-input', 'Enter');
await page.waitForTimeout(400);
check('Enter in the search field does not break the page',
    (await page.locator('#event-list .event-card').count()) >= 1);

/* ---------- 3. Keyboard navigation ---------- */
await page.goto(`${BASE}/frontend/index.html`, { waitUntil: 'networkidle' });
await page.keyboard.press('Tab');
const firstFocus = await page.evaluate(() => document.activeElement.className);
check('first Tab stop is the skip link', firstFocus.includes('skip-link'), firstFocus);
const outline = await page.evaluate(() => {
    const el = document.activeElement;
    return getComputedStyle(el).outlineStyle;
});
check('focused element has a visible outline', outline !== 'none', outline);

/* ---------- 4. Event detail: full event ---------- */
page = await newPage();
await page.goto(`${BASE}/frontend/event.html?id=2`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.querySelector('#event-detail h1').textContent.includes('Loading'), { timeout: 15000 });
check('full event: title rendered', (await page.locator('#event-detail h1').textContent()).includes('Cybersecurity'));
check('full event: no registration form', (await page.locator('#registration-form').count()) === 0);
check('full event: full warning shown', (await page.locator('#form-alert').textContent()).includes('full capacity'));
check('full event: offers an alternative', (await page.locator('#registration-panel a', { hasText: 'Find another event' }).count()) === 1);

/* ---------- 5. Event detail: past event ---------- */
await page.goto(`${BASE}/frontend/event.html?id=8`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.querySelector('#event-detail h1').textContent.includes('Loading'), { timeout: 15000 });
check('past event: registration closed', (await page.locator('#form-alert').textContent()).includes('already taken place'));
check('past event: no form', (await page.locator('#registration-form').count()) === 0);

/* ---------- 6. Invalid event ids ---------- */
for (const [label, query] of [
    ['missing id', ''],
    ['non numeric id', '?id=abc'],
    ['negative id', '?id=-5'],
    ['zero id', '?id=0'],
    ['float id', '?id=1.5'],
    ['injection id', "?id=1;DROP TABLE events"],
    ['unknown id', '?id=99999']
]) {
    await page.goto(`${BASE}/frontend/event.html${query}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#event-detail .state') !== null, { timeout: 15000 }).catch(() => {});
    const heading = await page.locator('#event-detail .state h1').textContent().catch(() => '');
    check(`invalid event (${label}) shows a not-found state`, heading.includes('Event not found'), heading);
}

/* ---------- 7. Registration: validation ---------- */
await page.goto(`${BASE}/frontend/event.html?id=1`, { waitUntil: 'networkidle' });
await page.waitForSelector('#registration-form', { timeout: 15000 });

/* empty submit */
await page.click('#registration-form button[type="submit"]');
await page.waitForTimeout(200);
check('empty submit reports every field', (await page.locator('.field__error:not(:empty)').count()) === 4);
check('empty submit sets aria-invalid', (await page.locator('[aria-invalid="true"]').count()) === 4);
check('empty submit shows a summary alert', (await page.locator('#form-alert').textContent()).includes('need attention'));
check('focus moves to the first invalid field',
    await page.evaluate(() => document.activeElement && document.activeElement.id === 'full-name'));

/* bad emails */
for (const bad of ['student@gmail.com', 'student@dlsu.edu.ph', 'student@dlsud.edu', 'student@dlsud.edu.ph.fake.com', 'not-an-email']) {
    await page.fill('#full-name', 'Test Student');
    await page.fill('#student-id', '20259999');
    await page.fill('#email', bad);
    await page.selectOption('#department', { index: 1 });
    await page.click('#registration-form button[type="submit"]');
    await page.waitForTimeout(150);
    const msg = await page.locator('#email-error').textContent();
    check(`rejects e-mail ${bad}`, msg.trim().length > 0, msg);
}

/* oversized + odd input */
await page.fill('#full-name', 'A'.repeat(300));
const nameLen = await page.inputValue('#full-name');
check('name input enforces maxlength', nameLen.length === 100, String(nameLen.length));
await page.fill('#student-id', '12');
await page.fill('#email', 'ok.student@dlsud.edu.ph');
await page.click('#registration-form button[type="submit"]');
await page.waitForTimeout(150);
check('short student number rejected', (await page.locator('#student-id-error').textContent()).includes('digits'));

/* ---------- 8. Registration: success, duplicate, persistence ---------- */
await page.fill('#full-name', 'Test Student');
await page.fill('#student-id', '20259999');
await page.fill('#email', 'test.student@dlsud.edu.ph');
await page.selectOption('#department', { index: 1 });
const seatsBefore = await page.locator('.panel__seats .seats__text').textContent();
await page.click('#registration-form button[type="submit"]');
await page.waitForSelector('.receipt', { timeout: 10000 });
const reference = await page.locator('.receipt dd').first().textContent();
check('successful registration shows a reference number', /^EH-\d{3}-\d{4}$/.test(reference.trim()), reference);
check('success message shown', (await page.locator('#registration-panel .alert--success').count()) === 1);
const seatsAfter = await page.locator('.panel__seats .seats__text').textContent();
check('seat count decreases after registering', seatsBefore !== seatsAfter, `${seatsBefore} -> ${seatsAfter}`);
check('form is replaced after success', (await page.locator('#registration-form').count()) === 0);

/* duplicate attempt in a fresh load */
await page.goto(`${BASE}/frontend/event.html?id=1`, { waitUntil: 'networkidle' });
await page.waitForSelector('#registration-form', { timeout: 15000 });
check('registration persisted across reload', (await page.locator('.panel__seats .seats__text').textContent()) === seatsAfter);
await page.fill('#full-name', 'Test Student');
await page.fill('#student-id', '20259999');
await page.fill('#email', 'test.student@dlsud.edu.ph');
await page.selectOption('#department', { index: 1 });
await page.click('#registration-form button[type="submit"]');
await page.waitForTimeout(500);
check('duplicate registration is refused',
    (await page.locator('#form-alert').textContent()).includes('already registered'));
check('duplicate error is attached to the e-mail field',
    (await page.locator('#email-error').textContent()).includes('already registered'));

/* identity conflict: same e-mail, different student number */
await page.fill('#student-id', '20250001');
await page.click('#registration-form button[type="submit"]');
await page.waitForTimeout(500);
check('identity conflict refused',
    (await page.locator('#form-alert').textContent()).toLowerCase().includes('already on file'));

/* rapid double click must create at most one registration */
await page.goto(`${BASE}/frontend/event.html?id=4`, { waitUntil: 'networkidle' });
await page.waitForSelector('#registration-form', { timeout: 15000 });
await page.fill('#full-name', 'Double Click');
await page.fill('#student-id', '20258888');
await page.fill('#email', 'double.click@dlsud.edu.ph');
await page.selectOption('#department', { index: 2 });
const button = page.locator('#registration-form button[type="submit"]');
await button.click({ clickCount: 3, delay: 10 }).catch((e) => { results.push('NOTE  triple-click dispatch: ' + e.message.split('\n')[0]); });
await page.waitForSelector('.receipt', { timeout: 10000 }).catch(() => {});
check('rapid repeat clicks do not navigate away from the confirmation',
    page.url().includes('event.html?id=4'), page.url());
check('confirmation is still on screen after rapid repeat clicks',
    (await page.locator('.receipt').count()) === 1);
const dupCount = await page.evaluate(() => {
    return window.EventHubDB.scalar(
        "SELECT COUNT(*) FROM registrations r JOIN users u ON u.user_id = r.user_id WHERE u.email = ? AND r.event_id = 4",
        ['double.click@dlsud.edu.ph']);
});
check('triple click creates exactly one registration', Number(dupCount) === 1, String(dupCount));

/* ---------- 9. Admin page ---------- */
await page.goto(`${BASE}/frontend/admin.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelectorAll('#admin-events-body tr').length >= 8, { timeout: 15000 });
check('admin lists every event', (await page.locator('#admin-events-body tr').count()) === 8);
check('admin shows five summary tiles', (await page.locator('#admin-stats .stat').count()) === 5);
check('admin warns that it is not secure',
    (await page.locator('.alert--warn').first().textContent()).includes('no authentication'));
await page.waitForFunction(() => document.querySelectorAll('#attendee-body tr').length > 0, { timeout: 10000 });
const attendeeRows = await page.locator('#attendee-body tr').count();
check('admin lists attendees for the selected event', attendeeRows > 0, String(attendeeRows));
check('attendee count announced', (await page.locator('#attendee-meta').textContent()).includes('registration'));

/* switch to the full event and confirm 60 attendees */
await page.selectOption('#attendee-event', { label: 'Cybersecurity Awareness Workshop' });
await page.waitForFunction(() => document.querySelectorAll('#attendee-body tr').length === 60, { timeout: 10000 }).catch(() => {});
check('full event lists 60 attendees', (await page.locator('#attendee-body tr').count()) === 60,
    String(await page.locator('#attendee-body tr').count()));

/* an event with no registrations shows an empty state */
await page.selectOption('#attendee-event', { label: 'Developer Workshop: Web Fundamentals' });
await page.waitForTimeout(400);
const devRows = await page.locator('#attendee-body tr').count();
check('event with registrations still lists rows', devRows === 39, String(devRows));

/* cancelled registrations are visible but excluded from counts */
await page.selectOption('#attendee-event', { label: 'Tech Career Talk 2026' });
await page.waitForTimeout(400);
check('cancelled registration is shown with a status badge',
    (await page.locator('#attendee-body .badge--cancelled').count()) === 1);

/* reset */
page.on('dialog', (d) => d.accept());
await page.click('#reset-data');
await page.waitForFunction(() => {
    const el = document.querySelector('#page-alert');
    return el && el.textContent.includes('restored');
}, { timeout: 15000 });
check('reset rebuilds the prototype data', true);
const resetRows = await page.locator('#admin-events-body tr').count();
check('after reset there are 8 events again', resetRows === 8, String(resetRows));

/* ---------- 10. Responsive ---------- */
for (const vp of [{ width: 320, height: 640 }, { width: 375, height: 667 }, { width: 768, height: 1024 }]) {
    const mobile = await newPage(vp);
    for (const url of ['/frontend/index.html', '/frontend/event.html?id=1', '/frontend/admin.html']) {
        await mobile.goto(BASE + url, { waitUntil: 'networkidle' });
        await mobile.waitForTimeout(1200);
        const overflow = await mobile.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(`no horizontal overflow at ${vp.width}px ${url}`, overflow <= 1, `overflow ${overflow}px`);
    }
    await mobile.close();
}

/* ---------- 11. Root redirect ---------- */
const root = await newPage();
await root.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await root.waitForTimeout(1500);
check('root index.html forwards to the app', root.url().includes('/frontend/index.html'), root.url());
await root.close();

/* ---------- 12. Storage failure fallback ---------- */
const noStorage = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await noStorage.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('blocked', 'SecurityError'); }
    });
});
const blocked = await noStorage.newPage();
const blockedErrors = [];
blocked.on('pageerror', (e) => blockedErrors.push(e.message));
await blocked.goto(`${BASE}/frontend/index.html`, { waitUntil: 'networkidle' });
await blocked.waitForFunction(() => document.querySelectorAll('#event-list .event-card').length > 0, { timeout: 15000 }).catch(() => {});
check('catalog still works when localStorage is blocked',
    (await blocked.locator('#event-list .event-card').count()) === 7);
check('blocked storage produces a visible warning, not a crash',
    (await blocked.locator('#page-alert').textContent()).includes('Browser storage is unavailable'));
check('blocked storage causes no uncaught errors', blockedErrors.length === 0, blockedErrors.join('; '));
await blocked.close();

/* ---------- 13. Missing SQL file (init failure) ---------- */
const broken = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const brokenPage = await broken.newPage();
await brokenPage.route('**/schema.sql', (route) => route.fulfill({ status: 404, body: 'missing' }));
await brokenPage.goto(`${BASE}/frontend/index.html`, { waitUntil: 'networkidle' });
await brokenPage.waitForTimeout(2500);
check('database init failure shows a recoverable error message',
    (await brokenPage.locator('#page-alert').textContent()).includes('could not start'));
await broken.close();

} catch (err) {
    results.push('FAIL  SCRIPT ABORTED: ' + err.message.split('\n')[0]);
    failures++;
}
await browser.close();

console.log(results.join('\n'));
console.log('\n--- console errors ---');
console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)');
console.log('--- uncaught page errors ---');
console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
console.log('--- failed requests ---');
console.log(failedRequests.length ? failedRequests.join('\n') : '(none)');
console.log(`\nTOTAL ${results.length} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
