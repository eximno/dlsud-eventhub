// =============================================================================
//  DLSUD EventHub - unit tests (examination deliverable, Task 4 Part A)
//
//  These tests verify the REQUIREMENTS of the system, not the shape of the
//  implementation:
//    * only @dlsud.edu.ph student addresses may register;
//    * a student may not register twice for the same event;
//    * registration is refused once capacity is reached;
//    * a corrupted event state (capacity <= 0, over-subscribed) is refused
//      safely instead of producing negative seat counts;
//    * a past event is closed;
//    * the database is only written to when all rules pass.
//
//  The database is isolated with Moq: RegistrationService depends on
//  IRegistrationRepository, so no SQLite file is needed and the tests can
//  assert that no write happens on a refusal.
//
//  Run with:  dotnet test
// =============================================================================

using System;
using DlsudEventHub.Backend;
using Moq;
using Xunit;

namespace DlsudEventHub.Tests;

public class RegistrationRulesEmailTests
{
    [Theory]
    [InlineData("student@dlsud.edu.ph")]
    [InlineData("juan.delacruz@dlsud.edu.ph")]
    [InlineData("maria_santos@dlsud.edu.ph")]
    [InlineData("jose-rizal@dlsud.edu.ph")]
    [InlineData("student123@dlsud.edu.ph")]
    [InlineData("  Student@DLSUD.edu.ph  ")]   // trimmed and lower-cased first
    public void Accepts_valid_dlsud_student_addresses(string email)
    {
        Assert.True(RegistrationRules.IsValidStudentEmail(email));
    }

    [Theory]
    // --- another school / another provider -----------------------------------
    [InlineData("student@gmail.com")]
    [InlineData("student@yahoo.com")]
    [InlineData("student@dlsu.edu.ph")]          // DLSU Manila, not DLSU-D
    [InlineData("student@dlsud.edu")]            // truncated domain
    [InlineData("student@dlsud.edu.ph.fake.com")]// look-alike suffix
    [InlineData("student@sub.dlsud.edu.ph")]     // subdomain is not the domain
    [InlineData("student@dlsud.edu.ph.")]        // trailing dot
    [InlineData("student@DLSUDXedu.ph")]
    // --- malformed -----------------------------------------------------------
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("student")]
    [InlineData("student@")]
    [InlineData("@dlsud.edu.ph")]                // empty local part
    [InlineData("student@@dlsud.edu.ph")]
    [InlineData("a@b@dlsud.edu.ph")]             // two "@"
    [InlineData(".student@dlsud.edu.ph")]        // leading dot
    [InlineData("student.@dlsud.edu.ph")]        // trailing dot
    [InlineData("stu..dent@dlsud.edu.ph")]       // consecutive dots
    [InlineData("stu dent@dlsud.edu.ph")]        // internal space
    [InlineData("stu<dent@dlsud.edu.ph")]        // HTML-ish payload
    [InlineData("'; DROP TABLE users;--@dlsud.edu.ph")]
    public void Rejects_everything_that_is_not_a_dlsud_student_address(string email)
    {
        Assert.False(RegistrationRules.IsValidStudentEmail(email));
    }

    [Fact]
    public void Rejects_null_without_throwing()
    {
        Assert.False(RegistrationRules.IsValidStudentEmail(null));
    }

    [Fact]
    public void Rejects_an_address_longer_than_the_column_allows()
    {
        // 100 characters is the limit enforced by validation.js, this file and
        // the CHECK constraint in database/schema.sql.
        string local = new string('a', RegistrationRules.MaxEmailLength);
        Assert.False(RegistrationRules.IsValidStudentEmail($"{local}@dlsud.edu.ph"));
    }
}

public class RegistrationRulesSeatTests
{
    [Fact]
    public void One_seat_left_is_still_available()
    {
        SeatAvailability seats = RegistrationRules.AssessSeats(capacity: 100, confirmedCount: 99);

        Assert.True(seats.IsValid);
        Assert.False(seats.IsFull);
        Assert.Equal(1, seats.RemainingSeats);
    }

    [Fact]
    public void Exactly_at_capacity_is_full()
    {
        SeatAvailability seats = RegistrationRules.AssessSeats(capacity: 100, confirmedCount: 100);

        Assert.True(seats.IsFull);
        Assert.Equal(0, seats.RemainingSeats);
    }

