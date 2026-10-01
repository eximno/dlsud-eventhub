// =============================================================================
//  DLSUD EventHub - backend registration service (examination deliverable)
//  Task 4, Part B: secure refactor of a deliberately flawed data-access method.
//
//  HOW THIS FILE RELATES TO THE WEBSITE
//  ------------------------------------
//  The public prototype is a static site (GitHub Pages) that runs SQLite in the
//  browser through WebAssembly, so it does NOT execute this C# code. This file
//  is the examination's server-side security exercise: it shows how the same
//  registration rules are implemented correctly against a real SQLite database
//  on a server. The rules below intentionally mirror
//  frontend/js/validation.js, frontend/js/registration.js and the CHECK
//  constraints in database/schema.sql.
//
//  THE ORIGINAL FLAWED METHOD (kept here only as the "before" of the refactor)
//  --------------------------------------------------------------------------
//      public bool RegisterStudent(string email, string eventId)
//      {
//          SqlConnection conn = new SqlConnection("Server=.;Database=EventHub;User Id=sa;Password=P@ssw0rd123;");
//          conn.Open();
//          string sql = "INSERT INTO Registrations (Email, EventId) VALUES ('"
//                     + email + "', " + eventId + ")";
//          SqlCommand cmd = new SqlCommand(sql, conn);
//          int rows = cmd.ExecuteNonQuery();
//          string name = cmd.ExecuteScalar().ToString();   // NullReferenceException
//          return rows > 0;
//      }
//
//  Defects, and how each is fixed below:
//    1. SQL INJECTION - user input concatenated into the statement.
//         -> every statement uses bound parameters ($name), never concatenation.
//    2. HARD-CODED CREDENTIALS in source control.
//         -> the connection string is injected by the caller from
//            configuration/environment; this file contains no credentials.
//    3. UNMANAGED CONNECTION - never closed; leaks on exception.
//         -> `using var` on connection, command, reader and transaction.
//    4. UNMANAGED COMMAND - never disposed.
//         -> `using var` as above.
//    5. UNSAFE NULL HANDLING - ExecuteScalar() may return null.
//         -> results are checked for null/DBNull before use; "no row found" is
//            a normal, explicit outcome rather than an exception.
//    6. NO BUSINESS RULES - no capacity check, no duplicate check, no e-mail
//       rule, so the database could be over-subscribed.
//         -> RegistrationRules + a capacity-guarded conditional INSERT.
// =============================================================================

using System;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace DlsudEventHub.Backend;

// -----------------------------------------------------------------------------
//  Domain types
// -----------------------------------------------------------------------------

/// <summary>Every way a registration attempt can end.</summary>
public enum RegistrationOutcome
{
    Allowed,
    EventNotFound,
    EventPast,
    EventFull,
    Duplicate,
    InvalidEventState,
    InvalidEmail,
    InvalidStudentDetails,
    IdentityConflict
}

/// <summary>Result of the seat calculation for one event.</summary>
public sealed record SeatAvailability(
    bool IsValid,
    int Capacity,
    int ConfirmedCount,
    int RemainingSeats,
    bool IsFull);

/// <summary>Why a registration was allowed or refused.</summary>
public sealed record RegistrationDecision(
    RegistrationOutcome Outcome,
    string Message,
    SeatAvailability? Availability)
{
    public bool Allowed => Outcome == RegistrationOutcome.Allowed;
}

/// <summary>The seat-relevant facts about one event.</summary>
public sealed record EventSeating(
    int EventId,
    string Title,
    int Capacity,
    int ConfirmedCount,
    DateTime EventDate);

/// <summary>A student already on file. Identity in this system is the e-mail.</summary>
public sealed record StudentRecord(int UserId, string StudentId, string Email);

/// <summary>Everything the student submits on the registration form.</summary>
public sealed record RegistrationRequest(
    string FullName,
    string StudentId,
    string Email,
    int DepartmentId);

/// <summary>Proof of a successful registration.</summary>
public sealed record RegistrationReceipt(int RegistrationId, string Reference);

