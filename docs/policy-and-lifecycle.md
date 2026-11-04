# Policy and lifecycle are separate

The session lifecycle answers “what state is this call in?” Policy answers “is this action allowed, transformed, redacted, or awaiting approval?” Combining them makes replay nondeterministic and can accidentally turn a denied action into an invalid session transition.

The session controller alone moves through `created`, `provisioning`, `connecting`, `ready`, active turn phases, handoff, reconnect, drain, and terminal states. Commands are validated against the current phase and recorded with a causation ID. Replaying the journal reconstructs the same state without rerunning policy or provider code.

Policy executes before the side effect at its named stage: compile, admission, turn, tool, handoff, output, recording, retention, or termination. A deny leaves lifecycle state unchanged unless the application deliberately issues a close or fail command. A transform or redact changes the value passed onward, not historical journal entries. Approval pauses the action through an opaque token; only approval resumption continues evaluation.

Recommended order:

1. Evaluate policy with session identity, consent, elapsed time, and minimal metadata.
2. Record the policy decision or violation.
3. If allowed, issue the lifecycle command or execute the tool.
4. Record normalized result events.
5. On provider failure, decide separately whether to reconnect, drain, or fail.

Fail closed for admission, tool, recording, and retention decisions. Set short deadlines and audit every decision without storing raw credentials or unnecessary transcript content. Keep lifecycle event handlers free of policy side effects so journal replay remains pure.
