const PLUGIN_NAMES = new Set([
  "pluginModuleFederation",
  "ModuleFederationPlugin",
  "createModuleFederationConfig",
]);
export type Ast =
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "ident"; v: string }
  | { k: "env"; key: string }
  | { k: "obj"; props: { key: string; value: Ast }[] }
  | { k: "mem"; obj: Ast; prop: Ast }
  | { k: "tpl"; parts: Array<{ k: "text"; v: string } | { k: "exp"; v: Ast }> }
  | { k: "bin"; op: "??" | "||"; left: Ast; right: Ast }
  | { k: "call"; calleeName: string }
  | { k: "fn"; returned: Ast | null }
  | { k: "other" };

interface PropAst {
  key: string;
  value: Ast;
}

export interface Program {
  bindings: Map<string, Ast>;
  imports: Map<string, { from: string; exported: string }>;
  starFrom: string[];
  reexports: { local: string; exported: string; from?: string }[];
  pluginObject: Ast | null;
  pluginCallee: string | null;
  server: Ast | null;
  devServer: Ast | null;
}

interface Ctx extends Program {
  onReturn: ((ast: Ast) => void) | null;
}

type ObjAst = Extract<Ast, { k: "obj" }>;

export function objectAst(ast: Ast | undefined): ObjAst | null {
  if (ast?.k === "obj") return ast;
  if (ast?.k === "fn" && ast.returned?.k === "obj") return ast.returned;
  return null;
}

export function prop(obj: Ast, key: string): Ast | undefined {
  if (obj.k !== "obj") return undefined;
  return obj.props.find((item) => item.key === key)?.value;
}

class Cursor {
  i = 0;
  readonly s: string;

  constructor(source: string) {
    this.s = source;
  }

  get done(): boolean {
    return this.i >= this.s.length;
  }

  skipTrivia(): void {
    const s = this.s;
    while (this.i < s.length) {
      const ch = s[this.i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.i++;
        continue;
      }
      if (ch === "/" && s[this.i + 1] === "/") {
        this.i += 2;
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
        continue;
      }
      if (ch === "/" && s[this.i + 1] === "*") {
        this.i += 2;
        while (this.i < s.length && !(s[this.i] === "*" && s[this.i + 1] === "/")) this.i++;
        if (this.i < s.length) this.i += 2;
        continue;
      }
      break;
    }
  }

  peek(): string {
    this.skipTrivia();
    return this.s[this.i] ?? "";
  }

  eat(ch: string): boolean {
    if (this.peek() !== ch) return false;
    this.i++;
    return true;
  }

  startsWithIdent(word: string): boolean {
    this.skipTrivia();
    if (!this.s.startsWith(word, this.i)) return false;
    const after = this.s[this.i + word.length] ?? "";
    return !/[\w$]/.test(after);
  }

  ident(): string | null {
    this.skipTrivia();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i));
    if (!match) return null;
    this.i += match[0].length;
    return match[0];
  }
}

