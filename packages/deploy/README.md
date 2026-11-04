# @jchaffin/voicekit-deploy

Deployment planning and resumable execution for VoiceKit services.

```ts
import { defineDeployment, planDeployment, secret } from "@jchaffin/voicekit-deploy";

const deployment = defineDeployment({
  name: "support-agent",
  resources: [{ id: "web", provider: "vercel", type: "web" }],
  environments: {
    preview: { secrets: { API_KEY: secret("VOICEKIT_PREVIEW_API_KEY") } },
    prod: { secrets: { API_KEY: secret("VOICEKIT_PROD_API_KEY") } },
  },
});

const plan = planDeployment(deployment, "preview");
```

Secret values are resolved only at execution time through an injected `SecretResolver`.
Provider side effects are performed only through injected `CommandRunner` or `HttpClient`
interfaces, making plans deterministic and tests credential-free.
