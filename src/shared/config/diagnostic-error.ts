export const STAGES = ["manifest", "archive", "shell", "destination", "generation"] as const;

export const REASONS = [
  "http-status",
  "timeout",
  "network",
  "invalid-manifest-url",
  "invalid-json",
  "missing-types-metadata",
  "invalid-zip",
  "archive-invalid",
  "directory-missing",
  "directory-empty",
  "fingerprint-mismatch",
  "unsafe-alias",
  "unsafe-types-folder",
  "path-escape",
  "shell-exit",
] as const;