export function parseProgram(source: string): Program {
  const ctx: Ctx = {
    bindings: new Map(),
    imports: new Map(),
    starFrom: [],
    reexports: [],
    pluginObject: null,
    pluginCallee: null,
    server: null,
    devServer: null,
    onReturn: null,
  };
  const cursor = new Cursor(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  while (!cursor.done) {
    const before = cursor.i;
    if (cursor.peek() === "" || cursor.peek() === "}") break;
    parseStatement(cursor, ctx);
    if (cursor.i <= before) cursor.i = before + 1;
  }
  return ctx;
}

function parseStatement(c: Cursor, ctx: Ctx): void {
  if (c.startsWithIdent("import") && c.s[c.i + "import".length] !== "(") {
    parseImport(c, ctx);
    return;
  }
  if (c.startsWithIdent("export")) {
    parseExport(c, ctx);
    return;
  }
  if (c.startsWithIdent("const") || c.startsWithIdent("let") || c.startsWithIdent("var")) {
    parseDecl(c, ctx);
    return;
  }
  if (c.startsWithIdent("function")) {
    parseFunctionDecl(c, ctx);
    return;
  }
  if (c.startsWithIdent("return")) {
    c.ident();
    const value = parseExpression(c, ctx);
    c.eat(";");
    ctx.onReturn?.(value);
    return;
  }
  if (
    c.startsWithIdent("interface") ||
    c.startsWithIdent("type") ||
    c.startsWithIdent("enum") ||
    c.startsWithIdent("namespace") ||
    c.startsWithIdent("declare") ||
    c.startsWithIdent("class")
  ) {
    skipLoose(c);
    return;
  }
  if (c.eat(";")) return;
  parseExpression(c, ctx);
  c.eat(";");
}

function parseImport(c: Cursor, ctx: Ctx): void {
  c.ident();
  if (c.startsWithIdent("type")) c.ident();
  const named: { local: string; exported: string }[] = [];
  let defaultLocal: string | null = null;
  if (c.eat("*")) {
    if (c.startsWithIdent("as")) c.ident();
    const local = c.ident();
    if (c.startsWithIdent("from")) c.ident();
    const spec = c.peek() === "'" || c.peek() === '"' ? parseString(c) : "";
    if (local) ctx.imports.set(local, { from: spec, exported: "*" });
    c.eat(";");
    return;
  }
  if (c.peek() === "'" || c.peek() === '"') {
    parseString(c);
    c.eat(";");
    return;
  }
  if (c.peek() !== "{") {
    defaultLocal = c.ident();
    c.eat(",");
  }
  if (c.eat("{")) {
    while (!c.done && c.peek() !== "}") {
      if (c.startsWithIdent("type")) c.ident();
      const first = c.ident();
      if (!first) {
        c.i++;
        continue;
      }
      let local = first;
      if (c.startsWithIdent("as")) {
        c.ident();
        local = c.ident() ?? first;
      }
      named.push({ local, exported: first });
      c.eat(",");
    }
    c.eat("}");
  }
  if (c.startsWithIdent("from")) c.ident();
  const spec = c.peek() === "'" || c.peek() === '"' ? parseString(c) : "";
  if (defaultLocal) ctx.imports.set(defaultLocal, { from: spec, exported: "default" });
  for (const item of named) ctx.imports.set(item.local, { from: spec, exported: item.exported });
  c.eat(";");
}

function parseExport(c: Cursor, ctx: Ctx): void {
  c.ident();
  if (c.startsWithIdent("type")) {
    c.ident();
    if (c.peek() === "{") {
      skipBalanced(c, "{", "}");
      if (c.startsWithIdent("from")) {
        c.ident();
        if (c.peek() === "'" || c.peek() === '"') parseString(c);
      }
      c.eat(";");
      return;
    }
    skipLoose(c);
    return;
  }
  if (c.startsWithIdent("default")) {
    c.ident();
    ctx.bindings.set("default", parseExpression(c, ctx));
    c.eat(";");
    return;
  }
  if (c.eat("*")) {
    const namespaced = c.startsWithIdent("as");
    if (namespaced) {
      c.ident();
      c.ident();
    }
    if (c.startsWithIdent("from")) c.ident();
    const spec = c.peek() === "'" || c.peek() === '"' ? parseString(c) : "";
    if (!namespaced && spec) ctx.starFrom.push(spec);
    c.eat(";");
    return;
  }
  if (c.eat("{")) {
    const names: { local: string; exported: string }[] = [];
    while (!c.done && c.peek() !== "}") {
      if (c.startsWithIdent("type")) c.ident();
      const first = c.ident();
      if (!first) {
        c.i++;
        continue;
      }
      let exported = first;
      if (c.startsWithIdent("as")) {
        c.ident();
        exported = c.ident() ?? first;
      }
      names.push({ local: first, exported });
      c.eat(",");
    }
    c.eat("}");
    let from: string | undefined;
    if (c.startsWithIdent("from")) {
      c.ident();
      if (c.peek() === "'" || c.peek() === '"') from = parseString(c);
    }
    for (const item of names) ctx.reexports.push({ ...item, from });
    c.eat(";");
    return;
  }
  if (c.startsWithIdent("const") || c.startsWithIdent("let") || c.startsWithIdent("var")) {
    parseDecl(c, ctx);
    return;
  }
  if (c.startsWithIdent("function")) {
    parseFunctionDecl(c, ctx);
    return;
  }
  skipLoose(c);
}

function parseDecl(c: Cursor, ctx: Ctx): void {
  c.ident();
  if (c.peek() === "{") {
    skipBalanced(c, "{", "}");
    if (c.eat(":")) skipType(c);
    if (c.eat("=")) parseExpression(c, ctx);
    c.eat(";");
    return;
  }
  if (c.peek() === "[") {
    skipBalanced(c, "[", "]");
    if (c.eat(":")) skipType(c);
    if (c.eat("=")) parseExpression(c, ctx);
    c.eat(";");
    return;
  }
  const name = c.ident();
  if (!name) return;
  if (c.eat(":")) skipType(c);
  if (c.eat("=")) ctx.bindings.set(name, parseExpression(c, ctx));
  c.eat(";");
}

function parseFunctionDecl(c: Cursor, ctx: Ctx): void {
  c.ident();
  if (c.peek() === "*") c.i++;
  const name = c.ident();
  if (c.peek() === "<") skipAngles(c);
  if (c.peek() === "(") skipBalanced(c, "(", ")");
  if (c.eat(":")) skipType(c);
  const returned = c.peek() === "{" ? parseBlock(c, ctx) : null;
  if (name) ctx.bindings.set(name, { k: "fn", returned });
}

function parseBlock(c: Cursor, ctx: Ctx): Ast | null {
  let returned: Ast | null = null;
  const previous = ctx.onReturn;
  ctx.onReturn = (ast) => {
    returned = ast;
  };
  c.eat("{");
  while (!c.done && c.peek() !== "}") {
    const before = c.i;
    parseStatement(c, ctx);
    if (c.i <= before) c.i = before + 1;
  }
  c.eat("}");
  ctx.onReturn = previous;
  return returned;
}

function parseExpression(c: Cursor, ctx: Ctx): Ast {
  const expr = parseTernary(c, ctx);
  if (c.startsWithIdent("as") || c.startsWithIdent("satisfies")) {
    c.ident();
    skipType(c);
  }
  return expr;
}

function parseTernary(c: Cursor, ctx: Ctx): Ast {
  const test = parseNullish(c, ctx);
  if (c.peek() === "?" && c.s[c.i + 1] !== "." && c.s[c.i + 1] !== "?") {
    c.i++;
    parseTernary(c, ctx);
    if (!c.eat(":")) return test;
    parseTernary(c, ctx);
    return { k: "other" };
  }
  return test;
}

function parseNullish(c: Cursor, ctx: Ctx): Ast {
  let left = parseOr(c, ctx);
  while (true) {
    c.skipTrivia();
    if (!c.s.startsWith("??", c.i)) break;
    c.i += 2;
    left = { k: "bin", op: "??", left, right: parseOr(c, ctx) };
  }
  return left;
}

function parseOr(c: Cursor, ctx: Ctx): Ast {
  let left = parseAnd(c, ctx);
  while (true) {
    c.skipTrivia();
    if (!(c.s.startsWith("||", c.i) && c.s[c.i + 2] !== "|")) break;
    c.i += 2;
    left = { k: "bin", op: "||", left, right: parseAnd(c, ctx) };
  }
  return left;
}

function parseAnd(c: Cursor, ctx: Ctx): Ast {
  const left = parseUnary(c, ctx);
  while (true) {
    c.skipTrivia();
    if (!c.s.startsWith("&&", c.i)) break;
    c.i += 2;
    parseUnary(c, ctx);
  }
  return left;
}

function parseUnary(c: Cursor, ctx: Ctx): Ast {
  if (c.eat("!")) {
    parseUnary(c, ctx);
    return { k: "other" };
  }
  if (c.startsWithIdent("void") || c.startsWithIdent("typeof") || c.startsWithIdent("await")) {
    c.ident();
    parseUnary(c, ctx);
    return { k: "other" };
  }
  if (c.startsWithIdent("new")) {
    c.ident();
    const name = c.ident();
    if (name && c.peek() === "(") return parseCall(c, ctx, name);
    return { k: "other" };
  }
  return parsePrimary(c, ctx);
}

function parsePrimary(c: Cursor, ctx: Ctx): Ast {
  if (c.peek() === "/" && c.s[c.i + 1] !== "/" && c.s[c.i + 1] !== "*" && canStartRegex(c)) {
    skipRegex(c);
    return { k: "other" };
  }
  if (c.peek() === "'" || c.peek() === '"') return { k: "str", v: parseString(c) };
  if (c.peek() === "`") return parseTemplate(c, ctx);
  if (c.peek() === "{") return parseObject(c, ctx);
  if (c.peek() === "[") return parseArray(c, ctx);
  if (c.peek() === "(") return parseParenOrArrow(c, ctx);
  if (/\d/.test(c.peek())) return { k: "num", v: parseNumber(c) };
  const name = c.ident();
  if (!name) {
    if (!c.done) c.i++;
    return { k: "other" };
  }
  if (name === "true") return parsePostfix(c, ctx, { k: "bool", v: true });
  if (name === "false") return parsePostfix(c, ctx, { k: "bool", v: false });
  if (name === "null") return parsePostfix(c, ctx, { k: "null" });
  if (name === "import") return parseImportMeta(c, ctx);
  if (eatArrow(c)) return { k: "fn", returned: parseArrowBody(c, ctx) };
  return parsePostfix(c, ctx, { k: "ident", v: name });
}

function parseImportMeta(c: Cursor, ctx: Ctx): Ast {
  if (!c.eat(".")) return { k: "other" };
  const meta = c.ident();
  if (meta !== "meta" || !c.eat(".")) return { k: "other" };
  const field = c.ident();
  if (field !== "env") return { k: "other" };
  if (c.eat(".")) {
    const key = c.ident();
    if (!key) return { k: "other" };
    return parsePostfix(c, ctx, { k: "env", key });
  }
  if (c.eat("[")) {
    const key = parseExpression(c, ctx);
    c.eat("]");
    if (key.k === "str") return { k: "env", key: key.v };
  }
  return { k: "other" };
}

function parsePostfix(c: Cursor, ctx: Ctx, ast: Ast): Ast {
  while (true) {
    if (c.peek() === "(") {
      ast = ast.k === "ident" ? parseCall(c, ctx, ast.v) : parseCall(c, ctx, "");
      continue;
    }
    if (c.peek() === "." && c.s[c.i + 1] !== ".") {
      c.i++;
      const name = c.ident();
      if (!name) break;
      ast = { k: "mem", obj: ast, prop: { k: "str", v: name } };
      continue;
    }
    c.skipTrivia();
    if (c.s.startsWith("?.", c.i)) {
      c.i += 2;
      if (c.eat("[")) {
        const key = parseExpression(c, ctx);
        c.eat("]");
        ast = { k: "mem", obj: ast, prop: key.k === "str" ? key : { k: "str", v: "" } };
        continue;
      }
      const name = c.ident();
      ast = { k: "mem", obj: ast, prop: { k: "str", v: name ?? "" } };
      continue;
    }
    if (c.eat("[")) {
      const key = parseExpression(c, ctx);
      c.eat("]");
      ast = { k: "mem", obj: ast, prop: key };
      continue;
    }
    break;
  }
  return ast;
}

function parseCall(c: Cursor, ctx: Ctx, calleeName: string): Ast {
  c.eat("(");
  const args: Ast[] = [];
  if (c.peek() !== ")" && !c.done) {
    args.push(parseExpression(c, ctx));
    while (c.eat(",")) {
      if (c.peek() === ")" || c.done) break;
      args.push(parseExpression(c, ctx));
    }
  }
  c.eat(")");
  rememberPlugin(ctx, calleeName, args[0]);
  return { k: "call", calleeName };
}

function rememberPlugin(ctx: Ctx, calleeName: string, arg: Ast | undefined): void {
  if (!PLUGIN_NAMES.has(calleeName) || !arg || ctx.pluginObject || ctx.pluginCallee) return;
  if (arg.k === "obj") ctx.pluginObject = arg;
  else if (arg.k === "call" && arg.calleeName) ctx.pluginCallee = arg.calleeName;
  else if (arg.k === "ident") ctx.pluginCallee = arg.v;
}

function parseObject(c: Cursor, ctx: Ctx): Ast {
  c.eat("{");
  const props: PropAst[] = [];
  while (!c.done && c.peek() !== "}") {
    const before = c.i;
    if (c.s.startsWith("...", c.i)) {
      c.i += 3;
      parseExpression(c, ctx);
      c.eat(",");
      continue;
    }
    let key: string;
    let value: Ast | null = null;
    if (c.peek() === "[") {
      c.eat("[");
      const computed = parseExpression(c, ctx);
      c.eat("]");
      key = computed.k === "str" ? computed.v : "";
      if (c.eat(":")) value = parseExpression(c, ctx);
    } else if (c.peek() === "'" || c.peek() === '"') {
      key = parseString(c);
      if (c.eat(":")) value = parseExpression(c, ctx);
    } else {
      const name = c.ident();
      if (!name) {
        c.i++;
        continue;
      }
      if (c.peek() === "(" || c.peek() === "<") {
        if (c.peek() === "<") skipAngles(c);
        parseCall(c, ctx, name);
        if (c.peek() === "{") skipBalanced(c, "{", "}");
        c.eat(",");
        continue;
      }
      key = name;
      value = c.eat(":") ? parseExpression(c, ctx) : { k: "ident", v: name };
    }
    if (key && value) {
      props.push({ key, value });
      if ((key === "server" || key === "devServer") && value.k === "obj" && prop(value, "port")) {
        if (key === "server" && !ctx.server) ctx.server = value;
        if (key === "devServer" && !ctx.devServer) ctx.devServer = value;
      }
    }
    c.eat(",");
    if (c.i <= before) c.i = before + 1;
  }
  c.eat("}");
  return { k: "obj", props };
}

function parseArray(c: Cursor, ctx: Ctx): Ast {
  c.eat("[");
  while (!c.done && c.peek() !== "]") {
    if (c.eat(",")) continue;
    parseExpression(c, ctx);
    c.eat(",");
  }
  c.eat("]");
  return { k: "other" };
}

function parseParenOrArrow(c: Cursor, ctx: Ctx): Ast {
  c.eat("(");
  if (c.peek() === ")") {
    c.i++;
    if (c.eat(":")) skipType(c);
    if (eatArrow(c)) return { k: "fn", returned: parseArrowBody(c, ctx) };
    return { k: "other" };
  }
  const inner = parseExpression(c, ctx);
  if (c.eat(":")) skipType(c);
  while (c.eat(",")) {
    if (c.peek() === ")") break;
    if (c.peek() === "{") skipBalanced(c, "{", "}");
    else if (c.peek() === "[") skipBalanced(c, "[", "]");
    else c.ident();
    if (c.peek() === "?") c.i++;
    if (c.eat(":")) skipType(c);
    if (c.eat("=")) parseExpression(c, ctx);
  }
  if (!c.eat(")")) return inner;
  if (c.eat(":")) skipType(c);
  if (eatArrow(c)) return { k: "fn", returned: parseArrowBody(c, ctx) };
  return inner;
}

function parseArrowBody(c: Cursor, ctx: Ctx): Ast | null {
  if (c.peek() === "{") return parseBlock(c, ctx);
  return parseExpression(c, ctx);
}

function eatArrow(c: Cursor): boolean {
  c.skipTrivia();
  if (!c.s.startsWith("=>", c.i)) return false;
  c.i += 2;
  return true;
}

function parseTemplate(c: Cursor, ctx: Ctx): Ast {
  c.i++;
  const parts: Array<{ k: "text"; v: string } | { k: "exp"; v: Ast }> = [];
  let text = "";
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\\") {
      text += c.s[c.i + 1] ?? "";
      c.i += 2;
      continue;
    }
    if (ch === "`") {
      c.i++;
      parts.push({ k: "text", v: text });
      return { k: "tpl", parts };
    }
    if (ch === "$" && c.s[c.i + 1] === "{") {
      parts.push({ k: "text", v: text });
      text = "";
      c.i += 2;
      parts.push({ k: "exp", v: parseExpression(c, ctx) });
      if (c.s[c.i] === "}") c.i++;
      continue;
    }
    text += ch;
    c.i++;
  }
  parts.push({ k: "text", v: text });
  return { k: "tpl", parts };
}

