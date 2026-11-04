export interface VoiceErrorOptions {
  code?: string;
  provider?: string;
  /** Fatal errors end the session. */
  fatal?: boolean;
  cause?: unknown;
}

/** Normalized error emitted on the `error` event. */
export class VoiceError extends Error {
  readonly code?: string;
  readonly provider?: string;
  readonly fatal: boolean;
  readonly cause?: unknown;

  constructor(message: string, options: VoiceErrorOptions = {}) {
    super(message);
    this.name = 'VoiceError';
    this.cause = options.cause;
    this.code = options.code;
    this.provider = options.provider;
    this.fatal = options.fatal ?? false;
  }
}

export function toVoiceError(err: unknown, defaults: VoiceErrorOptions = {}): VoiceError {
  if (err instanceof VoiceError) return err;
  if (err instanceof Error) {
    return new VoiceError(err.message, { ...defaults, cause: err });
  }
  if (typeof err === 'string') return new VoiceError(err, defaults);
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const message = typeof obj.message === 'string' ? obj.message : JSON.stringify(err);
    const code = typeof obj.code === 'string' ? obj.code : defaults.code;
    return new VoiceError(message, { ...defaults, code, cause: err });
  }
  return new VoiceError(String(err), defaults);
}
