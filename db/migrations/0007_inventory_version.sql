-- Prevent a stale product editor from overwriting a concurrent POS deduction.
ALTER TABLE myfin.products ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version>0);