function parseString(c: Cursor): string {
  const quote = c.s[c.i];
  if (quote !== "'" && quote !== '"') return "";
  c.i++;
  let out = "";
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\\") {
      const next = c.s[c.i + 1] ?? "";
      const escaped: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        "\\": "\\",
        "'": "'",
        '"': '"',
        "`": "`",
      };
      out += escaped[next] ?? next;
      c.i += 2;
      continue;
    }
    if (ch === quote) {
      c.i++;
      return out;
    }
    out += ch;
    c.i++;
  }
  return out;
}

function parseNumber(c: Cursor): number {
  const match = /^(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?)/.exec(c.s.slice(c.i));
  if (!match) return Number.NaN;
  c.i += match[0].length;
  return Number(match[0].replaceAll("_", ""));
}

function canStartRegex(c: Cursor): boolean {
  let j = c.i - 1;
  while (j >= 0 && /\s/.test(c.s[j])) j--;
  if (j < 0) return true;
  const ch = c.s[j];
  if ("([{=,:;!?&|+-*%^~<>".includes(ch)) return true;
  if (!/[\w$]/.test(ch)) return false;
  let k = j;
  while (k >= 0 && /[\w$]/.test(c.s[k])) k--;
  const word = c.s.slice(k + 1, j + 1);
  return [
    "return",
    "typeof",
    "case",
    "throw",
    "void",
    "delete",
    "in",
    "of",
    "await",
    "yield",
    "do",
    "else",
    "new",
  ].includes(word);
}

