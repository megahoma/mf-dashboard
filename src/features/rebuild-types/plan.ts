export interface ChainNode {
  name: string;
  dependencies: string[];
  zipMtime: number | null;
  sourceSavedAt: number | null;
  zipReachable: boolean;
  sourceFreshness: "fresh" | "stale" | "unknown";
  zipHash?: string | null;
  builtDependencyHashes?: Record<string, string>;
}

export interface PlannedStep {
  name: string;
  action: "rebuild" | "skip";
}

export function chainDependencies(
  remotes: readonly { name: string }[],
  local: ReadonlyMap<string, { generateTypes: boolean }>,
): string[] {
  const names: string[] = [];
  for (const remote of remotes) {
    const app = local.get(remote.name);
    if (!app?.generateTypes || names.includes(remote.name)) continue;
    names.push(remote.name);
  }
  names.sort(byName);
  return names;
}

// The reachable graph is checked before any step is returned, so a cycle never starts a process.
export function rebuildPlan(root: string, nodes: ChainNode[]): PlannedStep[] {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  assertAcyclic(root, byName);
  const order = postOrder(root, byName);
  const actions = new Map<string, PlannedStep["action"]>();
  for (const name of order) {
    const node = byName.get(name);
    if (!node) throw new Error(`missing local node: ${name}`);
    actions.set(name, canSkip(node, byName, actions) ? "skip" : "rebuild");
  }
  return order.map((name) => ({ name, action: actions.get(name) ?? "rebuild" }));
}

function assertAcyclic(root: string, byName: ReadonlyMap<string, ChainNode>): void {
  const color = new Map<string, "gray" | "black">();
  const stack: string[] = [];
  const visit = (name: string) => {
    const node = byName.get(name);
    if (!node) throw new Error(`missing local node: ${name}`);
    const state = color.get(name);
    if (state === "gray") {
      const start = stack.indexOf(name);
      throw new Error(`cycle: ${[...stack.slice(start), name].join(" -> ")}`);
    }
    if (state === "black") return;
    color.set(name, "gray");
    stack.push(name);
    for (const dep of sortedDeps(node)) visit(dep);
    stack.pop();
    color.set(name, "black");
  };
  visit(root);
}

function postOrder(root: string, byName: ReadonlyMap<string, ChainNode>): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const node = byName.get(name);
    if (!node) throw new Error(`missing local node: ${name}`);
    for (const dep of sortedDeps(node)) walk(dep);
    order.push(name);
  };
  walk(root);
  return order;
}

function canSkip(
  node: ChainNode,
  byName: ReadonlyMap<string, ChainNode>,
  actions: ReadonlyMap<string, PlannedStep["action"]>,
): boolean {
  if (!node.zipReachable || node.sourceFreshness !== "fresh") return false;
  for (const depName of node.dependencies) {
    if (actions.get(depName) !== "skip") return false;
    const dep = byName.get(depName);
    if (!dep || !dependencyUnchanged(node, dep)) return false;
  }
  return true;
}

function dependencyUnchanged(node: ChainNode, dep: ChainNode): boolean {
  const hashes = node.builtDependencyHashes;
  if (hashes && dep.zipHash && Object.prototype.hasOwnProperty.call(hashes, dep.name)) {
    return hashes[dep.name] === dep.zipHash;
  }
  if (node.zipMtime == null || dep.zipMtime == null) return false;
  return dep.zipMtime <= node.zipMtime;
}

function sortedDeps(node: ChainNode): string[] {
  return [...node.dependencies].sort(byName);
}

function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
