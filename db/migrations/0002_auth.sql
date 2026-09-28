-- Better Auth 1.7.4 core schema; generated from pinned getSchema, reviewed SQL.
CREATE TABLE myfin.auth_user (
  id text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE TABLE myfin.auth_session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES myfin.auth_user("id") ON DELETE CASCADE
);
CREATE TABLE myfin.auth_account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES myfin.auth_user("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE TABLE myfin.auth_verification (
  id text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX auth_session_user_idx ON myfin.auth_session("userId");
CREATE INDEX auth_account_user_idx ON myfin.auth_account("userId");
CREATE INDEX auth_verification_identifier_idx ON myfin.auth_verification(identifier);
ALTER TABLE myfin.app_identities ADD COLUMN is_super boolean NOT NULL DEFAULT false;
ALTER TABLE myfin.companies ADD COLUMN data jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data)='object');
