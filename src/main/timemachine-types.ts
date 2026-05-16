export interface TimeMachinePrivacyZone {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
}

export interface TimeMachinePauseSchedule {
  id: string;
  label: string;
  days: number[];
  startTime: string;
  endTime: string;
  enabled: boolean;
}

export interface TimeMachinePrivacySettings {
  zones: TimeMachinePrivacyZone[];
  pauseSchedules: TimeMachinePauseSchedule[];
  excludedApps: string[];
  excludedTitlePatterns: string[];
  excludedDomains: string[];
}

export interface TimeMachineDedupeSettings {
  enabled: boolean;
  sizeDriftThreshold: number;
  chunkBytes: number;
  recentWindowSize: number;
}

export interface TimeMachineClusteringSettings {
  idleGapMinutes: number;
  topTermCount: number;
}

export interface TimeMachineStorageForecast {
  averageScreenshotBytes: number;
  screenshotsPerDay: number;
  estimatedScreenshotRetentionBytes: number;
  existingLocalScreenshotBytes: number;
  existingLocalAudioBytes: number;
  estimatedRetainedTotalBytes: number;
}

export interface TimeMachineActivityCluster {
  id: string;
  start: string;
  end: string;
  frameCount: number;
  representativeFrame: unknown | null;
  topOcrTerms: string[];
}

