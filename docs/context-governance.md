# World life and owner-private context governance

Canonical sources are extensions/aurabot/fish-world and extensions/aurabot/history-vault. The baseline preserves the currently installed guards, receipt ledger, native memory preparation bridge and non-blocking world refresh. The Thinkstar core, group integration and third-party installed code are not changed by this package.

## Build and publish

Requires Node 22.13+ and compatible Aurabot 1.3.0-beta.1 module APIs. The extensions use Node built-ins; DSH supplies sessionQuery, Session and tool services. No credentials, models or databases are bundled.

    node scripts/set-context-module-version.js fish-world 1.1.0
    node scripts/set-context-module-version.js history-vault 0.2.2
    node scripts/build-context-modules.js
    node scripts/run-tests.js context-governance.test.js
    node scripts/update-aurabot-module.js --extension fish-world --data-dir <absolute-data-directory>
    node scripts/update-aurabot-module.js --extension fish-world --data-dir <absolute-data-directory> --apply

Repeat the updater for history-vault. Without --extension the entry retains its original Thinkstar behavior. Builds are generated in dist/aurabot/context/<id>-<version>; do not edit them. Increment source versions for changed builds. Old code is archived to GitHub Releases, publicly downloaded, extracted and hash-verified before replacement. Installation receipts are in runtime-data/installations. Local rollback code remains until host validation; cleanupContextBackup removes only the exact verified receipt-owned directory. Unrecognized cache files are retained for review.

## World life settings and continuity

backgroundContextEnabled controls only background world life. backgroundContextRounds defaults to 16 completed successful life rounds, range 8–64; calls and retries do not increment it. Recovery, in-flight tools, uncertain operations and unsettled delivery pin the current window. Disabling stops further rotation while continuing the current window. Identity, quotas, request IDs, cooldowns and failures remain in the same runtime ledger.

The additive contextWindow state and context-handoffs files preserve complete unfinished plans/events, exact nextAt/trigger, owner instructions, identity, observed world state and timestamps, quotas, uncertain receipts and sharing outbox. Closed plan history is bounded independently; unfinished plans are not sliced away. A new window receives a full handoff; later rounds send changed fields. Stable rules and identical complete Thinkstar material are reused only while their full content and the required state chain remain visible. A missing/partially compressed chain causes full restoration. fish_life_history lists all owned windows and reads exact source events through the supported sessionQuery API. It is read-only and cannot authorize repeated actions.

## Owner-private settings and existing compression

contextDedupEnabled is the private master switch. contextMemoEnabled, contextImagesEnabled and contextToolsEnabled are independent; contextRetainTurns defaults to 8 (minimum 4). contextCompressionOrigin is the existing engine's loopback HTTP origin, configured at installation. Only the current owner's private session is eligible. Forgetting, retention, protection, archive and recall parameters remain unchanged for both private and group memory.

The deployed path uses billion-context's existing /__bili/plugin/tool compression API for deterministic text folds, keeping all existing active blocks. It does not run a competing host text compactor or trigger a summary model. scripts/plan-owner-context.js --help describes explicit paths for a read-only source/variant audit and numerical kernel replay; --write-plan requires a verified recovery backup and writes only the history module's own private data directory. Plan scopes and source refs are checked before application, and extra model summary configuration causes refusal. Unique tool results, failures, uncertain outcomes and current evidence are retained.

The current engine excludes image cells from its compression substrate. A separately tested, version-checked image-only Session surface projection can therefore remove exact duplicate USER images without replacing compressed text or tool results. It keeps all original text and source roles, full matching anchors, recent turns and comparison/OCR/coordinate tasks. Tool-result images remain unchanged in existing-engine mode. Different crops, resolutions, content IDs and non-display metadata are preserved; display filenames alone are not image identity. The compatibility receipt tests that even removing every unassigned image leaves every active compression block intact. An engine version/commit change suspends this image path until revalidated.

Host projection helpers are tested for protocol correctness, including tool-result content-only replacement, but are not the deployed text path when an external engine owns compression. context_evidence_read restores exact original text with pagination or original image blocks with images=true. Full source logs, attachments and memory remain intact.

## Recovery and cleanup

Before application, retain current configuration, world ledger, source session and a consistent compression-store backup. Use the engine's online backup API and verify the resulting SQLite backup read-only. Keep these private files local. Disable the corresponding switches to stop new decisions. Existing surface decisions and compression blocks remain traceable; original evidence can be expanded through context_evidence_read or the owning engine's decompress/search tools. Do not delete memory or reset world accounting to roll back.

For code rollback, download the exact ZIP and restore manifest linked by the installation receipt, verify SHA256 and every context-build.json file entry, then restore into a NEW empty directory. Use the updater's checked staging/rollback procedure while the affected module is stopped. Restoring old world routing requires reviewing the latest handoff and pending operations before resuming. No database schema change is introduced; contextWindow is additive and older code ignores it.

Tests use scripts/run-tests.js and scripts/lib/test-workspace.js. Set DSH_ASAR and BILI_KERNEL_FILE for mandatory local integration proofs against the installed SDK and isolated current compression kernel. Portable test runs explicitly skip unavailable installed-runtime checks. All synthetic databases/caches/extractions are automatically removed; reports, logs, results and cleanup receipts remain. Real memory, models, attachments, chat logs and necessary backups are never included in cleanup or GitHub assets.

## Evidence and soft targets

Synthetic input/cost estimates, real-history in-memory replay, live-host functionality and provider billing are reported separately. Soft targets are 80–120k total input for world life and 200–250k for owner private; essential evidence is preserved above them. Include cold-cache rebuilding, reuse, output and calls per completed task. Seek at least 30 comparable natural requests for each target; do not manufacture QQ traffic, world mutations or paid model samples. A daily total or one low request is not proof of causal savings.

Automatic follow-up text batches have their own switch and require at least 16 completed turns, a 20-minute interval, and 20k estimated tokens saved. A full-cache-rebuild payback gate additionally assumes a fresh/cache unit-price ratio of 50 and 128 later reuse requests, with 25% margin. These are conservative configurable estimates, not measured savings. Small unprofitable folds remain untouched; no extra model call is used to decide. At most 128 live compressible refs are inspected, failed/insufficient attempts wait five minutes, and existing engine protection/ref checks remain authoritative.