    [Fact]
    public void An_empty_event_offers_every_seat()
    {
        SeatAvailability seats = RegistrationRules.AssessSeats(capacity: 60, confirmedCount: 0);

        Assert.Equal(60, seats.RemainingSeats);
        Assert.False(seats.IsFull);
    }

    [Fact]
    public void Over_subscription_reports_zero_seats_not_a_negative_number()
    {
        // Corrupted state: more confirmed rows than the capacity allows.
        SeatAvailability seats = RegistrationRules.AssessSeats(capacity: 100, confirmedCount: 105);

        Assert.True(seats.IsFull);
        Assert.Equal(0, seats.RemainingSeats);
        Assert.True(seats.RemainingSeats >= 0);
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(-1, 0)]
    [InlineData(-100, 5)]
    public void A_non_positive_capacity_is_an_invalid_event(int capacity, int confirmed)
    {
        SeatAvailability seats = RegistrationRules.AssessSeats(capacity, confirmed);

        Assert.False(seats.IsValid);
        Assert.True(seats.IsFull);
        Assert.Equal(0, seats.RemainingSeats);
    }

    [Fact]
    public void A_negative_registration_count_is_an_invalid_event()
    {
        SeatAvailability seats = RegistrationRules.AssessSeats(capacity: 50, confirmedCount: -3);

        Assert.False(seats.IsValid);
        Assert.Equal(0, seats.RemainingSeats);
    }
}

public class RegistrationServiceTests
{
    private static readonly DateTime Now = new(2026, 10, 1, 8, 0, 0, DateTimeKind.Utc);

    private static RegistrationRequest ValidRequest() => new(
        FullName: "Juan Dela Cruz",
        StudentId: "20211234",
        Email: "juan.delacruz@dlsud.edu.ph",
        DepartmentId: 1);

    private static EventSeating Seating(int capacity, int confirmed, DateTime? date = null) => new(
        EventId: 1,
        Title: "Cybersecurity Awareness Workshop",
        Capacity: capacity,
        ConfirmedCount: confirmed,
        EventDate: date ?? new DateTime(2026, 10, 22, 13, 0, 0, DateTimeKind.Utc));

