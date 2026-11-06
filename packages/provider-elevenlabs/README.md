# VoiceKit ElevenLabs provider

SDK-agnostic contracts for standalone Eleven Realtime, TTS, and ElevenAgents resources.

ElevenAgents versions, branches, deployments, experiments, route descriptors, attribution, and analytics filters are represented as data. VoiceKit does not invent provider SDK methods: applications translate these descriptors at their HTTP or SDK boundary.

Experiments require at least two unique branch/version targets and percentages totaling exactly 100. Use `provider-assigned` routing to let ElevenAgents choose a variant, or `voicekit-explicit` routing when VoiceKit has already selected the branch and version. Persist the actual branch/version returned in initiation metadata with `readElevenAgentsAttribution`.

Signed URL, WebRTC token, and initiation-webhook flows use `ElevenAgentsRouteDescriptor`. Standalone Eleven Realtime is exposed separately as `product: "eleven-realtime"` and is not an ElevenAgents experiment surface.

Custom tools are shared agent resources. A tool change can affect multiple branches or versions; use separately versioned tool implementations when isolation is required. The exported `elevenAgentsCustomToolVersionCaveat` makes this limitation explicit.
