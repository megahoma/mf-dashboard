export type ProducerEvidence = {
  generateTypes: boolean;
  sourceSavedAt: number | null;
};

export type InstalledEvidence = {
  folderExists: boolean;
  filesFingerprint: string | null;
};
