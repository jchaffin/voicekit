# @jchaffin/voicekit-cli

The `voicekit` command plans, deploys, inspects, tests, and rolls back VoiceKit
deployments.

```sh
voicekit plan --config voicekit.config.js --env preview
voicekit deploy --config voicekit.config.js --env prod --approve
voicekit status --config voicekit.config.js --release RELEASE_ID --drift
voicekit rollback --config voicekit.config.js --release RELEASE_ID
```

Use `--json` for stable machine-readable output. Releases are persisted atomically
in `.voicekit/releases.json` by default, allowing an interrupted deploy or rollback
to resume with the same `--release` id.
