//! R5a budget admission (H4): a single-scope, in-journal reservation ledger.
//!
//! Substrate only — nothing in the live agent loop calls this yet; R5b wires the
//! runner. The journal is authoritative for admission: a request is admitted by
//! writing a reservation in the same transaction as its `requests` row, and the
//! scope's live headroom is always the sum of its *active* reservations, not a
//! running counter that could drift. `usage.jsonl` remains the canonical raw
//! ledger of what was actually spent; a later slice bridges the two in a
//! two-phase write (journal reserves, usage reconciles). This module never
//! reads or writes `usage.jsonl`.
//!
//! v1 is deliberately **single-scope**: each reservation names exactly one
//! `scope_key` and there is no scope hierarchy or roll-up. Admission is
//! fail-closed in two ways. First, an **unpriced** request (no estimate) is
//! rejected with a named error — never treated as zero, because a free-looking
//! request is how a budget is silently blown. Second, a reserve **ceil**s the
//! estimate by a 10% headroom, and settlement is the **nearest** actual, so the
//! reservation can never under-count what a run may cost.
//!
//! Hard precondition: callers must serialize access to the journal connection.
//! The admission reads and writes below run inside one immediate transaction, but
//! a second connection opened outside that serialization can still race the
//! `SUM` and admit past the limit. The journal's `with_journal` holds a
//! process-global connection mutex and is the intended entry point.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::core::runtime_types::validate_id;

/// A USD amount in micro-dollars (1 µUSD = 1e-6 USD). The inner value is
/// expected to be non-negative; [`UsdMicros::from_micros`] is raw and does not
/// clamp, so callers holding an estimate must not pass a negative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct UsdMicros(i64);

impl UsdMicros {
    /// Raw constructor. The value is expected to be non-negative.
    pub fn from_micros(v: i64) -> Self {
        UsdMicros(v)
    }

    pub fn get(self) -> i64 {
        self.0
    }

    /// The amount to reserve for an estimate: the estimate plus a 10% ceiling
    /// headroom (`estimate + ceil(estimate / 10)`), computed with saturating
    /// arithmetic. The reserve must never under-count — settlement is the exact
    /// actual, and a reserve rounded down could admit a request whose true cost
    /// exceeds the scope limit.
    pub fn ceil_reserve(estimate_micros: i64) -> Self {
        let headroom = estimate_micros.saturating_add(9) / 10;
        UsdMicros(estimate_micros.saturating_add(headroom))
    }

    /// The amount to settle: the exact actual cost. There is no rounding in v1;
    /// the name is kept so a future rounding policy has one seam.
    pub fn nearest_settle(actual_micros: i64) -> Self {
        UsdMicros(actual_micros)
    }
}

impl std::ops::Add for UsdMicros {
    type Output = UsdMicros;

    fn add(self, rhs: UsdMicros) -> UsdMicros {
        UsdMicros(self.0.saturating_add(rhs.0))
    }
}

impl std::fmt::Display for UsdMicros {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} usd_micros", self.0)
    }
}

/// Named budget failure. Callers branch on the variant rather than parse a
/// string. Every variant means "do not dispatch".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BudgetError {
    /// No price is known for the route. Strict reject in v1: an unpriced
    /// request is refused rather than admitted as free.
    Unpriced {
        provider: String,
        model: String,
    },
    /// A money input was negative. A negative amount must never be admitted: it
    /// would mint headroom instead of consuming it.
    InvalidAmount {
        field: String,
        value: i64,
    },
    /// An identity field failed validation.
    InvalidId {
        field: String,
        reason: String,
    },
    /// The scope has too little headroom for the requested reserve.
    Exceeded {
        scope_key: String,
        limit_usd_micros: i64,
        requested_usd_micros: i64,
        already_reserved_usd_micros: i64,
    },
    /// No request with the given id exists.
    NotFound {
        request_id: String,
    },
    /// The request exists but is not in a state that permits the operation.
    Conflict {
        request_id: String,
        reason: String,
    },
    Store(String),
}

