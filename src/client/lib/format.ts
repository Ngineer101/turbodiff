// Display formatting, ported verbatim from the old server-rendered pages so
// numbers read identically before and after the SPA migration.

// D1's datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS'.
export function parseUtc(sql: string): number {
	return Date.parse(`${sql.replace(' ', 'T')}Z`);
}

export function ago(sql: string): string {
	const s = Math.max(0, Math.floor((Date.now() - parseUtc(sql)) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

export function fmtUsd(n: number): string {
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n >= 0.01) return `$${n.toFixed(3)}`;
	if (n > 0) return `$${n.toFixed(4)}`;
	return '$0.00';
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}K`;
	if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
	return String(n);
}

export function fmtDuration(seconds: number): string {
	const s = Math.max(1, Math.round(seconds));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(ym: string): string {
	const [y, m] = ym.split('-');
	return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}