/// <summary>Outcome plus receipt. <c>Receipt</c> is null unless it succeeded.</summary>
public sealed record RegistrationResult(
    RegistrationDecision Decision,
    RegistrationReceipt? Receipt)
{
    public bool Succeeded => Decision.Allowed && Receipt is not null;
}

// -----------------------------------------------------------------------------
//  Business rules - pure, deterministic, independently unit testable.
//  Mirrors frontend/js/validation.js and frontend/js/registration.js.
// -----------------------------------------------------------------------------
public static class RegistrationRules
{
    public const string StudentEmailDomain = "dlsud.edu.ph";
    public const int MaxEmailLength = 100;
    public const int MaxNameLength = 100;
    public const int MinStudentIdLength = 6;
    public const int MaxStudentIdLength = 12;

    // Local part: begins and ends alphanumeric; dots, hyphens and underscores
    // allowed inside. Anchored, so "a@dlsud.edu.ph.fake.com" cannot match.
    private static readonly Regex LocalPartPattern = new(
        "^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex FullNamePattern = new(
        @"^[\p{L}.'\- ]+$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex DigitsOnlyPattern = new(
        "^[0-9]+$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>Canonical form: trimmed and lower-cased. Null-safe.</summary>
    public static string NormalizeEmail(string? value) =>
        value is null ? string.Empty : value.Trim().ToLowerInvariant();

    /// <summary>Collapse internal whitespace and trim. Null-safe.</summary>
    public static string CleanText(string? value) =>
        value is null ? string.Empty : Regex.Replace(value, @"\s+", " ").Trim();

    /// <summary>
    /// The DLSU-D student e-mail rule.
    /// Valid:   juan.delacruz@dlsud.edu.ph
    /// Invalid: @gmail.com, @dlsu.edu.ph, @dlsud.edu, @dlsud.edu.ph.fake.com
    /// </summary>
    public static bool IsValidStudentEmail(string? value)
    {
        string email = NormalizeEmail(value);

        if (email.Length == 0 || email.Length > MaxEmailLength)
        {
            return false;
        }

        // Exactly one "@" - rejects "a@b@dlsud.edu.ph".
        int at = email.IndexOf('@');
        if (at <= 0 || at != email.LastIndexOf('@'))
        {
            return false;
        }

        string localPart = email[..at];
        string domain = email[(at + 1)..];

        // Ordinal comparison of the WHOLE domain, not EndsWith, so a
        // look-alike suffix cannot slip through.
        if (!string.Equals(domain, StudentEmailDomain, StringComparison.Ordinal))
        {
            return false;
        }

        if (localPart.Contains("..", StringComparison.Ordinal))
        {
            return false;
        }

        return LocalPartPattern.IsMatch(localPart);
    }

    public static bool IsValidStudentId(string? value)
    {
        string id = CleanText(value).Replace(" ", string.Empty, StringComparison.Ordinal)
                                    .Replace("-", string.Empty, StringComparison.Ordinal);
        return id.Length >= MinStudentIdLength
            && id.Length <= MaxStudentIdLength
            && DigitsOnlyPattern.IsMatch(id);
    }

    public static bool IsValidFullName(string? value)
    {
        string name = CleanText(value);
        return name.Length >= 2
            && name.Length <= MaxNameLength
            && FullNamePattern.IsMatch(name);
    }

    /// <summary>
    /// Seat maths. Defensive by design: a non-positive capacity makes the event
    /// invalid, a negative count is treated as corrupt, and the remaining-seat
    /// count is clamped at zero so an over-subscribed event reports 0 seats and
    /// stays full instead of re-opening with a negative number.
    /// </summary>
    public static SeatAvailability AssessSeats(int capacity, int confirmedCount)
    {
        if (capacity <= 0 || confirmedCount < 0)
        {
            return new SeatAvailability(
                IsValid: false,
                Capacity: capacity < 0 ? 0 : capacity,
                ConfirmedCount: confirmedCount < 0 ? 0 : confirmedCount,
                RemainingSeats: 0,
                IsFull: true);
        }

        int remaining = Math.Max(capacity - confirmedCount, 0);
        return new SeatAvailability(
            IsValid: true,
            Capacity: capacity,
            ConfirmedCount: confirmedCount,
            RemainingSeats: remaining,
            IsFull: confirmedCount >= capacity);
    }

    /// <summary>
    /// The registration decision. Duplicate is reported before capacity so an
    /// already-registered student is not told, misleadingly, that the event is
    /// full.
    /// </summary>
    public static RegistrationDecision Decide(
        EventSeating? seating,
        bool alreadyRegistered,
        DateTime now)
    {
        if (seating is null)
        {
            return new RegistrationDecision(
                RegistrationOutcome.EventNotFound,
                "That event could not be found.",
                null);
        }

        SeatAvailability availability =
            AssessSeats(seating.Capacity, seating.ConfirmedCount);

        if (!availability.IsValid)
        {
            return new RegistrationDecision(
                RegistrationOutcome.InvalidEventState,
                "This event has an invalid capacity and is not open for registration.",
                availability);
        }

        if (alreadyRegistered)
        {
            return new RegistrationDecision(
                RegistrationOutcome.Duplicate,
                "This student e-mail address is already registered for this event.",
                availability);
        }

        if (seating.EventDate < now)
        {
            return new RegistrationDecision(
                RegistrationOutcome.EventPast,
                "This event has already taken place, so registration is closed.",
                availability);
        }

        if (availability.IsFull)
        {
            return new RegistrationDecision(
                RegistrationOutcome.EventFull,
                "This event is already at full capacity. No seats remain.",
                availability);
        }

        return new RegistrationDecision(
            RegistrationOutcome.Allowed,
            string.Empty,
            availability);
    }

    public static string BuildReference(int eventId, int registrationId) =>
        string.Format(
            CultureInfo.InvariantCulture,
            "EH-{0:D3}-{1:D4}",
            eventId,
            registrationId);
}

// -----------------------------------------------------------------------------
//  Persistence boundary. The service depends on this interface, not on SQLite,
//  so the business flow can be unit tested with mock objects (see
//  tests/RegistrationServiceTests.cs) without a database.
// -----------------------------------------------------------------------------
public interface IRegistrationRepository
{
    /// <summary>Returns null when the event does not exist.</summary>
    EventSeating? GetEventSeating(int eventId);

