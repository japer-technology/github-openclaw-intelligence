export interface CompactionSettings {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export function buildCompactionConfig(settings?: CompactionSettings) {
  // reserveTokens remains accepted in legacy settings, but OpenClaw no longer
  // accepts it in runtime config. Let OpenClaw manage its own reserve budget.
  return {
    ...(settings?.enabled === undefined ? {} : { enabled: settings.enabled }),
    ...(settings?.keepRecentTokens === undefined ? {} : { keepRecentTokens: settings.keepRecentTokens }),
  };
}
