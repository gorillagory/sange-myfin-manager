-- Development-only fresh provisioning; validated in isolated PostgreSQL 16.
-- Persistent execution is an operator deployment step, never API startup/build.
-- Fresh provisioning only: deliberately fails on existing names; inspect existing
-- ownership/ACLs instead of masking a conflicting database or role.
-- Run using psql with a provisioning administrator, connected to postgres.
\set ON_ERROR_STOP on
CREATE ROLE myfin_dev_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE myfin_dev_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
CREATE ROLE myfin_dev_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
GRANT myfin_dev_owner TO myfin_dev_migrator;
CREATE DATABASE myfin_dev OWNER myfin_dev_owner;
REVOKE ALL ON DATABASE myfin_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE myfin_dev TO myfin_dev_migrator, myfin_dev_runtime;
\connect myfin_dev
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA myfin AUTHORIZATION myfin_dev_owner;
GRANT USAGE ON SCHEMA myfin TO myfin_dev_runtime;
ALTER ROLE myfin_dev_runtime IN DATABASE myfin_dev SET search_path = pg_catalog, myfin;
ALTER ROLE myfin_dev_runtime IN DATABASE myfin_dev SET statement_timeout = '3s';
ALTER ROLE myfin_dev_runtime IN DATABASE myfin_dev SET idle_in_transaction_session_timeout = '10s';
-- Set independent passwords using the operator's secret process (e.g. psql
-- \password myfin_dev_migrator and \password myfin_dev_runtime). No defaults.
-- Migrator must SET ROLE myfin_dev_owner; runtime is never an owner/member of it.
-- No default blanket table grants: run the explicit grants file after migration.
