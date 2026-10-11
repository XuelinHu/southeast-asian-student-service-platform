# PostgreSQL Migrations

`src/migrate.js` records immutable migration checksums in `schema_migrations` and serializes each run with a PostgreSQL advisory lock. Every migration executes in its own transaction; a failed migration is not added to the ledger.

`001_initial_schema` is the baseline formed by `../schema.sql`, `../seed.sql`, and the built-in role/menu definitions in `src/config/roles.js` and `src/config/resources.js`. `002_query_indexes.sql` adds indexes for common student, visa, grade-audit, and study-warning filters. `003_foreign_key_indexes.sql` indexes referencing columns used for joins and parent-row updates/deletes; PostgreSQL does not create these indexes automatically. Do not edit an applied baseline or migration; add the next numbered SQL file.
`004_oidc_identity.sql` adds a nullable OIDC subject and a partial unique index. Existing users are never matched by username or email; they must explicitly link after local sign-in.

The old MySQL `database/schema.sql` and its recorded migration history are reference material only. `npm run db:init` does not create a database, connect to MySQL, or transfer existing business rows. Provision the project database and its restricted application role separately, then initialize a new/approved target database.
