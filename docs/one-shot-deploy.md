# One-shot deployment

VoiceKit deployments are immutable definitions compiled into a digest-addressed manifest. A single deployment may provision a web endpoint, hosted voice runtime, provider resources, migrations, and verification gates while preserving provider-specific rollback behavior.

Define resources and dependencies with `defineDeployment`, bind environment variables as JSON primitives, and bind secrets with `secret("REFERENCE_NAME")`. Secret values are never valid deployment input. `planDeployment(definition, "preview" | "prod")` topologically orders resources, migrations, and gates and returns a canonical SHA-256 digest.

Construct `DeploymentEngine` with provider adapters, a durable release ledger, a secret resolver, and a gate evaluator. Calling `deploy(artifact, releaseId)` is resumable: succeeded operations are not repeated, provider writes receive stable release idempotency keys, and an operation ledger records attempts and outputs. Reusing a release ID with another manifest is rejected.

For production:

1. Plan preview and store the manifest and digest as release artifacts.
2. Deploy preview and run simulation, conformance, health, and end-to-end gates.
3. Require human approval for production.
4. Plan production from the same reviewed definition.
5. Deploy with a unique release ID and retain the ledger.
6. Run drift inspection after deployment.
7. Roll back only through `engine.rollback`; it compensates successful reversible operations in reverse order.

One-shot does not mean unaudited. Non-reversible migrations must be backward compatible, gates must precede promotion, and provider adapters must be pinned and certified. Never place SDK tokens in resource config, generated manifests, command arguments, or logs.