function skipRegex(c: Cursor): void {
  c.i++;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\\") {
      c.i += 2;
      continue;
    }
    if (ch === "[") {
      c.i++;
      if (c.s[c.i] === "^") c.i++;
      while (c.i < c.s.length && c.s[c.i] !== "]" && c.s[c.i] !== "\n") {
        if (c.s[c.i] === "\\") c.i += 2;
        else c.i++;
      }
      if (c.s[c.i] === "]") c.i++;
      continue;
    }
    if (ch === "/" || ch === "\n") {
      if (ch === "/") c.i++;
      break;
    }
    c.i++;
  }
  while (/[a-z]/i.test(c.s[c.i] ?? "")) c.i++;
}

function skipType(c: Cursor): void {
  skipTypePrimary(c);
  while (true) {
    c.skipTrivia();
    if (c.s.startsWith("=>", c.i)) return;
    if (c.peek() !== "|" && c.peek() !== "&") return;
    c.i++;
    skipTypePrimary(c);
  }
}

function skipTypePrimary(c: Cursor): void {
  c.skipTrivia();
  if (c.s.startsWith("=>", c.i)) return;
  if (
    c.startsWithIdent("keyof") ||
    c.startsWithIdent("readonly") ||
    c.startsWithIdent("unique") ||
    c.startsWithIdent("infer")
  ) {
    c.ident();
    skipTypePrimary(c);
    return;
  }
  if (c.startsWithIdent("typeof")) {
    c.ident();
    if (c.startsWithIdent("import")) {
      c.ident();
      if (c.peek() === "(") skipBalanced(c, "(", ")");
    } else {
      c.ident();
      while (c.eat(".")) c.ident();
    }
    return;
  }
  if (c.peek() === "(") {
    skipBalanced(c, "(", ")");
    c.skipTrivia();
    if (c.s.startsWith("=>", c.i)) {
      c.i += 2;
      skipType(c);
    }
    return;
  }
  if (c.peek() === "{") {
    skipBalanced(c, "{", "}");
    while (c.peek() === "[") {
      c.eat("[");
      c.eat("]");
    }
    return;
  }
  if (c.peek() === "'" || c.peek() === '"') {
    parseString(c);
    return;
  }
  if (c.peek() === "`") {
    skipTemplate(c);
    return;
  }
  if (/[A-Za-z_$]/.test(c.peek())) {
    c.ident();
    while (c.eat(".")) c.ident();
    if (c.peek() === "<") skipAngles(c);
    while (c.peek() === "[") {
      c.eat("[");
      c.eat("]");
    }
  }
}