impl std::fmt::Display for BudgetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BudgetError::Unpriced { provider, model } => write!(
                f,
                "No price is known for provider \"{provider}\" model \"{model}\"; an unpriced request is refused rather than treated as free"
            ),
            BudgetError::InvalidAmount { field, value } => write!(
                f,
                "Budget amount \"{field}\" must be non-negative, got {value} usd_micros"
            ),
            BudgetError::InvalidId { field, reason } => {
                write!(f, "Invalid budget id \"{field}\": {reason}")
            }
            BudgetError::Exceeded {
                scope_key,
                limit_usd_micros,
                requested_usd_micros,
                already_reserved_usd_micros,
            } => write!(
                f,
                "Budget scope \"{scope_key}\" would exceed its limit: limit {limit_usd_micros} usd_micros, already reserved {already_reserved_usd_micros} usd_micros, requested {requested_usd_micros} usd_micros"
            ),
            BudgetError::NotFound { request_id } => {
                write!(f, "Unknown budget request: {request_id}")
            }
            BudgetError::Conflict { request_id, reason } => write!(
                f,
                "Budget request {request_id} is in an incompatible state: {reason}"
            ),
            BudgetError::Store(message) => write!(f, "Budget store error: {message}"),
        }
    }
}

impl std::error::Error for BudgetError {}

impl From<BudgetError> for String {
    fn from(error: BudgetError) -> Self {
        error.to_string()
    }
}

/// One admission scope: a key plus its hard ceiling. v1 has no hierarchy — a
/// reservation is admitted against exactly the scope it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetScope {
    pub scope_key: String,
    pub limit_usd_micros: i64,
}

/// The inputs to [`reserve`]. Grouped so the call site stays readable and the
/// reserve path does not trip clippy's argument-count lint.
#[derive(Debug, Clone)]
pub struct ReserveRequest<'a> {
    pub request_id: &'a str,
    pub run_id: &'a str,
    pub epoch: i64,
    pub scope: &'a BudgetScope,
    pub provider: &'a str,
    pub model: &'a str,
    pub estimate_usd_micros: Option<i64>,
    pub now: i64,
}

/// A durable reservation. `settled_usd_micros` stays `None` until the request
/// settles; a released request never carries a settled amount.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetReservation {
    pub reservation_id: String,
    pub request_id: String,
    pub scope_key: String,
    pub limit_usd_micros: i64,
    pub reserved_usd_micros: i64,
    pub settled_usd_micros: Option<i64>,
    pub state: String,
    pub created_at: i64,
}

/// The result of settling a reservation. An overage is labelled, never silently
/// reopened as a new reservation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettlementOutcome {
    WithinLimit {
        reserved_usd_micros: i64,
        settled_usd_micros: i64,
    },
    Overage {
        reserved_usd_micros: i64,
        settled_usd_micros: i64,
        overage_usd_micros: i64,
    },
}

