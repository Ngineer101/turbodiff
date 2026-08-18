-- Teams & orgs, layered on the better-auth Organization plugin
-- (src/lib/better-auth.ts) rather than a bespoke roles table: `organization`
-- gets people/roles for a GitHub-Organization-type installation the same way
-- migration 0026 gave installations sign-in identity. One organization row
-- per Organization-type installations row, linked 1:1 by the `installationId`
-- additional field below (installations stays the GitHub-derived resource
-- record; organization becomes its roles record). User-type (personal)
-- installations never get one.
--
-- Table/column names and shapes mirror better-auth's own defaults for the
-- same reason 0026 did: camelCase fields, ISO-8601 TEXT dates, 0/1 booleans
-- (none needed here). `team` is deliberately not created — v1 roles are
-- org-wide, not per-team, and the plugin only wires up its team endpoints
-- when `teams: { enabled: true }` is passed, which better-auth.ts doesn't do.

CREATE TABLE "organization" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"name" TEXT NOT NULL,
	"slug" TEXT NOT NULL UNIQUE,
	"createdAt" TEXT NOT NULL,
	"updatedAt" TEXT,
	"installationId" INTEGER NOT NULL UNIQUE REFERENCES installations(id) ON DELETE CASCADE
);

CREATE TABLE "member" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
	"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	"role" TEXT NOT NULL DEFAULT 'member',
	"createdAt" TEXT NOT NULL,
	UNIQUE ("organizationId", "userId")
);
CREATE INDEX "idx_member_userId" ON "member" ("userId");

CREATE TABLE "invitation" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
	"email" TEXT NOT NULL,
	"role" TEXT NOT NULL,
	"status" TEXT NOT NULL DEFAULT 'pending',
	"expiresAt" TEXT,
	"createdAt" TEXT NOT NULL,
	"inviterId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_invitation_organizationId" ON "invitation" ("organizationId");
