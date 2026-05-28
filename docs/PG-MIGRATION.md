# Postgres migration plan — encrypted-JSON → relational store

> **Status: planning only.** This document defines the target schema, cutover
> strategy, and risks. **Do not migrate yet.** Approve + dry-run on staging
> first; backups (see [`DR.md`](./DR.md)) must be in place beforehand.

## Why
Today `apps/spawn/data/*.enc` is the source of truth for orders, users,
tokens, requests, events. It's a single-node file store decrypted in memory on
every read. Pain we've actually hit: rotating `.enc.bak.*` files instead of a
real backup, no ACID guarantees under concurrent writes, no efficient queries
for admin/analytics, slow startup as files grow, no schema evolution path.

## Target schema (initial pass; tighten before migration)

| Table | Purpose | Notable columns |
|---|---|---|
| `users` | Account-keyed by email | `email` (PK), `created_at`, `balance_cents`, `stripe_customer_id`, `pii_blob` (envelope-encrypted JSON for fields we shouldn't query) |
| `api_keys` | `sk_live_` programmatic keys | `id` (PK), `user_email` (FK), `hash`, `label`, `created_at`, `last_used_at`, `revoked_at` |
| `orders` | One row per spawn | `id` (PK), `email`, `plan_id`, `status`, `server_ip`, `server_id`, `region`, `runtime`, `created_at`, `last_heartbeat`, `payment_method`, `agent_last_frame_at`, `auto_restart_status` |
| `tokens` | `osk_` Bearer tokens scoped to an order | `id` (PK), `hash`, `order_id` (FK), `created_at`, `revoked_at` |
| `requests` | Universal action receipts | `id` (PK = `request_id`), `order_id`, `action`, `status`, `triggered_by`, `created_at`, `completed_at`, `result_json`, `failure_code` |
| `events` | Append-only server event plane | `id` (BIGSERIAL), `order_id`, `type`, `request_id?`, `ts`, `payload_json` |
| `idempotency` | Spawn idempotency cache (24 h) | `key` (PK), `response_blob`, `created_at` |
| `inflight_chat` | Per-order chat checkpoint (today: `chat-inflight/*.json`) | `order_id` (PK), `request_id`, `text`, `started_ms`, `updated_at` |

Indexes (minimum): `orders(email,created_at desc)`, `orders(status,last_heartbeat)` (wedge detector), `events(order_id,id desc)`, `requests(order_id,created_at desc)`, `tokens(hash)`, `api_keys(hash)`.

## Per-row PII encryption
- App-layer **envelope encryption** for fields that must remain confidential
  (Stripe identifiers, full names, contact details). The row stores
  `pii_blob = AES-256-GCM(plaintext, DEK)` and `dek_wrapped = wrap(DEK, KEK)`.
- KEK lives in a sidecar (HashiCorp Vault, Hetzner Secrets, or — interim — a
  file outside Postgres with `0600` perms not part of `pg_dump`).
- Public/searchable fields (email, balance_cents, status) remain plaintext
  columns so indexes work. Anything PII-only stays in `pii_blob`.

## Cutover (dual-read / dual-write)
1. **Phase 0 — Backups.** Off-box backups verified (`DR.md` runbook). Without
   this, do not start. (Tracked by goal P0a.)
2. **Phase 1 — Stand up Postgres + run migrations.** Same host initially
   (`localhost:5432`), HA/replication later.
3. **Phase 2 — Dual-write behind feature flag** (`SPAWN_PG_DUAL_WRITE=1`).
   Every mutation writes to both the `.enc` file AND Postgres. Reads still
   come from `.enc`. Catches divergence early via a checksum/count compare.
4. **Phase 3 — Backfill.** One-shot script reads each `.enc` → writes rows
   to Postgres. Run twice; diff. Tolerate 0 mismatches before flip.
5. **Phase 4 — Flip reads.** Add `SPAWN_PG_READ=1` flag; reads served from
   Postgres, writes still dual. Run for ≥7 days. Monitor request latency,
   wedge-detector behavior, and event-plane SSE for regressions.
6. **Phase 5 — Retire `.enc` writes.** Stop dual-writing once Postgres reads
   have been stable. Keep `.enc` files as a frozen archive snapshot.
7. **Phase 6 — HA.** Add a read replica + automated failover (separate doc).

## Risks
- **Schema drift mid-flight.** Mitigate: all schema changes go through a
  versioned migration directory (`migrations/NNNN_<name>.sql`), applied by a
  startup step that records `schema_version`. No ad-hoc `ALTER TABLE`.
- **Encrypted-blob portability.** The current `.enc` envelope was built for
  AES-GCM on a single key. The migration must decrypt with the current key
  and re-encrypt the PII subset under the new envelope scheme.
- **Throughput regression.** The server is single-node Node.js; Postgres on
  the same host competes for memory. Run Phase 3+ on a sized box (≥4 GB) and
  measure spawn-app p99 latency before/after.
- **Operational complexity.** Postgres adds backup/restore + minor-version
  upgrades + WAL management to the operator's plate. Update `DR.md`
  alongside this work to include `pg_basebackup` + WAL archiving.

## What this plan deliberately does NOT do (yet)
- Multi-node HA / failover (separate doc once Postgres is stable).
- Cross-region replication.
- Postgres on a different host (run on the same VM first; minimize moving
  parts during cutover).
- Migrating `dash-chat/*.ndjson` or the gateway transcript — those stay file-
  based for now (append-only logs; not a relational fit).