    /// <summary>Returns null when no student has that e-mail address.</summary>
    StudentRecord? FindStudentByEmail(string email);

    /// <summary>Returns null when no student has that student number.</summary>
    StudentRecord? FindStudentByStudentId(string studentId);

    bool HasConfirmedRegistration(int userId, int eventId);

    int CreateStudent(RegistrationRequest request);

    void UpdateStudentProfile(int userId, string fullName, int departmentId);

    /// <summary>
    /// Inserts a confirmed registration only while the event still has a free
    /// seat. Returns the new registration id, or null when the insert was
    /// rejected because the event filled up first.
    /// </summary>
    int? CreateRegistrationIfSeatAvailable(int userId, int eventId);
}

// -----------------------------------------------------------------------------
//  The service: validation -> decision -> persistence. No SQL lives here.
// -----------------------------------------------------------------------------
public sealed class RegistrationService
{
    private readonly IRegistrationRepository _repository;
    private readonly Func<DateTime> _clock;

    /// <param name="repository">Persistence boundary (mockable).</param>
    /// <param name="clock">
    /// Supplies "now". Injected so that date-sensitive rules can be tested
    /// without waiting for real time to pass. Defaults to UTC now.
    /// </param>
    public RegistrationService(IRegistrationRepository repository, Func<DateTime>? clock = null)
    {
        _repository = repository ?? throw new ArgumentNullException(nameof(repository));
        _clock = clock ?? (() => DateTime.UtcNow);
    }

