# Fish world life module

Canonical source: extensions/aurabot/fish-world. Node built-ins only, no new database or model assets. Requires compatible Aurabot module API with tools guards, session/event, llm/stream, Agent.whenIdle, sessionQuery and core/usage.js. Existing persona, MCP, QQ, keys, quotas, sharing and non-blocking prompt refresh remain in place.

## Scheduling and plans

Every start, including owner arrangements, recovery, work inspection and plan continuation, uses one durable admission/reservation path. normalMinGapMs=180000; urgentMinGapMs=30000; urgentMaxRoundsPer10Min=4; planRecheckMinMs=300000; unchangedPlanRoundLimit=1. Only trusted work/doorbell/health event versions qualify for an urgent exception. This still consumes the existing daily category quota. Idle remains 20 minutes, work fallback and same-sender social cooldown remain five minutes. Unknown submission reservations are retained, never refunded into retries.

planChanges supports create/update/complete/expire/abandon/block/supersede/merge. Updates require stable id and expectedRevision; merges/supersedes require targetId and targetExpectedRevision. The program verifies identity, subject, topic, stage, business time window and owner instruction revision. Legacy plans is normalized; repeated create returns the existing ID without reviving waiting/review/terminal state. nextAt is earliest continuation, not expiry. Explicit expiresAt or successful evidence supports terminal disposition. One unchanged check waits for a relevant event, state or explicit future time. Historical ambiguity requires review, never one model call per old row.

idleWorkHours and activityWorkHours use Beijing time ranges, including midnight crossings, e.g. 18:00-09:00,12:00-14:00. Empty preserves existing schedules; invalid nonempty input holds starts. Owner and recovery still pass quota, spacing and volume checks. Queues remain intact when paused or exhausted. Quota alerts merge by identity/date/category/reason and are panel notices, never urgent QQ or a sharing backlog.

## Context and usage

backgroundContextEnabled retains its current setting; backgroundContextRounds defaults to 16 completed life rounds. A current task carries at most 12 related plans and eight events. Changed records use keyed added/updated/removed. Full plans, source receipts, unknown operations and original sessions remain durable. fish_life_history pages at most ten records and about 4000 characters; part retrieves every byte of long evidence without a model summary.

roundPromptEstimatedTokenLimit=12000; visibleContextEstimatedTokenLimit=48000; requestAdmissionEstimatedTokenLimit=64000. All visible blocks/tools and unknown wrapper reserve contribute to startup estimates; the official final llm/stream hook checks complete request messages/tools/system before forwarding. These are heuristics, not provider tokenizer guarantees. Stopped recovery may use a bounded read-only fresh window after Agent.whenIdle and no tools/outbound execution. It cannot repeat unknown actions. Unbound windows are reused after failed admission.

session/event append assistant/message and failed assistant/attempt records are deduplicated by session ID and event sequence. Provider usage and host core/usage.js CNY pricing produce fresh/cached/output and estimatedCny. Missing/late usage is pending then unknown; unknown prices/cache-write pricing are unknown, never free. Records retain round/window/trigger/category/source/plan/reason. Cold-window requests count too. Historical pre-upgrade day usage is unknown until an explicit verified baseline is imported.

costGuardEnabled defaults false (observation only). costSoftLimitCny=2 and costStopLimitCny=3 are configurable startup thresholds. If enabled, unknown/in-flight usage holds new starts; soft threshold holds ordinary idle exploration; stop threshold holds all new automatic rounds. Existing requests may still cost money. No strict per-step or daily bill cap is promised. The panel shows estimates, remaining rounds, blockers and next allowed time; diagnosis expands exact attribution.

## Schema and deployment

Runtime schema 3 / life schema 2 requires explicit migration. An old ledger opens under a read-only gate: no polling, model, delivery or runtime writes. The gate checks stopped owned agents and no outstanding round/tool/outbound, waits at least 15 seconds of stable old ledger, and emits a fresh writer-quiescence witness. Unresolved execution prevents migration. scripts/migrate-fish-world-ledger.js provides dry run, apply and guarded rollback; see its --help and docs/context-governance.md.

Build/update via the canonical set-context-module-version/build-context-modules/update-aurabot-module tools. The updater publicly downloads, extracts and hashes the exact old code Release before replacing installed code. Code backups contain no ledger or credentials. Migration separately retains private original bytes, hashes, maps and apply receipts. Restore an old ledger only if the new ledger is completely unchanged; after new events, keep the latest data, pause autonomy and use a forward fix or reviewed compatibility export. Never overwrite new events with an old snapshot.

Run node scripts/run-tests.js with fish-world and context-governance/work-hours test basenames. Managed synthetic scratch is cleaned even on failure; reports and cleanup receipts remain. Real history audits and required backups are private and are not disposable test scratch.