function skipAngles(c: Cursor): void {
  if (c.peek() !== "<") return;
  c.i++;
  let depth = 1;
  while (!c.done && depth > 0) {
    c.skipTrivia();
    if (c.s.startsWith("=>", c.i)) {
      c.i += 2;
      continue;
    }
    const ch = c.s[c.i];
    if (ch === "<") {
      depth++;
      c.i++;
      continue;
    }
    if (ch === ">") {
      depth--;
      c.i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      parseString(c);
      continue;
    }
    if (ch === "`") {
      skipTemplate(c);
      continue;
    }
    if (ch === "{") {
      skipBalanced(c, "{", "}");
      continue;
    }
    if (ch === "(") {
      skipBalanced(c, "(", ")");
      continue;
    }
    if (ch === "[") {
      skipBalanced(c, "[", "]");
      continue;
    }
    c.i++;
  }
}

function skipBalanced(c: Cursor, open: string, close: string): void {
  if (c.peek() !== open) return;
  c.i++;
  let depth = 1;
  while (!c.done && depth > 0) {
    const ch = c.s[c.i];
    if (ch === "'" || ch === '"') {
      parseString(c);
      continue;
    }
    if (ch === "`") {
      skipTemplate(c);
      continue;
    }
    if (ch === "/" && c.s[c.i + 1] === "/") {
      c.i += 2;
      while (c.i < c.s.length && c.s[c.i] !== "\n") c.i++;
      continue;
    }
    if (ch === "/" && c.s[c.i + 1] === "*") {
      c.i += 2;
      while (c.i < c.s.length && !(c.s[c.i] === "*" && c.s[c.i + 1] === "/")) c.i++;
      c.i += 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    c.i++;
  }
}

function skipTemplate(c: Cursor): void {
  if (c.s[c.i] !== "`") return;
  c.i++;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\\") {
      c.i += 2;
      continue;
    }
    if (ch === "`") {
      c.i++;
      return;
    }
    if (ch === "$" && c.s[c.i + 1] === "{") {
      c.i += 2;
      let depth = 1;
      while (c.i < c.s.length && depth > 0) {
        const inner = c.s[c.i];
        if (inner === "'" || inner === '"') {
          parseString(c);
          continue;
        }
        if (inner === "`") {
          skipTemplate(c);
          continue;
        }
        if (inner === "{") depth++;
        else if (inner === "}") depth--;
        if (depth > 0) c.i++;
      }
      if (c.s[c.i] === "}") c.i++;
      continue;
    }
    c.i++;
  }
}

function skipLoose(c: Cursor): void {
  let depth = 0;
  while (!c.done) {
    c.skipTrivia();
    const ch = c.peek();
    if ((ch === ";" || ch === "}") && depth === 0) {
      if (ch === ";") c.i++;
      return;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      c.i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      c.i++;
      if (depth === 0 && ch === "}") return;
      continue;
    }
    if (ch === "'" || ch === '"') {
      parseString(c);
      continue;
    }
    if (ch === "`") {
      skipTemplate(c);
      continue;
    }
    c.i++;
  }
}
