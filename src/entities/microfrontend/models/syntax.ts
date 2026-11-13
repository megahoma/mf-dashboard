import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

export type AstPath = NodePath<t.Node>;

export type Program = {
  file: string;
  root: NodePath<t.Program>;
  calls: AstPath[];
  exports: Map<string, AstPath | { from: string; imported: string }>;
  stars: string[];
  default: AstPath | null;
  commonJs: boolean;
};
