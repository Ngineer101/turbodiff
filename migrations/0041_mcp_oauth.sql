-- OAuth 2.1 authorization-server tables for better-auth's mcp plugin
-- (src/integrations/auth/better-auth.ts): turbodiff.dev issues bearer tokens
-- that MCP hosts present to POST /mcp. The plugin reuses the oidc-provider
-- model set — oauthApplication rows are dynamically registered clients
-- (RFC 7591), oauthAccessToken holds issued access/refresh token pairs, and
-- oauthConsent records grant decisions (only written when a client sends
-- prompt=consent; the default flow skips consent).
--
-- Table/column names are the plugin's defaults (singular models, camelCase
-- fields — see the oidc-provider schema in better-auth), matching the 0026
-- convention: ISO-8601 TEXT dates, INTEGER 0/1 booleans. "redirectUrls" is
-- the installed plugin's spelling of the redirect-URI list (comma-joined).

CREATE TABLE "oauthApplication" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"name" TEXT,
	"icon" TEXT,
	"metadata" TEXT,
	"clientId" TEXT NOT NULL UNIQUE,
	"clientSecret" TEXT,
	"redirectUrls" TEXT,
	"type" TEXT,
	"disabled" INTEGER,
	"userId" TEXT,
	"createdAt" TEXT NOT NULL,
	"updatedAt" TEXT NOT NULL
);

CREATE TABLE "oauthAccessToken" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accessToken" TEXT NOT NULL UNIQUE,
	"refreshToken" TEXT UNIQUE,
	"accessTokenExpiresAt" TEXT,
	"refreshTokenExpiresAt" TEXT,
	"clientId" TEXT NOT NULL,
	"userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
	"scopes" TEXT,
	"createdAt" TEXT NOT NULL,
	"updatedAt" TEXT NOT NULL
);
CREATE INDEX "idx_oauthAccessToken_userId" ON "oauthAccessToken" ("userId");

CREATE TABLE "oauthConsent" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"clientId" TEXT NOT NULL,
	"userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
	"scopes" TEXT,
	"consentGiven" INTEGER,
	"createdAt" TEXT NOT NULL,
	"updatedAt" TEXT NOT NULL
);