    public RegistrationResult Register(int eventId, RegistrationRequest request)
    {
        if (request is null)
        {
            return Refuse(RegistrationOutcome.InvalidStudentDetails,
                "No registration details were submitted.");
        }

        if (eventId <= 0)
        {
            return Refuse(RegistrationOutcome.EventNotFound,
                "That event could not be found.");
        }

        // --- 1. Field rules (cheapest checks first, before touching the DB) --
        string email = RegistrationRules.NormalizeEmail(request.Email);
        if (!RegistrationRules.IsValidStudentEmail(email))
        {
            return Refuse(RegistrationOutcome.InvalidEmail,
                $"Only @{RegistrationRules.StudentEmailDomain} student e-mail addresses can register.");
        }

        string fullName = RegistrationRules.CleanText(request.FullName);
        string studentId = RegistrationRules.CleanText(request.StudentId)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace("-", string.Empty, StringComparison.Ordinal);

        if (!RegistrationRules.IsValidFullName(fullName)
            || !RegistrationRules.IsValidStudentId(studentId)
            || request.DepartmentId <= 0)
        {
            return Refuse(RegistrationOutcome.InvalidStudentDetails,
                "Check your full name, student number and department, then try again.");
        }

        RegistrationRequest clean = request with
        {
            FullName = fullName,
            StudentId = studentId,
            Email = email
        };

        // --- 2. Read current state ------------------------------------------
        EventSeating? seating = _repository.GetEventSeating(eventId);
        StudentRecord? student = _repository.FindStudentByEmail(email);

        // Identity guard: the e-mail is on file under a different student
        // number, so writing to it would overwrite someone else's record.
        if (student is not null
            && !string.Equals(student.StudentId, studentId, StringComparison.Ordinal))
        {
            return Refuse(RegistrationOutcome.IdentityConflict,
                "This e-mail address is already on file under a different student number.");
        }

        if (student is null)
        {
            StudentRecord? owner = _repository.FindStudentByStudentId(studentId);
            if (owner is not null)
            {
                return Refuse(RegistrationOutcome.IdentityConflict,
                    "That student number is already registered with a different e-mail address.");
            }
        }

        bool alreadyRegistered = student is not null
            && _repository.HasConfirmedRegistration(student.UserId, eventId);

        // --- 3. Decide ------------------------------------------------------
        RegistrationDecision decision =
            RegistrationRules.Decide(seating, alreadyRegistered, _clock());

        if (!decision.Allowed)
        {
            return new RegistrationResult(decision, null);
        }

        // --- 4. Write -------------------------------------------------------
        int userId = student?.UserId ?? _repository.CreateStudent(clean);
        if (student is not null)
        {
            _repository.UpdateStudentProfile(userId, clean.FullName, clean.DepartmentId);
        }

        // The insert is guarded by the capacity check in SQL, so two concurrent
        // requests for the last seat cannot both succeed. A null result means
        // the seat was taken between the decision and the insert.
        int? registrationId = _repository.CreateRegistrationIfSeatAvailable(userId, eventId);
        if (registrationId is null)
        {
            return new RegistrationResult(
                new RegistrationDecision(
                    RegistrationOutcome.EventFull,
                    "The last seat was taken while you were registering. No seats remain.",
                    decision.Availability),
                null);
        }

        return new RegistrationResult(
            decision,
            new RegistrationReceipt(
                registrationId.Value,
                RegistrationRules.BuildReference(eventId, registrationId.Value)));
    }

    private static RegistrationResult Refuse(RegistrationOutcome outcome, string message) =>
        new(new RegistrationDecision(outcome, message, null), null);
}

// -----------------------------------------------------------------------------
//  SQLite implementation. This is the part the security refactor is about.
//
//  Every statement:
//    * uses bound parameters - no user value is ever concatenated into SQL;
//    * owns its connection, command and reader with `using var`, so they are
//      disposed even when an exception is thrown;
//    * treats "no row" and DBNull as normal, expected values.
//
//  The connection string is supplied by the caller (appsettings.json, user
//  secrets or an environment variable). No credentials appear in this file.
// -----------------------------------------------------------------------------
public sealed class SqliteRegistrationRepository : IRegistrationRepository
{
    private const string EventDateFormat = "yyyy-MM-ddTHH:mm";