    /// <summary>A repository mock where nothing exists yet and inserts work.</summary>
    private static Mock<IRegistrationRepository> EmptyRepository(EventSeating? seating)
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(It.IsAny<int>())).Returns(seating);
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.CreateStudent(It.IsAny<RegistrationRequest>())).Returns(42);
        repository.Setup(r => r.CreateRegistrationIfSeatAvailable(42, 1)).Returns(7);
        return repository;
    }

    private static RegistrationService ServiceFor(Mock<IRegistrationRepository> repository) =>
        new(repository.Object, () => Now);

    // --- happy path ---------------------------------------------------------

    [Fact]
    public void Registers_a_new_student_when_seats_remain()
    {
        Mock<IRegistrationRepository> repository = EmptyRepository(Seating(capacity: 60, confirmed: 59));
        RegistrationService service = ServiceFor(repository);

        RegistrationResult result = service.Register(1, ValidRequest());

        Assert.True(result.Succeeded);
        Assert.Equal(RegistrationOutcome.Allowed, result.Decision.Outcome);
        Assert.NotNull(result.Receipt);
        Assert.Equal("EH-001-0007", result.Receipt!.Reference);
        repository.Verify(r => r.CreateStudent(It.IsAny<RegistrationRequest>()), Times.Once);
        repository.Verify(r => r.CreateRegistrationIfSeatAvailable(42, 1), Times.Once);
    }

    [Fact]
    public void Reuses_an_existing_student_record_instead_of_creating_a_duplicate()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(60, 10));
        repository.Setup(r => r.FindStudentByEmail("juan.delacruz@dlsud.edu.ph"))
                  .Returns(new StudentRecord(5, "20211234", "juan.delacruz@dlsud.edu.ph"));
        repository.Setup(r => r.HasConfirmedRegistration(5, 1)).Returns(false);
        repository.Setup(r => r.UpdateStudentProfile(5, "Juan Dela Cruz", 1));
        repository.Setup(r => r.CreateRegistrationIfSeatAvailable(5, 1)).Returns(11);

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.True(result.Succeeded);
        repository.Verify(r => r.CreateStudent(It.IsAny<RegistrationRequest>()), Times.Never);
    }

    // --- capacity ----------------------------------------------------------

    [Fact]
    public void Refuses_registration_when_the_event_is_exactly_full()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(capacity: 60, confirmed: 60));
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId(It.IsAny<string>())).Returns((StudentRecord?)null);

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.False(result.Succeeded);
        Assert.Equal(RegistrationOutcome.EventFull, result.Decision.Outcome);
        Assert.Equal(0, result.Decision.Availability!.RemainingSeats);
        // Nothing must be written when the event is full.
        repository.Verify(r => r.CreateStudent(It.IsAny<RegistrationRequest>()), Times.Never);
        repository.Verify(r => r.CreateRegistrationIfSeatAvailable(It.IsAny<int>(), It.IsAny<int>()), Times.Never);
    }

    [Fact]
    public void Refuses_registration_when_the_event_is_over_subscribed()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(capacity: 100, confirmed: 140));
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId(It.IsAny<string>())).Returns((StudentRecord?)null);

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.Equal(RegistrationOutcome.EventFull, result.Decision.Outcome);
        Assert.Equal(0, result.Decision.Availability!.RemainingSeats);
    }

    [Fact]
    public void Allows_the_very_last_seat()
    {
        Mock<IRegistrationRepository> repository = EmptyRepository(Seating(capacity: 40, confirmed: 39));

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.True(result.Succeeded);
        Assert.Equal(1, result.Decision.Availability!.RemainingSeats);
    }

    [Fact]
    public void Reports_the_event_as_full_when_the_last_seat_is_taken_during_the_insert()
    {
        // The repository's conditional INSERT returns null: between the
        // decision and the write, someone else took the seat.
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(40, 39));
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.CreateStudent(It.IsAny<RegistrationRequest>())).Returns(42);
        repository.Setup(r => r.CreateRegistrationIfSeatAvailable(42, 1)).Returns((int?)null);

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.False(result.Succeeded);
        Assert.Equal(RegistrationOutcome.EventFull, result.Decision.Outcome);
        Assert.Null(result.Receipt);
    }

    // --- duplicates --------------------------------------------------------

    [Fact]
    public void Refuses_a_second_registration_for_the_same_event()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(60, 10));
        repository.Setup(r => r.FindStudentByEmail("juan.delacruz@dlsud.edu.ph"))
                  .Returns(new StudentRecord(5, "20211234", "juan.delacruz@dlsud.edu.ph"));
        repository.Setup(r => r.HasConfirmedRegistration(5, 1)).Returns(true);

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.False(result.Succeeded);
        Assert.Equal(RegistrationOutcome.Duplicate, result.Decision.Outcome);
        repository.Verify(r => r.CreateRegistrationIfSeatAvailable(It.IsAny<int>(), It.IsAny<int>()), Times.Never);
    }

    [Fact]
    public void Reports_a_duplicate_rather_than_a_full_event_when_both_are_true()
    {
        // An already-registered student must not be told "the event is full":
        // their seat is one of the seats that filled it.
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(60, 60));
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>()))
                  .Returns(new StudentRecord(5, "20211234", "juan.delacruz@dlsud.edu.ph"));
        repository.Setup(r => r.HasConfirmedRegistration(5, 1)).Returns(true);

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.Equal(RegistrationOutcome.Duplicate, result.Decision.Outcome);
    }

    // --- identity ----------------------------------------------------------

    [Fact]
    public void Refuses_when_the_email_belongs_to_a_different_student_number()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(60, 1));
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>()))
                  .Returns(new StudentRecord(5, "20099999", "juan.delacruz@dlsud.edu.ph"));

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.Equal(RegistrationOutcome.IdentityConflict, result.Decision.Outcome);
        repository.Verify(r => r.UpdateStudentProfile(
            It.IsAny<int>(), It.IsAny<string>(), It.IsAny<int>()), Times.Never);
    }

    [Fact]
    public void Refuses_when_the_student_number_belongs_to_a_different_email()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(60, 1));
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId("20211234"))
                  .Returns(new StudentRecord(9, "20211234", "someone.else@dlsud.edu.ph"));

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.Equal(RegistrationOutcome.IdentityConflict, result.Decision.Outcome);
        repository.Verify(r => r.CreateStudent(It.IsAny<RegistrationRequest>()), Times.Never);
    }

    // --- invalid input / invalid state -------------------------------------

    [Theory]
    [InlineData("student@gmail.com")]
    [InlineData("student@dlsu.edu.ph")]
    [InlineData("student@dlsud.edu.ph.fake.com")]
    [InlineData("not-an-email")]
    [InlineData("")]
    public void Refuses_a_non_dlsud_email_without_touching_the_database(string email)
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        RegistrationRequest request = ValidRequest() with { Email = email };

        RegistrationResult result = ServiceFor(repository).Register(1, request);

        Assert.False(result.Succeeded);
        Assert.Equal(RegistrationOutcome.InvalidEmail, result.Decision.Outcome);
        // MockBehavior.Strict: any repository call here would fail the test,
        // which is exactly the assertion we want - invalid input never reaches
        // the database.
        repository.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("", "20211234")]
    [InlineData("J", "20211234")]
    [InlineData("Robert'); DROP TABLE users;--", "20211234")]
    [InlineData("Juan Dela Cruz", "")]
    [InlineData("Juan Dela Cruz", "12")]
    [InlineData("Juan Dela Cruz", "2021ABCD")]
    [InlineData("Juan Dela Cruz", "1234567890123")]
    public void Refuses_invalid_student_details(string fullName, string studentId)
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        RegistrationRequest request = ValidRequest() with
        {
            FullName = fullName,
            StudentId = studentId
        };

        RegistrationResult result = ServiceFor(repository).Register(1, request);

        Assert.Equal(RegistrationOutcome.InvalidStudentDetails, result.Decision.Outcome);
        repository.VerifyNoOtherCalls();
    }

    [Fact]
    public void Refuses_an_unknown_event()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(999)).Returns((EventSeating?)null);
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId(It.IsAny<string>())).Returns((StudentRecord?)null);

        RegistrationResult result = ServiceFor(repository).Register(999, ValidRequest());

        Assert.Equal(RegistrationOutcome.EventNotFound, result.Decision.Outcome);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Refuses_an_invalid_event_id_without_touching_the_database(int eventId)
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);

        RegistrationResult result = ServiceFor(repository).Register(eventId, ValidRequest());

        Assert.Equal(RegistrationOutcome.EventNotFound, result.Decision.Outcome);
        repository.VerifyNoOtherCalls();
    }

    [Fact]
    public void Refuses_an_event_whose_capacity_is_corrupted()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(capacity: 0, confirmed: 0));
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId(It.IsAny<string>())).Returns((StudentRecord?)null);

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.Equal(RegistrationOutcome.InvalidEventState, result.Decision.Outcome);
        repository.Verify(r => r.CreateRegistrationIfSeatAvailable(It.IsAny<int>(), It.IsAny<int>()), Times.Never);
    }

    [Fact]
    public void Refuses_registration_for_an_event_that_has_already_happened()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1))
                  .Returns(Seating(100, 10, new DateTime(2026, 8, 20, 9, 0, 0, DateTimeKind.Utc)));
        repository.Setup(r => r.FindStudentByEmail(It.IsAny<string>())).Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId(It.IsAny<string>())).Returns((StudentRecord?)null);

        RegistrationResult result = ServiceFor(repository).Register(1, ValidRequest());

        Assert.Equal(RegistrationOutcome.EventPast, result.Decision.Outcome);
        repository.Verify(r => r.CreateRegistrationIfSeatAvailable(It.IsAny<int>(), It.IsAny<int>()), Times.Never);
    }

    [Fact]
    public void Normalises_the_email_before_it_reaches_the_repository()
    {
        var repository = new Mock<IRegistrationRepository>(MockBehavior.Strict);
        repository.Setup(r => r.GetEventSeating(1)).Returns(Seating(60, 1));
        repository.Setup(r => r.FindStudentByEmail("juan.delacruz@dlsud.edu.ph"))
                  .Returns((StudentRecord?)null);
        repository.Setup(r => r.FindStudentByStudentId("20211234")).Returns((StudentRecord?)null);
        repository.Setup(r => r.CreateStudent(It.Is<RegistrationRequest>(
                      req => req.Email == "juan.delacruz@dlsud.edu.ph")))
                  .Returns(42);
        repository.Setup(r => r.CreateRegistrationIfSeatAvailable(42, 1)).Returns(7);

        RegistrationRequest request = ValidRequest() with
        {
            Email = "  Juan.DelaCruz@DLSUD.edu.ph  ",
            StudentId = "2021-1234",
            FullName = "  Juan   Dela Cruz  "
        };

        RegistrationResult result = ServiceFor(repository).Register(1, request);

        Assert.True(result.Succeeded);
        repository.Verify(r => r.FindStudentByEmail("juan.delacruz@dlsud.edu.ph"), Times.Once);
    }

    [Fact]
    public void Rejects_a_null_repository_at_construction_time()
    {
        Assert.Throws<ArgumentNullException>(() => new RegistrationService(null!));
    }
}
