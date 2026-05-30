// Coach authorization.
//
// Two sources are merged: the build-time env var VITE_AUTHORIZED_COACHES
// (tamper-resistant, requires a redeploy to change — the permanent safety net
// so a coach can never lock themselves out via the dashboard) and the
// runtime-editable list stored on the `settings` row (managed in the Settings
// tab). A user is a coach if their email appears in either list.
//
// If BOTH lists are empty, access is open to any signed-in Google user — this
// preserves the original behavior for fresh/unconfigured deployments.

export function envCoaches(): string[] {
  return (import.meta.env.VITE_AUTHORIZED_COACHES ?? '')
    .split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean)
}

export function authorizedCoachEmails(dbCoaches: string[] = []): string[] {
  const db = dbCoaches.map(e => e.trim().toLowerCase()).filter(Boolean)
  return [...new Set([...envCoaches(), ...db])]
}

export function isAuthorizedCoach(email: string | null | undefined, dbCoaches: string[] = []): boolean {
  const list = authorizedCoachEmails(dbCoaches)
  if (list.length === 0) return true // no allowlist configured anywhere → open
  return list.includes((email ?? '').trim().toLowerCase())
}
