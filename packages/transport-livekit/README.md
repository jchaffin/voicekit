# VoiceKit LiveKit transport

SDK-agnostic room transport plus explicit dispatch descriptors for API, participant-token, and SIP entry points.

Every explicit dispatch names both an agent and a deployment, carries JSON-only metadata, and defaults to `production`. `experimentAssignmentId` is intentionally opaque so routing layers can pass an assignment through without interpreting it.

`createLiveKitDispatchDescriptor` only validates and represents intent. It does not call undocumented LiveKit SDK methods; the host application maps the descriptor to the LiveKit API or SDK it uses.
