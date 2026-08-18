-- Web Push subscriptions (src/lib/push.ts): one row per browser/device, so a
-- user signed in on multiple devices gets a push to every one of them.
-- UNIQUE(endpoint) makes re-subscribing on the same device an upsert.
CREATE TABLE push_subscriptions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_github_id INTEGER NOT NULL, -- matches plans.created_by_id / session.userId
	endpoint TEXT NOT NULL UNIQUE,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_github_id);
