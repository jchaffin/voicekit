# Migrating from v1 alpha.0 to alpha.1

Alpha.1 adds contracts without changing the protocol version.

1. Update allowed workspace packages and their internal VoiceKit dependencies to `1.0.0-alpha.1`.
2. For GPT-Live, choose one delegation mode per session: `responses` or `client`. Move interruption behavior into the explicit cancellation policy.
3. Treat listening and speaking as independent booleans. Do not derive one as the inverse of the other.
4. Persist experiment assignment before routing. Reuse it on reconnect and deduplicate assignment, exposure, and outcome writes.
5. Choose one experiment owner. ElevenAgents-native routing omits branch/version; VoiceKit-managed routing supplies both.
6. Replace ambiguous LiveKit deployment IDs with named descriptors containing agent, deployment, and environment.
7. Surface delegated-task and experiment state through the React stores. Use the UI live regions and semantic controls rather than announcing state changes manually.
8. Add the alpha.1 semantic conformance suites and deterministic simulations to CI.

No live certification is implied by an offline pass. Keep network suites skipped until the required secret references are supplied in a controlled CI environment.
