# signal-cli JSON schemas, vendored

The envelope format signal-cli emits, as published in the release asset
`signal-cli-<version>-json-schemas.tar.gz` (a release asset since 0.14.6).
`VERSION` names the release these files were taken from.

They exist for one test: `server.test.ts` → *the envelope contract*. It walks
`ENVELOPE_FIELDS` — every field the adapter reads off an envelope — against
these schemas and fails when one of them is not in the format any more. The
reason is recorded in juno's memory as *signal-cli inbound breaks on
envelope-format rollouts*: when the format moved and this adapter did not,
inbound DMs stopped arriving with no error anywhere. Outbound kept working, so
nothing looked broken.

Refresh them with `bun run schemas:refresh`, which reads the version of the
signal-cli actually installed and downloads the matching asset. `bun run
schemas:check` does the same into a temporary directory and reports a
difference instead of writing one — that is what the scheduled job on juno runs
after the daily signal-cli update.
