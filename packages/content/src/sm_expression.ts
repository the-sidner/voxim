/**
 * Character State Machine condition DSL.
 *
 * Tiny expression language for transition `when` clauses. Compiled once at
 * content load via `parseSMExpr`; evaluated against an `SMScope` per tick.
 *
 * # Grammar
 *
 *   expr   := orExpr
 *   orExpr := andExpr ('||' andExpr)*
 *   andExpr:= notExpr ('&&' notExpr)*
 *   notExpr:= '!' notExpr | cmpExpr
 *   cmpExpr:= addExpr (('<'|'>'|'<='|'>='|'=='|'!=') addExpr)?
 *   addExpr:= mulExpr (('+'|'-') mulExpr)*
 *   mulExpr:= factor (('*'|'/') factor)*
 *   factor := number | dottedIdent | bareIdent | '(' expr ')' | '-' factor
 *
 * # Identifier rules
 *
 *   - **Dotted** identifiers (`vel.mag`, `csm.posture`, `state.elapsed`,
 *     `event.hit.from_front`) are variable lookups against the scope.
 *   - **Bare** identifiers without a dot are literals:
 *       `true` / `false` → boolean literals
 *       anything else    → string literal (used for enum-style comparisons,
 *                          e.g. `csm.posture == crouched`)
 *
 * This rule is what makes `csm.posture == crouched` legal without quotes:
 * the LHS is dotted (variable), the RHS is bare (string literal "crouched").
 *
 * # Type rules
 *
 *   - Comparisons (`==`, `!=`) accept any (number|string|boolean) and compare
 *     by JS strict equality.
 *   - Numeric comparisons (`<`, `>`, `<=`, `>=`) and arithmetic (`+ - * /`)
 *     coerce both sides to numbers; non-numeric values throw.
 *   - Logical (`&&`, `||`, `!`) coerces using JS truthiness: numbers (0
 *     false, else true), strings ("" false, else true), booleans verbatim.
 *
 * No randomness, no IO, no loops, no recursion. Pure pointwise evaluation.
 */

// ---- AST ------------------------------------------------------------------

export type SMExprNode =
  | { kind: "num"; v: number }
  | { kind: "bool"; v: boolean }
  | { kind: "str"; v: string }
  | { kind: "var"; name: string }
  | { kind: "neg"; child: SMExprNode }
  | { kind: "not"; child: SMExprNode }
  | { kind: "binop"; op: "+" | "-" | "*" | "/"; l: SMExprNode; r: SMExprNode }
  | { kind: "cmp"; op: "<" | ">" | "<=" | ">=" | "==" | "!="; l: SMExprNode; r: SMExprNode }
  | { kind: "logic"; op: "&&" | "||"; l: SMExprNode; r: SMExprNode };

export interface ParsedSMExpr {
  source: string;
  ast:    SMExprNode;
  /** Set of dotted identifiers referenced by the expression. */
  vars:   ReadonlySet<string>;
}

export type SMScopeValue = number | string | boolean;
export type SMScope = Readonly<Record<string, SMScopeValue>>;

// ---- tokenizer ------------------------------------------------------------

