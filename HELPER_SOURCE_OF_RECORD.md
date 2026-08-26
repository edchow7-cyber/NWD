# Next Watch Helper Source of Record

Current deployed production Helper: **v2.2.7**

Deployment verified: 2026-08-26

Production artifact: `Helper_v2.2.7_ledger_hardening.txt`

SHA-256: `a660e47f4bf9f706c2f9c81b7ed25b29d39e444d19d1a7cbf56aabb2fd1aebb0`

## Provenance

The 2026-08-22 deployment artifact had a stale header comment saying v2.2.3 while the actual runtime constant was `NW.VERSION = '2.2.4'`. Ed manually corrected that comment in the deployed copy. The exact prior artifact supplied on 2026-08-26 was therefore treated as the authoritative v2.2.4 baseline for the v2.2.5-v2.2.7 hardening work.

## 2026-08-26 release state

- GUI Genre filtering is verified working from published repository views.
- Movie/TV Genres are exposed in the applicable STAGE/VIEW projections; Experience Tags remain excluded.
- Helper v2.2.7 preserves the v2.2.4 exact Services/provider matching behavior.
- Append-heavy ledgers use capacity-safe, readback-verified append logic.
- Legacy duplicate Audit Event IDs no longer block unrelated appends.
- MNT016 readback tolerates only trailing all-blank row collapse; missing/changed nonblank rows still fail closed.
- `testMnt016Api()` completed successfully under v2.2.7.
- The old `testMnt016Replay()` harness requires a test-only correction because it looked only for a still-eligible cycle after the integration test had already consumed it. This is not a production runtime defect.

## Repository note

`Helper_v2.2.3_developer_tools.js` is historical and must not be treated as the current production source. Until the full v2.2.7 artifact is copied into GitHub through a byte-capable source-sync path, this manifest plus the SHA-256 above is the authoritative GitHub provenance record for the deployed helper.