    private readonly string _connectionString;

    /// <param name="connectionString">
    /// For example "Data Source=eventhub.db". Read from configuration by the
    /// caller - never hard-coded here.
    /// </param>
    public SqliteRegistrationRepository(string connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new ArgumentException(
                "A connection string must be supplied from configuration.",
                nameof(connectionString));
        }
        _connectionString = connectionString;
    }

    private SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        // Foreign keys are OFF by default in SQLite and must be enabled per
        // connection, otherwise the schema's FK constraints are not enforced.
        using (SqliteCommand pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA foreign_keys = ON;";
            pragma.ExecuteNonQuery();
        }
        return connection;
    }

    public EventSeating? GetEventSeating(int eventId)
    {
        using SqliteConnection connection = OpenConnection();
        using SqliteCommand command = connection.CreateCommand();

        command.CommandText =
            @"SELECT e.event_id,
                     e.title,
                     e.capacity,
                     e.event_date,
                     (SELECT COUNT(*)
                        FROM registrations r
                       WHERE r.event_id = e.event_id
                         AND r.status   = 'confirmed') AS confirmed_count
                FROM events e
               WHERE e.event_id = $eventId;";
        command.Parameters.AddWithValue("$eventId", eventId);

        using SqliteDataReader reader = command.ExecuteReader();

        // No row is a normal outcome, not an exception and not a null deref.
        if (!reader.Read())
        {
            return null;
        }

        string rawDate = reader.IsDBNull(3) ? string.Empty : reader.GetString(3);
        if (!DateTime.TryParseExact(
                rawDate,
                EventDateFormat,
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out DateTime eventDate))
        {
            // A stored date we cannot parse must not crash the request, and
            // must not be treated as "in the past" either.
            eventDate = DateTime.MaxValue;
        }

        return new EventSeating(
            EventId: reader.GetInt32(0),
            Title: reader.IsDBNull(1) ? string.Empty : reader.GetString(1),
            Capacity: reader.IsDBNull(2) ? 0 : reader.GetInt32(2),
            ConfirmedCount: reader.IsDBNull(4) ? 0 : reader.GetInt32(4),
            EventDate: eventDate);
    }

    // Each lookup holds its own complete, constant SQL string. The two queries
    // differ by one column, which would be tempting to pass in as a predicate
    // and concatenate - but then CommandText would no longer be a constant,
    // and "we never build SQL by concatenation" would stop being true. A
    // duplicated literal is the cheaper price.
    public StudentRecord? FindStudentByEmail(string email)
    {
        using SqliteConnection connection = OpenConnection();
        using SqliteCommand command = connection.CreateCommand();

        command.CommandText =
            @"SELECT u.user_id, u.student_id, u.email
                FROM users u
               WHERE u.email = $email
               LIMIT 1;";
        command.Parameters.AddWithValue("$email", RegistrationRules.NormalizeEmail(email));

        using SqliteDataReader reader = command.ExecuteReader();
        return ReadStudent(reader);
    }

    public StudentRecord? FindStudentByStudentId(string studentId)
    {
        using SqliteConnection connection = OpenConnection();
        using SqliteCommand command = connection.CreateCommand();

        command.CommandText =
            @"SELECT u.user_id, u.student_id, u.email
                FROM users u
               WHERE u.student_id = $studentId
               LIMIT 1;";
        command.Parameters.AddWithValue("$studentId", RegistrationRules.CleanText(studentId));

        using SqliteDataReader reader = command.ExecuteReader();
        return ReadStudent(reader);
    }

    /// <summary>Maps the first row, or null when the query matched nothing.</summary>
    private static StudentRecord? ReadStudent(SqliteDataReader reader)
    {
        if (!reader.Read())
        {
            return null;
        }

        return new StudentRecord(
            UserId: reader.GetInt32(0),
            StudentId: reader.IsDBNull(1) ? string.Empty : reader.GetString(1),
            Email: reader.IsDBNull(2) ? string.Empty : reader.GetString(2));
    }

    public bool HasConfirmedRegistration(int userId, int eventId)
    {
        using SqliteConnection connection = OpenConnection();
        using SqliteCommand command = connection.CreateCommand();

        command.CommandText =
            @"SELECT COUNT(*)
                FROM registrations
               WHERE user_id  = $userId
                 AND event_id = $eventId
                 AND status   = 'confirmed';";
        command.Parameters.AddWithValue("$userId", userId);
        command.Parameters.AddWithValue("$eventId", eventId);

        // ExecuteScalar can return null; it is checked instead of dereferenced.
        object? result = command.ExecuteScalar();
        return result is not null
            && result != DBNull.Value
            && Convert.ToInt64(result, CultureInfo.InvariantCulture) > 0L;
    }

    public int CreateStudent(RegistrationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        using SqliteConnection connection = OpenConnection();
        using SqliteTransaction transaction = connection.BeginTransaction();
        using SqliteCommand command = connection.CreateCommand();

        command.Transaction = transaction;
        command.CommandText =
            @"INSERT INTO users (student_id, full_name, email, department_id)
              VALUES ($studentId, $fullName, $email, $departmentId)
              RETURNING user_id;";
        command.Parameters.AddWithValue("$studentId", request.StudentId);
        command.Parameters.AddWithValue("$fullName", request.FullName);
        command.Parameters.AddWithValue("$email", RegistrationRules.NormalizeEmail(request.Email));
        command.Parameters.AddWithValue("$departmentId", request.DepartmentId);

        object? inserted = command.ExecuteScalar();
        if (inserted is null || inserted == DBNull.Value)
        {
            // Nothing was written: roll back rather than leave a half state.
            transaction.Rollback();
            throw new InvalidOperationException("The student record could not be created.");
        }

        transaction.Commit();
        return Convert.ToInt32(inserted, CultureInfo.InvariantCulture);
    }

    public void UpdateStudentProfile(int userId, string fullName, int departmentId)
    {
        using SqliteConnection connection = OpenConnection();
        using SqliteCommand command = connection.CreateCommand();

        command.CommandText =
            @"UPDATE users
                 SET full_name     = $fullName,
                     department_id = $departmentId
               WHERE user_id = $userId;";
        command.Parameters.AddWithValue("$fullName", RegistrationRules.CleanText(fullName));
        command.Parameters.AddWithValue("$departmentId", departmentId);
        command.Parameters.AddWithValue("$userId", userId);

        command.ExecuteNonQuery();
    }

    public int? CreateRegistrationIfSeatAvailable(int userId, int eventId)
    {
        using SqliteConnection connection = OpenConnection();
        using SqliteTransaction transaction = connection.BeginTransaction();
        using SqliteCommand command = connection.CreateCommand();

        command.Transaction = transaction;

        // The WHERE clause re-counts confirmed seats as part of the INSERT, so
        // the capacity rule is enforced by the database itself. Combined with
        // the UNIQUE (user_id, event_id) constraint, neither over-subscription
        // nor a duplicate can be committed, even under concurrent requests.
        command.CommandText =
            @"INSERT INTO registrations (user_id, event_id, status)
              SELECT $userId, $eventId, 'confirmed'
               WHERE (SELECT COUNT(*)
                        FROM registrations r
                       WHERE r.event_id = $eventId
                         AND r.status   = 'confirmed')
                     < (SELECT e.capacity FROM events e WHERE e.event_id = $eventId)
              RETURNING registration_id;";
        command.Parameters.AddWithValue("$userId", userId);
        command.Parameters.AddWithValue("$eventId", eventId);

        object? inserted = command.ExecuteScalar();

        if (inserted is null || inserted == DBNull.Value)
        {
            // No row was inserted: the event filled up first. Not an error.
            transaction.Rollback();
            return null;
        }

        transaction.Commit();
        return Convert.ToInt32(inserted, CultureInfo.InvariantCulture);
    }
}
