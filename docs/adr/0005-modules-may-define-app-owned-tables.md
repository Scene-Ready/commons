---
status: accepted
---

# A module may define a table that the app owns

"Keeps no state" now means a module holds no state of its own. A module may define a table if the app owns it, it lives in the app's database, and the app migrates it. The outbox needs this: its row has to commit in the same D1 batch as the change it describes, and `db.batch` is atomic only within one database, so the table must sit beside the app's own tables. A shared outbox elsewhere would reopen the dual-write gap the outbox exists to close.

Commons ships the schema as numbered SQL files (`migrations/<module>/NNNN_*.sql`) with an exported version constant, such as `OUTBOX_SCHEMA_VERSION`. Apps copy each file into their own `migrations/` under their own number. Commons never runs migrations and never checks the schema at runtime.

## Considered options

- **Commons applies its own migrations at runtime.** Rejected: that is configuration and state commons would own, and it would race the app's own migrations.
- **A runtime schema check.** Rejected: it costs a query on a hot path, and a missing column fails loudly on the first write anyway.

## Consequences

- Schema changes ship as new numbered files and must be additive. A non-additive change is a major version.
- Each new migration file gets a CHANGELOG line telling apps to copy it.
- The table's data never leaves the app's database. Commons only reads and writes it through the D1 binding the app passes in.
