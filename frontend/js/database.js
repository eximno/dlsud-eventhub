/* =============================================================================
 * database.js - browser-side SQLite access through sql.js (WebAssembly).
 *
 * Responsibilities
 *   - load the WebAssembly build of SQLite (frontend/vendor/sql-wasm.*)
 *   - build the database from database/schema.sql + database/seed.sql
 *   - keep the prototype's state in localStorage between visits
 *   - expose a small query API that ONLY accepts bound parameters
 *
 * SECURITY NOTE: every helper below takes an SQL string plus a parameter
 * array. User input is never concatenated into SQL anywhere in this project.
 * See README.md for why a browser-side database is not a production
 * architecture.
 * ========================================================================== */
window.EventHubDB = (function () {
    'use strict';

    /* Bump when schema.sql changes so stale snapshots are discarded. */
    var SCHEMA_VERSION = 1;
    var STORAGE_KEY = 'dlsud-eventhub.snapshot.v' + SCHEMA_VERSION;
    var LEGACY_KEY_PREFIX = 'dlsud-eventhub.snapshot.v';

    /* Relative candidates so the site works whether GitHub Pages serves the
     * repository root (/frontend/index.html) or the frontend folder itself. */
    var SQL_PATHS = {
        schema: ['../database/schema.sql', 'database/schema.sql'],
        seed: ['../database/seed.sql', 'database/seed.sql']
    };

    var db = null;
    var initPromise = null;
    var state = {
        ready: false,
        source: null,       /* 'snapshot' | 'seed' */
        persistence: 'unknown', /* 'enabled' | 'unavailable' */
        warnings: []
    };

    /* -----------------------------------------------------------------------
     * Loading helpers
     * --------------------------------------------------------------------- */

    function fetchFirstAvailable(candidates, label) {
        var attempts = candidates.slice();

        function next(index) {
            if (index >= attempts.length) {
                return Promise.reject(new Error(
                    'Could not load ' + label + '. Tried: ' + attempts.join(', ')
                ));
            }
            return fetch(attempts[index], { cache: 'no-cache' })
                .then(function (response) {
                    if (!response.ok) { throw new Error('HTTP ' + response.status); }
                    return response.text();
                })
                .then(function (text) {
                    if (!text || !text.trim()) { throw new Error('empty file'); }
                    return text;
                })
                .catch(function () { return next(index + 1); });
        }
        return next(0);
    }

    function loadSqlJs() {
        if (typeof window.initSqlJs !== 'function') {
            return Promise.reject(new Error(
                'The SQLite WebAssembly library did not load (frontend/vendor/sql-wasm.js).'
            ));
        }
        return window.initSqlJs({
            locateFile: function (file) { return 'vendor/' + file; }
        });
    }

    /* -----------------------------------------------------------------------
     * Persistence. Every localStorage access is guarded: private browsing,
     * a full quota or a blocked origin must not break the application.
     * --------------------------------------------------------------------- */

    function storageAvailable() {
        try {
            var probe = '__eventhub_probe__';
            window.localStorage.setItem(probe, '1');
            window.localStorage.removeItem(probe);
            return true;
        } catch {
            /* Private browsing, blocked origin or full quota. */
            return false;
        }
    }

    function bytesToBase64(bytes) {
        var chunk = 0x8000;
        var parts = [];
        for (var i = 0; i < bytes.length; i += chunk) {
            parts.push(String.fromCharCode.apply(
                null, bytes.subarray(i, i + chunk)
            ));
        }
        return window.btoa(parts.join(''));
    }

    function base64ToBytes(text) {
        var binary = window.atob(text);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function dropLegacySnapshots() {
        try {
            for (var i = window.localStorage.length - 1; i >= 0; i -= 1) {
                var key = window.localStorage.key(i);
                if (key && key.indexOf(LEGACY_KEY_PREFIX) === 0 && key !== STORAGE_KEY) {
                    window.localStorage.removeItem(key);
                }
            }
        } catch { /* nothing we can do, and nothing that matters */ }
    }

    function readSnapshot() {
        try {
            var text = window.localStorage.getItem(STORAGE_KEY);
            if (!text) { return null; }
            return base64ToBytes(text);
        } catch {
            state.warnings.push('Saved prototype data could not be read and was ignored.');
            try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
            return null;
        }
    }

    function persist() {
        if (!db || state.persistence !== 'enabled') { return false; }
        try {
            window.localStorage.setItem(STORAGE_KEY, bytesToBase64(db.export()));
            return true;
        } catch {
            /* Most likely QuotaExceededError. Degrade to in-memory only and
             * say so, rather than failing the user's action. */
            state.persistence = 'unavailable';
            state.warnings.push(
                'This browser refused to save the prototype data, so changes will be lost on reload.'
            );
            return false;
        }
    }

    /* -----------------------------------------------------------------------
     * Build / rebuild
     * --------------------------------------------------------------------- */

    function buildFromSql(SQL) {
        return Promise.all([
            fetchFirstAvailable(SQL_PATHS.schema, 'database/schema.sql'),
            fetchFirstAvailable(SQL_PATHS.seed, 'database/seed.sql')
        ]).then(function (sources) {
            var fresh = new SQL.Database();
            fresh.run('PRAGMA foreign_keys = ON;');
            fresh.run(sources[0]);   /* schema.sql */
            fresh.run(sources[1]);   /* seed.sql   */
            return fresh;
        });
    }

    function openSnapshot(SQL, bytes) {
        var restored = new SQL.Database(bytes);
        restored.run('PRAGMA foreign_keys = ON;');
        /* Integrity gate: a snapshot written by an older/broken build must not
         * be trusted just because it parsed. */
        var check = restored.exec(
            "SELECT COUNT(*) FROM sqlite_master " +
            "WHERE type = 'table' AND name IN ('departments','users','events','registrations')"
        );
        var tableCount = check.length ? Number(check[0].values[0][0]) : 0;
        if (tableCount !== 4) {
            restored.close();
            throw new Error('snapshot is missing expected tables');
        }
        restored.exec('SELECT 1 FROM event_availability LIMIT 1');
        return restored;
    }

    function init() {
        if (initPromise) { return initPromise; }

        initPromise = loadSqlJs().then(function (SQL) {
            state.persistence = storageAvailable() ? 'enabled' : 'unavailable';
            if (state.persistence === 'unavailable') {
                state.warnings.push(
                    'Browser storage is unavailable, so registrations will only last until you reload.'
                );
            } else {
                dropLegacySnapshots();
            }

            var snapshot = state.persistence === 'enabled' ? readSnapshot() : null;

            if (snapshot) {
                try {
                    db = openSnapshot(SQL, snapshot);
                    state.source = 'snapshot';
                } catch {
                    state.warnings.push('Saved prototype data was outdated and has been rebuilt.');
                    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
                }
            }

            if (db) {
                state.ready = true;
                return db;
            }

            return buildFromSql(SQL).then(function (fresh) {
                db = fresh;
                state.source = 'seed';
                state.ready = true;
                persist();
                return db;
            });
        }).catch(function (error) {
            initPromise = null;   /* allow an explicit retry */
            throw error;
        });

        return initPromise;
    }

    /** Discard local changes and rebuild from schema.sql + seed.sql. */
    function reset() {
        return loadSqlJs().then(function (SQL) {
            return buildFromSql(SQL).then(function (fresh) {
                if (db) { db.close(); }
                db = fresh;
                state.source = 'seed';
                state.ready = true;
                persist();
                return db;
            });
        });
    }

    /* -----------------------------------------------------------------------
     * Query API - parameter binding only, never string building
     * --------------------------------------------------------------------- */

    function requireDb() {
        if (!db) { throw new Error('The database is not ready yet.'); }
        return db;
    }

    /** @returns {object[]} rows as plain objects. */
    function all(sql, params) {
        var statement = requireDb().prepare(sql);
        var rows = [];
        try {
            statement.bind(params || []);
            while (statement.step()) {
                rows.push(statement.getAsObject());
            }
        } finally {
            statement.free();
        }
        return rows;
    }

    /** @returns {object|null} first row, or null when there is no result. */
    function one(sql, params) {
        var rows = all(sql, params);
        return rows.length ? rows[0] : null;
    }

    /** @returns {number|null} first column of the first row. */
    function scalar(sql, params) {
        var row = one(sql, params);
        if (!row) { return null; }
        var keys = Object.keys(row);
        return keys.length ? row[keys[0]] : null;
    }

    function run(sql, params) {
        var statement = requireDb().prepare(sql);
        try {
            statement.bind(params || []);
            statement.step();
        } finally {
            statement.free();
        }
    }

    function lastInsertId() {
        return Number(scalar('SELECT last_insert_rowid() AS id'));
    }

    /**
     * Run `work` inside a SQLite transaction. Any throw rolls back, so a
     * half-finished registration can never be committed.
     */
    function transaction(work) {
        var connection = requireDb();
        connection.run('BEGIN IMMEDIATE');
        try {
            var result = work();
            connection.run('COMMIT');
            return result;
        } catch (error) {
            try { connection.run('ROLLBACK'); } catch { /* noop */ }
            throw error;
        }
    }

    function getState() {
        return {
            ready: state.ready,
            source: state.source,
            persistence: state.persistence,
            warnings: state.warnings.slice()
        };
    }

    function consumeWarnings() {
        var warnings = state.warnings.slice();
        state.warnings.length = 0;
        return warnings;
    }

    return {
        SCHEMA_VERSION: SCHEMA_VERSION,
        init: init,
        reset: reset,
        all: all,
        one: one,
        scalar: scalar,
        run: run,
        lastInsertId: lastInsertId,
        transaction: transaction,
        persist: persist,
        getState: getState,
        consumeWarnings: consumeWarnings
    };
}());
