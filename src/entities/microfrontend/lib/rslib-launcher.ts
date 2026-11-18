import fs from "node:fs";
import { canonicalPathIsInside } from "../../../shared/lib/paths.ts";
import type { LocalApp } from "../models/config.ts";

export function isRslibLauncherAncestor(launcher: string, project: string): boolean {
  try {
    return canonicalPathIsInside(fs.realpathSync.native(launcher), fs.realpathSync.native(project));
  } catch {
    return false;
  }
}

export function isRslibProjectForLauncher(
  project: LocalApp,
  launcher: LocalApp,
  sameFile = sameCanonicalFile,
): boolean {
  return (
    !project.launchFolder &&
    launcher.launchFolder !== undefined &&
    project.name === launcher.name &&
    project.rslibConfigFile !== undefined &&
    launcher.rslibConfigFile !== undefined &&
    project.federationNameOrigin === launcher.federationNameOrigin &&
    sameFile(project.folder, launcher.folder) &&
    sameFile(project.rslibConfigFile, launcher.rslibConfigFile)
  );
}

export function isIndependentRslibProject(project: LocalApp, launcher: LocalApp): boolean {
  return (
    launcher.launchFolder !== undefined &&
    isRslibProjectForLauncher(project, launcher) &&
    !isRslibLauncherAncestor(launcher.launchFolder, project.folder)
  );
}

function sameCanonicalFile(first: string, second: string): boolean {
  try {
    return fs.realpathSync.native(first) === fs.realpathSync.native(second);
  } catch {
    return false;
  }
}
