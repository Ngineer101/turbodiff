CREATE SCHEMA app;
CREATE SCHEMA auth;

COMMENT ON SCHEMA app IS 'Turbodiff application and tenant data';
COMMENT ON SCHEMA auth IS 'Better Auth identity, organization, and OAuth data';

CREATE SEQUENCE app.native_entity_id_seq
  AS bigint START WITH 4000000000000000 INCREMENT BY 1
  MAXVALUE 9007199254740991 NO CYCLE;

CREATE TABLE auth."user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" boolean NOT NULL DEFAULT false,
  "image" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "login" text,
  "githubId" bigint,
  CONSTRAINT user_email_unique UNIQUE ("email"),
  CONSTRAINT user_github_id_unique UNIQUE ("githubId")
);

CREATE TABLE auth."session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "activeOrganizationId" text,
  "userId" text NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE
);

CREATE INDEX session_user_id_idx ON auth."session" ("userId");
CREATE INDEX session_expires_at_idx ON auth."session" ("expiresAt");
CREATE INDEX session_active_organization_idx ON auth."session" ("activeOrganizationId")
  WHERE "activeOrganizationId" IS NOT NULL;

CREATE TABLE auth."account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  CONSTRAINT account_provider_identity_unique UNIQUE ("providerId", "accountId")
);

CREATE INDEX account_user_id_idx ON auth."account" ("userId");

CREATE TABLE auth."verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE INDEX verification_identifier_idx ON auth."verification" ("identifier");
CREATE INDEX verification_expires_at_idx ON auth."verification" ("expiresAt");

CREATE TABLE auth."oauthApplication" (
  "id" text PRIMARY KEY,
  "name" text,
  "icon" text,
  "metadata" text,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "redirectUrls" text NOT NULL,
  "type" text NOT NULL,
  "disabled" boolean NOT NULL DEFAULT false,
  "userId" text REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE INDEX oauth_application_user_id_idx ON auth."oauthApplication" ("userId");

CREATE TABLE auth."oauthAccessToken" (
  "id" text PRIMARY KEY,
  "accessToken" text NOT NULL UNIQUE,
  "refreshToken" text UNIQUE,
  "accessTokenExpiresAt" timestamptz NOT NULL,
  "refreshTokenExpiresAt" timestamptz NOT NULL,
  "clientId" text NOT NULL REFERENCES auth."oauthApplication" ("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "scopes" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE INDEX oauth_access_token_user_id_idx ON auth."oauthAccessToken" ("userId");
CREATE INDEX oauth_access_token_client_id_idx ON auth."oauthAccessToken" ("clientId");
CREATE INDEX oauth_access_token_expiry_idx ON auth."oauthAccessToken" ("accessTokenExpiresAt");

CREATE TABLE auth."oauthConsent" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES auth."oauthApplication" ("clientId") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "scopes" text NOT NULL,
  "consentGiven" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  CONSTRAINT oauth_consent_client_user_unique UNIQUE ("clientId", "userId")
);

CREATE INDEX oauth_consent_user_id_idx ON auth."oauthConsent" ("userId");
CREATE INDEX oauth_consent_client_id_idx ON auth."oauthConsent" ("clientId");