/// Admit a request by writing its `requests` row and a matching
/// `budget_reservations` row in one immediate transaction. A `None` estimate is
/// refused (never treated as zero); a negative amount or malformed id is
/// refused; a request whose ceil-reserve would push the scope past its limit is
/// refused before anything is inserted; a duplicate `request_id` is a conflict.
pub fn reserve(
    connection: &Connection,
    request: ReserveRequest<'_>,
) -> Result<BudgetReservation, BudgetError> {
    let estimate = match request.estimate_usd_micros {
        Some(value) => value,
        None => {
            return Err(BudgetError::Unpriced {
                provider: request.provider.to_string(),
                model: request.model.to_string(),
            })
        }
    };
    if estimate < 0 {
        return Err(BudgetError::InvalidAmount {
            field: "estimate".to_string(),
            value: estimate,
        });
    }
    if request.scope.limit_usd_micros < 0 {
        return Err(BudgetError::InvalidAmount {
            field: "limitUsdMicros".to_string(),
            value: request.scope.limit_usd_micros,
        });
    }
    for (field, value) in [
        ("requestId", request.request_id),
        ("runId", request.run_id),
        ("provider", request.provider),
        ("model", request.model),
        ("scopeKey", request.scope.scope_key.as_str()),
    ] {
        validate_id(field, value).map_err(|reason| BudgetError::InvalidId {
            field: field.to_string(),
            reason,
        })?;
    }

    let requested = UsdMicros::ceil_reserve(estimate).get();
    let reservation_id = Uuid::new_v4().to_string();

    // The journal connection is shared as `&Connection` (with_journal hands it
    // out behind a process-global mutex), so the typed `transaction_with_behavior`
    // API — which needs `&mut Connection` — is unavailable. `BEGIN IMMEDIATE`
    // gives the same guarantee: the write lock is taken up front, before the
    // admission reads, not on the first INSERT.
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| BudgetError::Store(e.to_string()))?;

    let result = (|| -> Result<(), BudgetError> {
        let duplicate: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM requests WHERE request_id = ?1",
                params![request.request_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| BudgetError::Store(e.to_string()))?;
        if duplicate.is_some() {
            return Err(BudgetError::Conflict {
                request_id: request.request_id.to_string(),
                reason: "a request with this id already exists".to_string(),
            });
        }

        let already: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(reserved_usd_micros), 0) FROM budget_reservations \
                 WHERE scope_key = ?1 AND state = 'reserved'",
                params![request.scope.scope_key],
                |row| row.get(0),
            )
            .map_err(|e| BudgetError::Store(e.to_string()))?;
        if already.saturating_add(requested) > request.scope.limit_usd_micros {
            return Err(BudgetError::Exceeded {
                scope_key: request.scope.scope_key.clone(),
                limit_usd_micros: request.scope.limit_usd_micros,
                requested_usd_micros: requested,
                already_reserved_usd_micros: already,
            });
        }

        connection
            .execute(
                "INSERT INTO requests (request_id, run_id, epoch, scope_key, provider, model, \
                 estimated_usd_micros, reserved_usd_micros, settled_usd_micros, state, \
                 created_at, settled_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 'reserved', ?9, NULL)",
                params![
                    request.request_id,
                    request.run_id,
                    request.epoch,
                    request.scope.scope_key,
                    request.provider,
                    request.model,
                    estimate,
                    requested,
                    request.now
                ],
            )
            .map_err(|e| BudgetError::Store(e.to_string()))?;
        connection
            .execute(
                "INSERT INTO budget_reservations (reservation_id, request_id, scope_key, \
                 limit_usd_micros, reserved_usd_micros, settled_usd_micros, state, created_at, settled_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'reserved', ?6, NULL)",
                params![
                    reservation_id,
                    request.request_id,
                    request.scope.scope_key,
                    request.scope.limit_usd_micros,
                    requested,
                    request.now
                ],
            )
            .map_err(|e| BudgetError::Store(e.to_string()))?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|e| BudgetError::Store(e.to_string()))?;
            Ok(BudgetReservation {
                reservation_id,
                request_id: request.request_id.to_string(),
                scope_key: request.scope.scope_key.clone(),
                limit_usd_micros: request.scope.limit_usd_micros,
                reserved_usd_micros: requested,
                settled_usd_micros: None,
                state: "reserved".to_string(),
                created_at: request.now,
            })
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Settle a reserved request with its exact actual cost. The reservation is
/// freed from the scope's active total; an actual above the reserve is reported
/// as a labelled overage rather than reopening the reservation.
pub fn settle(
    connection: &Connection,
    request_id: &str,
    actual_usd_micros: i64,
    now: i64,
) -> Result<SettlementOutcome, BudgetError> {
    if actual_usd_micros < 0 {
        return Err(BudgetError::InvalidAmount {
            field: "actual".to_string(),
            value: actual_usd_micros,
        });
    }

    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| BudgetError::Store(e.to_string()))?;

    let result = (|| -> Result<SettlementOutcome, BudgetError> {
        let reservation = load_reservation(connection, request_id)?;
        if reservation.state != "reserved" {
            return Err(BudgetError::Conflict {
                request_id: request_id.to_string(),
                reason: format!("request is {} and cannot be settled", reservation.state),
            });
        }

        let reserved = reservation.reserved_usd_micros;
        let settled = UsdMicros::nearest_settle(actual_usd_micros).get();

        let changed = connection
            .execute(
                "UPDATE budget_reservations SET state = 'settled', settled_usd_micros = ?1, settled_at = ?2 \
                 WHERE request_id = ?3 AND state = 'reserved'",
                params![settled, now, request_id],
            )
            .map_err(|e| BudgetError::Store(e.to_string()))?;
        if changed != 1 {
            return Err(BudgetError::Conflict {
                request_id: request_id.to_string(),
                reason: "request is no longer reserved".to_string(),
            });
        }
        let changed = connection
            .execute(
                "UPDATE requests SET state = 'settled', settled_usd_micros = ?1, settled_at = ?2 \
                 WHERE request_id = ?3 AND state = 'reserved'",
                params![settled, now, request_id],
            )
            .map_err(|e| BudgetError::Store(e.to_string()))?;
        if changed != 1 {
            return Err(BudgetError::Conflict {
                request_id: request_id.to_string(),
                reason: "request is no longer reserved".to_string(),
            });
        }

        Ok(if settled <= reserved {
            SettlementOutcome::WithinLimit {
                reserved_usd_micros: reserved,
                settled_usd_micros: settled,
            }
        } else {
            SettlementOutcome::Overage {
                reserved_usd_micros: reserved,
                settled_usd_micros: settled,
                overage_usd_micros: settled.saturating_sub(reserved),
            }
        })
    })();

    match result {
        Ok(outcome) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|e| BudgetError::Store(e.to_string()))?;
            Ok(outcome)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Release a reserved request without a settled amount, freeing its headroom.
