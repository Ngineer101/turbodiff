-- Durable sign-in sessions via better-auth (src/lib/better-auth.ts): the old
-- stateless 8h HMAC cookie signed users out on every GitHub hiccup and never
-- outlived the GitHub user-token expiry. better-auth owns identity now —
-- 30-day sliding sessions in the "session" table; GitHub tokens live on the
-- "account" row and are refreshed out-of-band (src/lib/auth.ts), so a failed
-- GitHub call degrades a request instead of destroying the session.
--
-- Table/column names are better-auth's defaults (singular models, camelCase
-- fields — see getAuthTables in @better-auth/core). Dates are ISO-8601 TEXT
-- and booleans 0/1: the sqlite adapter mode serializes both. "login" and
-- "githubId" are Turbodiff additional fields on user (GitHub identity for
-- attribution and installation checks).

CREATE TABLE "user" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"name" TEXT NOT NULL,
	"email" TEXT NOT NULL UNIQUE,
	"emailVerified" INTEGER NOT NULL,
	"image" TEXT,
	"createdAt" TEXT NOT NULL,
	"updatedAt" TEXT NOT NULL,
	"login" TEXT,
	"githubId" INTEGER
);

CREATE TABLE "session" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"expiresAt" TEXT NOT NULL,
	"token" TEXT NOT NULL UNIQUE,
	"createdAt" TEXT NOT NULL,
	"updatedAt" TEXT NOT NULL,
	"ipAddress" TEXT,
	"userAgent" TEXT,
	"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_session_userId" ON "session" ("userId");

CREATE TABLE "account" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"providerId" TEXT NOT NULL,
	"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	"accessToken" TEXT,
	"refreshToken" TEXT,
	"idToken" TEXT,
	"accessTokenExpiresAt" TEXT,
	"refreshTokenExpiresAt" TEXT,
	"scope" TEXT,
	"password" TEXT,
	"createdAt" TEXT NOT NULL,
	"updatedAt" TEXT NOT NULL
);
CREATE INDEX "idx_account_userId" ON "account" ("userId");

CREATE TABLE "verification" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"identifier" TEXT NOT NULL,
	"value" TEXT NOT NULL,
	"expiresAt" TEXT NOT NULL,
	"createdAt" TEXT NOT NULL,
	"updatedAt" TEXT NOT NULL
);
CREATE INDEX "idx_verification_identifier" ON "verification" ("identifier");
