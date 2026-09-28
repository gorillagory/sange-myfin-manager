-- Production-only fresh provisioning. Run as PostgreSQL provisioning admin.
\set ON_ERROR_STOP on
CREATE ROLE myfin_prod_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE myfin_prod_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
CREATE ROLE myfin_prod_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
GRANT myfin_prod_owner TO myfin_prod_migrator;
CREATE DATABASE myfin_prod OWNER myfin_prod_owner;
REVOKE ALL ON DATABASE myfin_prod FROM PUBLIC;
GRANT CONNECT ON DATABASE myfin_prod TO myfin_prod_migrator,myfin_prod_runtime;
\connect myfin_prod
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA myfin AUTHORIZATION myfin_prod_owner;
GRANT USAGE ON SCHEMA myfin TO myfin_prod_runtime;
ALTER ROLE myfin_prod_runtime IN DATABASE myfin_prod SET search_path=pg_catalog,myfin;
ALTER ROLE myfin_prod_runtime IN DATABASE myfin_prod SET statement_timeout='3s';
ALTER ROLE myfin_prod_runtime IN DATABASE myfin_prod SET idle_in_transaction_session_timeout='10s';
