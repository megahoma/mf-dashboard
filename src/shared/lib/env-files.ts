export function modeEnvFiles(mode: string): readonly [string, string] {
  return [`.env.${mode}`, `.env.${mode}.local`];
}
