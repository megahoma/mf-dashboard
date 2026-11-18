import { UNKNOWN } from "../config/config.ts";
import type { ObjectValue, Value } from "../models/config.ts";
import { object } from "./static-values.ts";

const MAX_EXPOSE_REQUEST_LENGTH = 64 * 1024;
const MAX_EXPOSE_REQUEST_WORK = 1024 * 1024;

export function rslibMfConfig(config: Value): ObjectValue | null {
  if (!object(config)) return null;
  const profiles = config.lib === undefined ? [{}] : config.lib;
  if (!Array.isArray(profiles) || !profiles.every(object)) return null;
  const federation = profiles.filter((profile) => (profile.format ?? config.format) === "mf");
  if (federation.length !== 1) return null;
  if (
    profiles.some((profile) => {
      const format = profile.format ?? config.format;
      return format !== undefined && typeof format !== "string";
    })
  )
    return null;
  const [profile] = federation;
  const { plugins = [] } = config;
  const { plugins: profilePlugins = [] } = profile;
  if (!Array.isArray(plugins) || !Array.isArray(profilePlugins)) return null;
  return {
    ...config,
    ...profile,
    plugins: [...plugins, ...profilePlugins],
    server: config.server,
    dev: mergeOptions(config.dev, profile.dev),
    output: mergeOutput(config.output, profile.output),
  };
}

export function rslibDtsExposes(exposes: Value): Value {
  if (!object(exposes) && !Array.isArray(exposes)) return exposes;
  // The SDK's DtsPlugin normally cleans requests before handing them to the DTS API.
  const paths = new Map<string, string | null>();
  let remainingWork = MAX_EXPOSE_REQUEST_WORK;
  const requestPath = (request: string): string | null | typeof UNKNOWN => {
    // Both the cache and the search can inspect the original string, including its tail.
    if (request.length > MAX_EXPOSE_REQUEST_LENGTH || (remainingWork -= request.length + 1) < 0)
      return UNKNOWN;
    const cached = paths.get(request);
    if (cached !== undefined) return cached;
    const query = request.indexOf("?");
    let source: string | null = request;
    if (query !== -1)
      source = request.startsWith("exclude-mf-dts", query + 1) ? null : request.slice(0, query);
    paths.set(request, source);
    return source;
  };
  const excludedImports = new WeakMap<Value[], boolean>();
  const cleaned: [string, Value][] = [];
  for (const [name, value] of Object.entries(exposes)) {
    if (typeof value === "string") {
      const source = requestPath(value);
      if (source === UNKNOWN) return UNKNOWN;
      if (source !== null) cleaned.push([name, source]);
      continue;
    }
    if (object(value) && Array.isArray(value.import)) {
      let excluded = excludedImports.get(value.import);
      if (excluded === undefined) {
        let overLimit = false;
        excluded = value.import.some((request) => {
          if (typeof request !== "string") return false;
          const source = requestPath(request);
          overLimit = source === UNKNOWN;
          return overLimit || source === null;
        });
        if (overLimit) return UNKNOWN;
        excludedImports.set(value.import, excluded);
      }
      if (excluded) continue;
    }
    cleaned.push([name, value]);
  }
  return Object.fromEntries(cleaned);
}

function mergeOutput(base: Value, profile: Value): Value {
  const output = mergeOptions(base, profile);
  if (object(output) && object(base) && object(profile))
    output.distPath = mergeOptions(
      distPathOptions(base.distPath),
      distPathOptions(profile.distPath),
    );
  return output;
}

function distPathOptions(value: Value): Value {
  return typeof value === "string" ? { root: value } : value;
}

function mergeOptions(base: Value, profile: Value): Value {
  return object(base) && object(profile)
    ? { ...base, ...profile }
    : profile === undefined
      ? base
      : profile;
}