/// The reservation is not deleted; its state records why the scope reopened.
pub fn release(connection: &Connection, request_id: &str, now: i64) -> Result<(), BudgetError> {
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| BudgetError::Store(e.to_string()))?;

    let result = (|| -> Result<(), BudgetError> {
        let reservation = load_reservation(connection, request_id)?;
        if reservation.state != "reserved" {
            return Err(BudgetError::Conflict {
                request_id: request_id.to_string(),
                reason: format!("request is {} and cannot be released", reservation.state),
            });
        }

        let changed = connection
            .execute(
                "UPDATE budget_reservations SET state = 'released', settled_at = ?1 \
                 WHERE request_id = ?2 AND state = 'reserved'",
                params![now, request_id],
            )
            .map_err(|e| BudgetError::Store(e.to_string()))?;
        if changed != 1 {
            return Err(BudgetError::Conflict {
                request_id: request_id.to_string(),
                reason: "request is no longer reserved".to_string(),
            });
        }
        let changed = connection
            .execute(
                "UPDATE requests SET state = 'released', settled_at = ?1 \
                 WHERE request_id = ?2 AND state = 'reserved'",
                params![now, request_id],
            )
            .map_err(|e| BudgetError::Store(e.to_string()))?;
        if changed != 1 {
            return Err(BudgetError::Conflict {
                request_id: request_id.to_string(),
                reason: "request is no longer reserved".to_string(),
            });
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|e| BudgetError::Store(e.to_string()))?;
            Ok(())
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// The scope's live headroom usage: the sum of its active (`reserved`)
/// reservations. An unknown scope has no reservations, so its total is 0.
pub fn reserved_total(connection: &Connection, scope_key: &str) -> Result<i64, BudgetError> {
    connection
        .query_row(
            "SELECT COALESCE(SUM(reserved_usd_micros), 0) FROM budget_reservations \
             WHERE scope_key = ?1 AND state = 'reserved'",
            params![scope_key],
            |row| row.get(0),
        )
        .map_err(|e| BudgetError::Store(e.to_string()))
}

/// Load a reservation by request id.
pub fn load_reservation(
    connection: &Connection,
    request_id: &str,
) -> Result<BudgetReservation, BudgetError> {
    connection
        .query_row(
            "SELECT reservation_id, request_id, scope_key, limit_usd_micros, reserved_usd_micros, \
             settled_usd_micros, state, created_at \
             FROM budget_reservations WHERE request_id = ?1",
            params![request_id],
            |row| {
                Ok(BudgetReservation {
                    reservation_id: row.get(0)?,
                    request_id: row.get(1)?,
                    scope_key: row.get(2)?,
                    limit_usd_micros: row.get(3)?,
                    reserved_usd_micros: row.get(4)?,
                    settled_usd_micros: row.get(5)?,
                    state: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|e| BudgetError::Store(e.to_string()))?
        .ok_or_else(|| BudgetError::NotFound {
            request_id: request_id.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::runtime_journal::open_at;
    use std::path::PathBuf;

    fn temp_db() -> PathBuf {
        std::env::temp_dir()
            .join(format!("packetbench-budget-test-{}", Uuid::new_v4()))
            .join("journal.db")
    }

    fn seed_run(connection: &Connection, run_id: &str) {
        connection
            .execute(
                "INSERT INTO runs (run_id, conversation_id, operation_id, root_run_id, epoch, state, latest_seq) \
                 VALUES (?1, 'conv-1', 'op-1', ?1, 0, 'prepared', 0)",
                params![run_id],
            )
            .unwrap();
    }

    fn scope(limit: i64) -> BudgetScope {
        BudgetScope {
            scope_key: "local:conv-1".to_string(),
            limit_usd_micros: limit,
        }
    }

    fn reserve_with(
        connection: &Connection,
        request_id: &str,
        run_id: &str,
        scope: &BudgetScope,
        estimate: Option<i64>,
    ) -> Result<BudgetReservation, BudgetError> {
        reserve(
            connection,
            ReserveRequest {
                request_id,
                run_id,
                epoch: 0,
                scope,
                provider: "anthropic",
                model: "claude",
                estimate_usd_micros: estimate,
                now: 1_000,
            },
        )
    }

    fn count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn unpriced_request_is_rejected_and_inserts_nothing() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        let error = reserve_with(&connection, "req-1", "run-1", &scope(1_000), None).unwrap_err();
        match error {
            BudgetError::Unpriced { provider, model } => {
                assert_eq!(provider, "anthropic");
                assert_eq!(model, "claude");
            }
            other => panic!("expected an unpriced error, got {other:?}"),
        }
        assert_eq!(count(&connection, "requests"), 0);
        assert_eq!(count(&connection, "budget_reservations"), 0);
    }

    #[test]
    fn negative_amounts_are_rejected_and_insert_nothing() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");

        let error =
            reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(-1)).unwrap_err();
        assert!(matches!(
            error,
            BudgetError::InvalidAmount { field, value } if field == "estimate" && value == -1
        ));

        let error = reserve_with(&connection, "req-2", "run-1", &scope(-1), Some(100)).unwrap_err();
        assert!(matches!(
            error,
            BudgetError::InvalidAmount { field, value } if field == "limitUsdMicros" && value == -1
        ));

        assert_eq!(count(&connection, "requests"), 0);
        assert_eq!(count(&connection, "budget_reservations"), 0);

        // A negative actual is refused before anything is touched.
        reserve_with(&connection, "req-3", "run-1", &scope(1_000), Some(100)).unwrap();
        let error = settle(&connection, "req-3", -5, 2_000).unwrap_err();
        assert!(matches!(
            error,
            BudgetError::InvalidAmount { field, value } if field == "actual" && value == -5
        ));
        let loaded = load_reservation(&connection, "req-3").unwrap();
        assert_eq!(loaded.state, "reserved");
    }

    #[test]
    fn invalid_ids_are_rejected_and_insert_nothing() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        let error = reserve_with(&connection, "", "run-1", &scope(1_000), Some(100)).unwrap_err();
        assert!(matches!(
            error,
            BudgetError::InvalidId { field, .. } if field == "requestId"
        ));
        assert_eq!(count(&connection, "requests"), 0);
        assert_eq!(count(&connection, "budget_reservations"), 0);
    }

    #[test]
    fn reserve_over_the_scope_limit_is_refused_and_inserts_nothing() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        // estimate 900 -> ceil reserve 990, inside the 1000 limit.
        let first = reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(900)).unwrap();
        assert_eq!(first.reserved_usd_micros, 990);

        // A second identical reserve would total 1980 > 1000.
        let error =
            reserve_with(&connection, "req-2", "run-1", &scope(1_000), Some(900)).unwrap_err();
        match error {
            BudgetError::Exceeded {
                scope_key,
                limit_usd_micros,
                requested_usd_micros,
                already_reserved_usd_micros,
            } => {
                assert_eq!(scope_key, "local:conv-1");
                assert_eq!(limit_usd_micros, 1_000);
                assert_eq!(requested_usd_micros, 990);
                assert_eq!(already_reserved_usd_micros, 990);
            }
            other => panic!("expected an exceeded error, got {other:?}"),
        }
        // The refused request inserted nothing.
        assert_eq!(count(&connection, "requests"), 1);
        assert_eq!(count(&connection, "budget_reservations"), 1);
    }

    #[test]
    fn reserve_exactly_at_the_limit_is_admitted() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        // already (0) + requested (990) == limit (990) is admitted.
        let first = reserve_with(&connection, "req-1", "run-1", &scope(990), Some(900)).unwrap();
        assert_eq!(first.reserved_usd_micros, 990);
        assert_eq!(reserved_total(&connection, "local:conv-1").unwrap(), 990);
    }

    #[test]
    fn reserve_under_limit_succeeds_and_totals_track() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        // 400 -> 440, 500 -> 550; together 990 <= 1000.
        let first = reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(400)).unwrap();
        assert_eq!(first.state, "reserved");
        assert_eq!(first.settled_usd_micros, None);
        assert_eq!(first.reserved_usd_micros, 440);
        assert_eq!(reserved_total(&connection, "local:conv-1").unwrap(), 440);

        let second = reserve_with(&connection, "req-2", "run-1", &scope(1_000), Some(500)).unwrap();
        assert_eq!(second.reserved_usd_micros, 550);
        assert_eq!(reserved_total(&connection, "local:conv-1").unwrap(), 990);
    }

    #[test]
    fn reserving_a_duplicate_request_id_is_a_conflict() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        reserve_with(&connection, "req-1", "run-1", &scope(1_000_000), Some(100)).unwrap();
        let error =
            reserve_with(&connection, "req-1", "run-1", &scope(1_000_000), Some(100)).unwrap_err();
        assert!(matches!(error, BudgetError::Conflict { .. }));
        assert_eq!(count(&connection, "requests"), 1);
    }

    #[test]
    fn unpriced_retry_of_an_existing_request_stays_unpriced() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        reserve_with(&connection, "req-1", "run-1", &scope(1_000_000), Some(100)).unwrap();
        // Unpriced is checked before the duplicate lookup, so the ordering is
        // observable: the retry reports the missing price, not a conflict.
        let error =
            reserve_with(&connection, "req-1", "run-1", &scope(1_000_000), None).unwrap_err();
        assert!(matches!(error, BudgetError::Unpriced { .. }));
    }

    #[test]
    fn reserve_rolls_back_when_the_run_foreign_key_is_missing() {
        let connection = open_at(&temp_db()).unwrap();
        // No run row is seeded, so the requests insert violates the FK.
        let error = reserve_with(
            &connection,
            "req-1",
            "run-missing",
            &scope(1_000),
            Some(100),
        )
        .unwrap_err();
        assert!(matches!(error, BudgetError::Store(_)));
        // The transaction rolled back: neither table holds a row.
        assert_eq!(count(&connection, "requests"), 0);
        assert_eq!(count(&connection, "budget_reservations"), 0);
    }

    #[test]
    fn settle_within_limit_frees_the_reservation() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(400)).unwrap();
        assert_eq!(reserved_total(&connection, "local:conv-1").unwrap(), 440);

        let outcome = settle(&connection, "req-1", 300, 2_000).unwrap();
        assert_eq!(
            outcome,
            SettlementOutcome::WithinLimit {
                reserved_usd_micros: 440,
                settled_usd_micros: 300,
            }
        );
        // The settled reservation no longer counts against the scope.
        assert_eq!(reserved_total(&connection, "local:conv-1").unwrap(), 0);
        let loaded = load_reservation(&connection, "req-1").unwrap();
        assert_eq!(loaded.state, "settled");
        assert_eq!(loaded.settled_usd_micros, Some(300));
    }

    #[test]
    fn settle_over_the_reserve_reports_a_labelled_overage() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(400)).unwrap();

        let outcome = settle(&connection, "req-1", 500, 2_000).unwrap();
        assert_eq!(
            outcome,
            SettlementOutcome::Overage {
                reserved_usd_micros: 440,
                settled_usd_micros: 500,
                overage_usd_micros: 60,
            }
        );
        assert_eq!(reserved_total(&connection, "local:conv-1").unwrap(), 0);
        let loaded = load_reservation(&connection, "req-1").unwrap();
        assert_eq!(loaded.state, "settled");
        assert_eq!(loaded.settled_usd_micros, Some(500));
    }

    #[test]
    fn settling_twice_is_a_conflict() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(400)).unwrap();
        settle(&connection, "req-1", 300, 2_000).unwrap();
        assert!(matches!(
            settle(&connection, "req-1", 300, 3_000),
            Err(BudgetError::Conflict { .. })
        ));
    }

    #[test]
    fn settling_then_releasing_is_a_conflict() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(400)).unwrap();
        settle(&connection, "req-1", 300, 2_000).unwrap();
        assert!(matches!(
            release(&connection, "req-1", 3_000),
            Err(BudgetError::Conflict { .. })
        ));
    }

    #[test]
    fn release_frees_the_scope_for_a_later_reserve() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(900)).unwrap();
        assert!(reserve_with(&connection, "req-2", "run-1", &scope(1_000), Some(900)).is_err());

        release(&connection, "req-1", 2_000).unwrap();
        assert_eq!(reserved_total(&connection, "local:conv-1").unwrap(), 0);
        let released = load_reservation(&connection, "req-1").unwrap();
        assert_eq!(released.state, "released");
        assert_eq!(released.settled_usd_micros, None);

        // The freed headroom admits a new reservation.
        let second = reserve_with(&connection, "req-2", "run-1", &scope(1_000), Some(900)).unwrap();
        assert_eq!(second.reserved_usd_micros, 990);
    }

    #[test]
    fn reserved_total_for_an_unknown_scope_is_zero() {
        let connection = open_at(&temp_db()).unwrap();
        assert_eq!(reserved_total(&connection, "local:never-seen").unwrap(), 0);
    }

    #[test]
    fn settling_a_released_or_absent_request_is_refused() {
        let connection = open_at(&temp_db()).unwrap();
        seed_run(&connection, "run-1");
        // Absent request -> NotFound for both operations.
        assert!(matches!(
            settle(&connection, "missing", 1, 1),
            Err(BudgetError::NotFound { .. })
        ));
        assert!(matches!(
            release(&connection, "missing", 1),
            Err(BudgetError::NotFound { .. })
        ));

        reserve_with(&connection, "req-1", "run-1", &scope(1_000), Some(100)).unwrap();
        release(&connection, "req-1", 2_000).unwrap();
        // A released request cannot be settled or released again.
        assert!(matches!(
            settle(&connection, "req-1", 1, 1),
            Err(BudgetError::Conflict { .. })
        ));
        assert!(matches!(
            release(&connection, "req-1", 1),
            Err(BudgetError::Conflict { .. })
        ));
    }

    #[test]
    fn ceil_reserve_and_nearest_settle_math() {
        assert_eq!(UsdMicros::ceil_reserve(0).get(), 0);
        assert_eq!(UsdMicros::ceil_reserve(5).get(), 6);
        assert_eq!(UsdMicros::ceil_reserve(10).get(), 11);
        assert_eq!(UsdMicros::ceil_reserve(100).get(), 110);
        assert_eq!(UsdMicros::ceil_reserve(1_000).get(), 1_100);
        // Saturates instead of overflowing on a huge estimate.
        assert_eq!(UsdMicros::ceil_reserve(i64::MAX).get(), i64::MAX);

        assert_eq!(UsdMicros::nearest_settle(123).get(), 123);
        assert_eq!(UsdMicros::from_micros(7).get(), 7);

        // Add is saturating and ordering is by amount.
        let saturated = UsdMicros::from_micros(i64::MAX) + UsdMicros::from_micros(10);
        assert_eq!(saturated.get(), i64::MAX);
        assert!(UsdMicros::from_micros(1) < UsdMicros::from_micros(2));

        assert_eq!(UsdMicros::from_micros(5).to_string(), "5 usd_micros");
    }
}