type Token =
  | { kind: "num"; v: number }
  | { kind: "ident"; name: string; dotted: boolean }
  | { kind: "punct"; c: "+" | "-" | "*" | "/" | "(" | ")" | "<" | ">" | "<=" | ">=" | "==" | "!=" | "&&" | "||" | "!" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    // Two-char punct: <= >= == != && ||
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "==" || two === "!=" || two === "&&" || two === "||") {
      tokens.push({ kind: "punct", c: two });
      i += 2;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "(" || c === ")" || c === "<" || c === ">" || c === "!") {
      tokens.push({ kind: "punct", c });
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      if (j < src.length && src[j] === ".") {
        j++;
        while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      }
      tokens.push({ kind: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i + 1;
      let dotted = false;
      while (j < src.length) {
        const ch = src[j];
        if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_") {
          j++;
        } else if (ch === ".") {
          // Only consume the dot if followed by an ident-start char.
          const next = src[j + 1];
          if (next && ((next >= "a" && next <= "z") || (next >= "A" && next <= "Z") || next === "_")) {
            j++;
            dotted = true;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      tokens.push({ kind: "ident", name: src.slice(i, j), dotted });
      i = j;
      continue;
    }
    throw new Error(`sm_expression: unexpected character '${c}' at position ${i} of '${src}'`);
  }
  return tokens;
}

// ---- parser ---------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly src: string) {}

  parse(): SMExprNode {
    const node = this.orExpr();
    if (this.pos !== this.tokens.length) {
      throw new Error(`sm_expression '${this.src}': unexpected token at position ${this.pos}`);
    }
    return node;
  }

  private orExpr(): SMExprNode {
    let left = this.andExpr();
    while (this.peekPunct("||")) {
      this.pos++;
      const right = this.andExpr();
      left = { kind: "logic", op: "||", l: left, r: right };
    }
    return left;
  }

  private andExpr(): SMExprNode {
    let left = this.notExpr();
    while (this.peekPunct("&&")) {
      this.pos++;
      const right = this.notExpr();
      left = { kind: "logic", op: "&&", l: left, r: right };
    }
    return left;
  }

  private notExpr(): SMExprNode {
    if (this.peekPunct("!") && !this.peekPunct("!=")) {
      this.pos++;
      return { kind: "not", child: this.notExpr() };
    }
    return this.cmpExpr();
  }

  private cmpExpr(): SMExprNode {
    const left = this.addExpr();
    const tok = this.tokens[this.pos];
    if (tok && tok.kind === "punct") {
      const op = tok.c;
      if (op === "<" || op === ">" || op === "<=" || op === ">=" || op === "==" || op === "!=") {
        this.pos++;
        const right = this.addExpr();
        return { kind: "cmp", op, l: left, r: right };
      }
    }
    return left;
  }

  private addExpr(): SMExprNode {
    let left = this.mulExpr();
    while (this.peekPunct("+") || this.peekPunct("-")) {
      const op = (this.tokens[this.pos] as { c: "+" | "-" }).c;
      this.pos++;
      const right = this.mulExpr();
      left = { kind: "binop", op, l: left, r: right };
    }
    return left;
  }

  private mulExpr(): SMExprNode {
    let left = this.factor();
    while (this.peekPunct("*") || this.peekPunct("/")) {
      const op = (this.tokens[this.pos] as { c: "*" | "/" }).c;
      this.pos++;
      const right = this.factor();
      left = { kind: "binop", op, l: left, r: right };
    }
    return left;
  }

  private factor(): SMExprNode {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error(`sm_expression '${this.src}': unexpected end of input`);

    if (tok.kind === "punct" && tok.c === "-") {
      this.pos++;
      return { kind: "neg", child: this.factor() };
    }
    if (tok.kind === "num") {
      this.pos++;
      return { kind: "num", v: tok.v };
    }
    if (tok.kind === "punct" && tok.c === "(") {
      this.pos++;
      const inner = this.orExpr();
      this.expectPunct(")");
      return inner;
    }
    if (tok.kind === "ident") {
      this.pos++;
      if (tok.dotted) {
        return { kind: "var", name: tok.name };
      }
      // Bare identifier: bool literal or string literal.
      if (tok.name === "true") return { kind: "bool", v: true };
      if (tok.name === "false") return { kind: "bool", v: false };
      return { kind: "str", v: tok.name };
    }
    throw new Error(`sm_expression '${this.src}': unexpected token at position ${this.pos}`);
  }

  private peekPunct(c: string): boolean {
    const t = this.tokens[this.pos];
    return !!t && t.kind === "punct" && t.c === c;
  }

  private expectPunct(c: ")"): void {
    const t = this.tokens[this.pos];
    if (!t || t.kind !== "punct" || t.c !== c) {
      throw new Error(`sm_expression '${this.src}': expected '${c}'`);
    }
    this.pos++;
  }
}

function collectVars(ast: SMExprNode, out: Set<string>): void {
  switch (ast.kind) {
    case "num":
    case "bool":
    case "str":
      return;
    case "var":
      out.add(ast.name);
      return;
    case "neg":
    case "not":
      collectVars(ast.child, out);
      return;
    case "binop":
    case "cmp":
    case "logic":
      collectVars(ast.l, out);
      collectVars(ast.r, out);
      return;
  }
}

// ---- public API -----------------------------------------------------------

export function parseSMExpr(source: string): ParsedSMExpr {
  const tokens = tokenize(source);
  if (tokens.length === 0) {
    throw new Error(`sm_expression '${source}': empty expression`);
  }
  const ast = new Parser(tokens, source).parse();
  const vars = new Set<string>();
  collectVars(ast, vars);
  return { source, ast, vars };
}

export function evalSMExpr(parsed: ParsedSMExpr, scope: SMScope): SMScopeValue {
  return evalNode(parsed.ast, scope, parsed.source);
}

export function evalSMExprBool(parsed: ParsedSMExpr, scope: SMScope): boolean {
  return toBool(evalNode(parsed.ast, scope, parsed.source));
}

function evalNode(n: SMExprNode, scope: SMScope, src: string): SMScopeValue {
  switch (n.kind) {
    case "num":  return n.v;
    case "bool": return n.v;
    case "str":  return n.v;
    case "var": {
      const v = scope[n.name];
      if (v === undefined) {
        throw new Error(`sm_expression '${src}': undefined variable '${n.name}'`);
      }
      return v;
    }
    case "neg": return -toNum(evalNode(n.child, scope, src), src);
    case "not": return !toBool(evalNode(n.child, scope, src));
    case "binop": {
      const l = toNum(evalNode(n.l, scope, src), src);
      const r = toNum(evalNode(n.r, scope, src), src);
      switch (n.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
      }
      // unreachable
      throw new Error(`sm_expression: bad binop`);
    }
    case "cmp": {
      const l = evalNode(n.l, scope, src);
      const r = evalNode(n.r, scope, src);
      if (n.op === "==") return l === r;
      if (n.op === "!=") return l !== r;
      const ln = toNum(l, src);
      const rn = toNum(r, src);
      switch (n.op) {
        case "<":  return ln <  rn;
        case ">":  return ln >  rn;
        case "<=": return ln <= rn;
        case ">=": return ln >= rn;
      }
      throw new Error(`sm_expression: bad cmp`);
    }
    case "logic": {
      // Short-circuit evaluation.
      const l = toBool(evalNode(n.l, scope, src));
      if (n.op === "&&") {
        if (!l) return false;
        return toBool(evalNode(n.r, scope, src));
      }
      // ||
      if (l) return true;
      return toBool(evalNode(n.r, scope, src));
    }
  }
}

function toNum(v: SMScopeValue, src: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error(`sm_expression '${src}': expected numeric, got string '${v}'`);
}

function toBool(v: SMScopeValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v.length > 0;
}

/**
 * Validate that every variable a parsed expression references appears in
 * `knownVars`. Returns the unsatisfied set (empty when sound).
 */
export function checkSMVars(parsed: ParsedSMExpr, knownVars: ReadonlySet<string>): Set<string> {
  const missing = new Set<string>();
  for (const v of parsed.vars) {
    if (!knownVars.has(v)) missing.add(v);
  }
  return missing;
}
