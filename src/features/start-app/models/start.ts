export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export type StartInvocation = {
  command: PackageManagerName;
  args: ["run", string];
  cwd: string;
};
