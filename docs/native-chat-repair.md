# Native private-chat repair

The canonical repair targets `dsh-aurabot-qq@1.3.0-beta.1` and its existing forked native memory module. It changes owner reply retention and adds panel-only maintenance routes; it does not send QQ messages, call a model, edit a persona, or change memories merely by installing code. Unknown source hashes and versions are refused. The two previously reviewed intermediate hashes are accepted for the runtime-marker upgrade.

## Install and verify

Use the actual absolute host and Aurabot data paths, after checking that its owned agents are idle and have no pending inbox entries:

```powershell
node scripts/update-aurabot-module.js --data-dir <absolute-data-dir> --native-host <absolute-host-dir> --repair-owner-replies --repair-native-context
node scripts/update-aurabot-module.js --data-dir <absolute-data-dir> --native-host <absolute-host-dir> --repair-owner-replies --repair-native-context --apply
```

The updater archives the complete allowlisted active host/forked-memory code and public assets. Models, personas, chats, databases, credentials, inactive local backups and dependencies are excluded. GitHub Releases public download, extraction and disk hashes must verify before replacement. Dependencies and entry points are described by the archived package metadata; existing host installation supplies them.

Reload only the `memory` module through the existing `/aurabot/api/modules/reload` panel route. Read `/aurabot/api/maintenance/host-status`; the unique enabled Aurabot entry, known ownership, idle agents and empty inboxes are required. POST its exact entry ID to `/aurabot/api/maintenance/host-reload` as `{ "id": "<entry-id>" }`. This calls the official plugin manager with the same enabled value. Check the retained receipt for `status: settled` and `result.application: applied`, a changed host `startedAt`, and a fresh status with `ownerReplyPatchLoaded: true`. The marker is a read-only getter because the real module facade wraps function identity. Disk hashes alone do not establish runtime loading.

Only after this proof may `cleanupNativeChatBackup` remove its verified, unchanged owned code backup. It retains all private data backups and refuses extra or altered files. Synthetic verification uses `scripts/run-tests.js`, `AURABOT_SOURCE`, `DSH_ASAR` and `AURABOT_NATIVE_MEMORY_SOURCE`. To reproduce the old overwrite after installation, `AURABOT_HUB_BASELINE` and `AURABOT_NATIVE_MEMORY_BASELINE` may identify the publicly restored original files; imports still resolve against the real host dependencies.

## Review derived context

`POST /aurabot/api/maintenance/context-review` is panel-only and never an LLM tool. A plan identifies the current owner/persona and exact old records: at most one relation removal, two insight text edits and one style line edit. Preview is read-only. Apply requires `apply: true` and the exact preview `expectedHash`; it preserves insight IDs and timestamps and writes a prepared private receipt before saving.

Keep a consistent private SQLite backup, check native public-save normalization on an in-memory clone, and compare the complete logical database after applying. Only the selected plan changes and expected revision increments are allowed. Raw messages and source evidence must stay intact. Failure rollback restores semantic target records when possible; it does not promise original SQLite bytes, revision counters or relation array order. An API failure or incomplete receipt needs local readback before any retry.

## Recover code

Use the deployment receipt's `release_url`, `zip_asset`, tree hash and backup manifest. The Release tag is `aurabot-native-chat-code-backups`. Download the archive and restoration metadata to a new directory, verify ZIP and every file hash, and retain the current code and latest private data before considering replacement. The archive maps `host/` to the package root and `modules/` to the Aurabot user-module root. Only restore reviewed code paths while owned agents are idle, then use the official reload and inspect module errors and runtime status. Restoring an older code version removes its new runtime marker and may restore the old reply-overwrite behavior.

Code archives contain no private database. Never copy an old database over newer conversations or memory events. Review schema compatibility separately; prefer a forward fix for active data. Preserve private backup and maintenance receipts until that decision is resolved.
