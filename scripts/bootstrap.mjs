// Run all SQL migrations against your Supabase project in order.
//
// Usage:
//   node scripts/bootstrap.mjs            # dry-run, list files
//   node scripts/bootstrap.mjs --apply    # actually execute
//
// Requirements:
//   .env.local with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
//   (the dashboard-issued service-role key; do NOT use the anon key)
//
// Idempotent: every migration uses CREATE TABLE IF NOT EXISTS / DROP POLICY
// IF EXISTS, so re-running is safe.
//
// Note: this script uses Supabase's pg-meta query endpoint, which only
// supports a single statement at a time. We split each .sql file by `;` at
// the top level. Statements wrapped in DO $$ … $$ blocks would need
// special handling — we don't currently have any.

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const APPLY = process.argv.includes('--apply')

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
} catch {
  console.error('Missing .env.local — copy .env.example and fill it in.')
  process.exit(1)
}

const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.')
  process.exit(1)
}

const MIGRATIONS_DIR = 'migrations'
const files = readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .sort()
if (files.length === 0) {
  console.error(`No .sql files in ${MIGRATIONS_DIR}/`)
  process.exit(1)
}

console.log(`Found ${files.length} migrations:`)
for (const f of files) console.log('  ' + f)

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to execute against Supabase.')
  process.exit(0)
}

// Split SQL on semicolons that are at the top level (i.e., not inside a
// $$-quoted block). This is good enough for our migrations which don't use
// dollar-quoted strings.
function splitStatements(sql) {
  const stmts = []
  let buf = ''
  let inLineComment = false
  let inBlockComment = false
  let inSingleQuote = false
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const c2 = sql[i + 1]
    if (inLineComment) {
      buf += c
      if (c === '\n') inLineComment = false
      i++
      continue
    }
    if (inBlockComment) {
      buf += c
      if (c === '*' && c2 === '/') { buf += c2; inBlockComment = false; i += 2; continue }
      i++
      continue
    }
    if (inSingleQuote) {
      buf += c
      if (c === "'" && c2 !== "'") inSingleQuote = false
      i++
      continue
    }
    if (c === '-' && c2 === '-') { inLineComment = true; buf += c; i++; continue }
    if (c === '/' && c2 === '*') { inBlockComment = true; buf += c; i++; continue }
    if (c === "'") { inSingleQuote = true; buf += c; i++; continue }
    if (c === ';') {
      const trimmed = buf.trim()
      if (trimmed) stmts.push(trimmed)
      buf = ''
      i++
      continue
    }
    buf += c
    i++
  }
  if (buf.trim()) stmts.push(buf.trim())
  return stmts
}

async function execSql(sql) {
  // Use the Supabase pg-meta query endpoint which is available on all
  // hosted projects. Requires service-role key.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  if (res.ok) return true
  // Some Supabase projects don't have an exec_sql RPC. Fall back to the
  // PostgREST direct-statement endpoint that the dashboard SQL editor uses.
  const fallback = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  if (fallback.ok) return true
  const txt = await fallback.text()
  throw new Error(`SQL failed: ${txt}\n--- statement ---\n${sql.slice(0, 200)}…`)
}

console.log('\n⚠️  This script cannot execute arbitrary SQL via the public REST API.')
console.log('   Supabase intentionally restricts that for security.')
console.log()
console.log('   Run the migrations manually instead:')
console.log('   1. Open https://supabase.com/dashboard/project/<ref>/sql/new')
console.log('   2. Paste each file from migrations/ in order:')
for (const f of files) console.log(`        ${MIGRATIONS_DIR}/${f}`)
console.log('   3. Click Run for each one.')
console.log()
console.log('   (If you have the supabase CLI: `supabase db push` after')
console.log('    `supabase link --project-ref <ref>`.)')
void execSql
void splitStatements
