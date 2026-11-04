// Ambient declarations for optional peer dependencies.
// These allow TypeScript to compile adapter files even when the
// peer dependency is not installed.

declare module 'livekit-client' {
  export class Room {
    connect(url: string, token: string): Promise<void>;
    disconnect(): Promise<void>;
    on(event: string, handler: (...args: any[]) => void): void;
    localParticipant: {
      setMicrophoneEnabled(enabled: boolean): Promise<void>;
      publishData(data: Uint8Array, options?: { reliable?: boolean }): Promise<void>;
    };
  }
  export const RoomEvent: {
    TrackSubscribed: string;
    DataReceived: string;
    Disconnected: string;
    Reconnecting: string;
    Reconnected: string;
  };
  export const Track: {
    Kind: { Audio: string; Video: string };
  };
}

declare module '@livekit/agents' {
  export namespace voice {
    interface SpeechHandle {
      allowInterruptions: boolean;
    }
    interface AgentSession {
      say(text: string): unknown;
      generateReply(options?: { instructions?: string; allowInterruptions?: boolean }): unknown;
    }
    interface RunContext<UserData = any> {
      readonly session: AgentSession;
      readonly speechHandle: SpeechHandle;
      readonly userData: UserData;
      disallowInterruptions(): void;
      waitForPlayout(): Promise<void>;
    }
    class Agent<UserData = any> {
      constructor(options: { instructions: string; tools?: llm.ToolContextLike<UserData> });
      get session(): AgentSession;
      onEnter(): Promise<void>;
    }
  }
  // Mirrors @livekit/agents >= 1.9: tools are named; object-map syntax takes anonymous tools.
  export namespace llm {
    interface FunctionTool<Parameters = any, UserData = any, Result = unknown> {
      readonly type: 'function';
      readonly id: string;
      readonly name: string;
      description: string;
    }
    type AnonFunctionTool<Parameters = any, UserData = any, Result = unknown> = Omit<
      FunctionTool<Parameters, UserData, Result>,
      'id' | 'name'
    > & { id?: undefined; name?: undefined };
    class ToolContext<UserData = any> {
      constructor(tools?: ToolContextInit<UserData>);
    }
    type ToolContextInit<UserData = any> =
      | readonly FunctionTool<any, UserData, any>[]
      | Record<string, AnonFunctionTool<any, UserData, any>>;
    type ToolContextLike<UserData = any> = ToolContext<UserData> | ToolContextInit<UserData>;
    class ToolError extends Error {
      constructor(message: string);
    }
    function tool<UserData = any>(options: {
      name?: never;
      description: string;
      parameters?: unknown;
      execute: (
        args: any,
        opts: { ctx: voice.RunContext<UserData>; toolCallId: string; abortSignal?: AbortSignal },
      ) => Promise<unknown>;
    }): AnonFunctionTool<any, UserData>;
  }
}

declare module 'livekit-server-sdk' {
  export class AccessToken {
    constructor(apiKey: string, apiSecret: string, options: { identity: string; ttl?: string });
    addGrant(grant: { roomJoin: boolean; room: string }): void;
    toJwt(): Promise<string>;
  }
}
