export interface ManifestShared {
  name: string;
  version: string | null;
  singleton: boolean;
}

export interface ManifestModules {
  exposes: string[];
  shared: ManifestShared[];
}

export interface ManifestLineTerms {
  exposes: string;
  shared: string;
  singleton: string;
}

const LIST_CAP = 8;

export function readManifestModules(json: unknown): ManifestModules {
  if (!isRecord(json)) return { exposes: [], shared: [] };
  return { exposes: readExposes(json.exposes), shared: readShared(json.shared) };
}

export function manifestTooltipLines(
  modules: ManifestModules,
  vocabulary: ManifestLineTerms,
): string[] {
  const lines: string[] = [];
  if (modules.exposes.length > 0) lines.push(capped(vocabulary.exposes, modules.exposes));
  if (modules.shared.length > 0) {
    lines.push(
      capped(
        vocabulary.shared,
        modules.shared.map((item) => sharedLabel(item, vocabulary.singleton)),
      ),
    );
  }
  return lines;
}

function readExposes(value: unknown): string[] {
  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const item of value) {
      if (!isRecord(item)) continue;
      const label = text(item.path) ?? text(item.name);
      if (label) names.push(label);
    }
    return names;
  }
  if (isRecord(value)) return Object.keys(value).filter((key) => key !== "");
  return [];
}

function readShared(value: unknown): ManifestShared[] {
  if (Array.isArray(value)) {
    const items: ManifestShared[] = [];
    for (const item of value) {
      if (!isRecord(item)) continue;
      const name = text(item.name);
      if (!name) continue;
      items.push({ name, version: text(item.version), singleton: item.singleton === true });
    }
    return items;
  }
  if (!isRecord(value)) return [];
  const items: ManifestShared[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (key === "") continue;
    const record = isRecord(item) ? item : null;
    items.push({
      name: key,
      version: record ? text(record.version) : null,
      singleton: record?.singleton === true,
    });
  }
  return items;
}

function sharedLabel(item: ManifestShared, singletonWord: string): string {
  const version = item.version ? `@${item.version}` : "";
  const singleton = item.singleton ? ` ${singletonWord}` : "";
  return `${item.name}${version}${singleton}`;
}

function capped(label: string, items: readonly string[]): string {
  if (items.length <= LIST_CAP) return `${label}: ${items.join(", ")}`;
  return `${label}: ${items.length} · ${items.slice(0, LIST_CAP).join(", ")}, …`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
