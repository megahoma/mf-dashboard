export type SourceProblem = {
  file: string;
  line: number;
  column: number;
  message: string;
  code?: string;
};

export class LocatedError extends Error {
  readonly problems: readonly SourceProblem[];
  constructor(message: string, problems: readonly SourceProblem[], options?: ErrorOptions) {
    super(message, options);
    this.problems = problems;
  }
}
