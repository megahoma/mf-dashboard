declare module "proper-lockfile" {
  export function lock(
    file: string,
    options: {
      realpath: boolean;
      lockfilePath: string;
      stale: number;
      update: number;
      retries: { retries: number; minTimeout: number; maxTimeout: number };
      onCompromised: (error: Error) => void;
    },
  ): Promise<() => Promise<void>>;
}
