import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server.ts',
    'src/events.ts',
    'src/toolkit.ts',
    'src/core/outcome.ts',
    'src/adapters/openai.ts',
    'src/adapters/livekit.ts',
    'src/adapters/livekit-agents.ts',
    'src/adapters/deepgram.ts',
    'src/adapters/elevenlabs.ts',
    'src/adapters/assemblyai.ts',
    'src/adapters/pipecat.ts',
    'src/pipeline/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  external: [
    'react',
    'react-dom',
    'zod',
    '@openai/agents',
    'livekit-client',
    'livekit-server-sdk',
    '@livekit/agents',
    '@deepgram/sdk',
    '@cartesia/cartesia-js',
    '@elevenlabs/elevenlabs-js',
    'assemblyai',
  ],
});
