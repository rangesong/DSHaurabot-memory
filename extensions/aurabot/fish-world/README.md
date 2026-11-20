# Fish world life module

Canonical source: extensions/aurabot/fish-world in this repository. Uses Node built-ins and the Aurabot module API; requires Aurabot 1.3.0-beta.1 or compatible. No additional npm dependencies or model assets. Existing deployed guard, receipt, sharing and non-blocking refresh behavior are retained.

backgroundContextEnabled (default false) controls only background life windows. backgroundContextRounds defaults to 16 completed life rounds (8–64). In-flight operations, recovery and unsettled delivery pin the current window. Disabling stops future rollover while continuing the current window. It never resets identity, plans, quotas, idempotency IDs or failures.

The durable handoff lives in the module data directory under context-handoffs; the runtime ledger remains runtime.json. Each new window includes complete unfinished state. Stable rules and identical full Thinkstar material appear once per visible window and are restored if absent. fish_life_history lists all owned windows and reads exact raw source events via the supported host sessionQuery service. No automatic summarization model calls.

Build, archive, update and rollback instructions: docs/context-governance.md. Real runtime files, credentials and session logs must never be committed.
