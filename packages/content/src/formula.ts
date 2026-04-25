/**
 * Recipe stat formula — tiny expression language.
 *
 * Recipes declare per-output-stat formulas as strings (see T-121/T-124).
 * Evaluated once per craft completion against a scope built from input role
 * stats, tool stats, workstation stats, and player skill levels. No
 * randomness, no IO, no loops, no recursion — pure numeric expressions.
 *
 * Grammar:
 *   expr     := term (('+' | '-') term)*
 *   term     := factor (('*' | '/') factor)*
 *   factor   := number | identifier | '(' expr ')' | call | unary
 *   unary    := '-' factor
 *   call     := ('min' | 'max' | 'clamp') '(' args ')'
 *   args     := expr (',' expr)*
 *   number   := [0-9]+ ('.' [0-9]+)?
 *   identifier := [a-zA-Z_] [a-zA-Z0-9_.]*
 *
 * Variable names are dotted identifiers — `stave.flexibility`,
 * `tool.qualityTier`, `skill.bowyer`. Names are looked up verbatim in the
 * supplied scope; no implicit fallback. An unknown name fails the eval.
 */

// ---- AST ------------------------------------------------------------------

export type FormulaNode =
  | { kind: "num"; v: number }
  | { kind: "var"; name: string }
  | { kind: "neg"; child: FormulaNode }
  | { kind: "binop"; op: "+" | "-" | "*" | "/"; l: FormulaNode; r: FormulaNode }
  | { kind: "call"; fn: "min" | "max" | "clamp"; args: FormulaNode[] };

export interface ParsedFormula {
  source: string;
  ast:    FormulaNode;
  /** Set of dotted identifiers the expression references. */
  vars:   ReadonlySet<string>;
}

const FUNCTIONS = new Set<"min" | "max" | "clamp">(["min", "max", "clamp"]);
const FUNCTION_ARITY: Record<string, [number, number]> = {
  min:   [2, 8],   // variadic ≥2
  max:   [2, 8],
  clamp: [3, 3],   // clamp(x, lo, hi)
};

// ---- tokenizer ------------------------------------------------------------

type Token =
  | { kind: "num"; v: number }
  | { kind: "ident"; name: string }
  | { kind: "punct"; c: "+" | "-" | "*" | "/" | "(" | ")" | "," };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "(" || c === ")" || c === ",") {
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
      while (j < src.length && (
        (src[j] >= "a" && src[j] <= "z") ||
        (src[j] >= "A" && src[j] <= "Z") ||
        (src[j] >= "0" && src[j] <= "9") ||
        src[j] === "_" || src[j] === "."
      )) j++;
      tokens.push({ kind: "ident", name: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`formula: unexpected character '${c}' at position ${i}`);
  }
  return tokens;
}

// ---- parser ---------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly src: string) {}

  parse(): FormulaNode {
    const node = this.expr();
    if (this.pos !== this.tokens.length) {
      throw new Error(`formula '${this.src}': unexpected token at end`);
    }
    return node;
  }

  private expr(): FormulaNode {
    let left = this.term();
    while (this.peekPunct("+") || this.peekPunct("-")) {
      const op = (this.tokens[this.pos] as { c: "+" | "-" }).c;
      this.pos++;
      const right = this.term();
      left = { kind: "binop", op, l: left, r: right };
    }
    return left;
  }

  private term(): FormulaNode {
    let left = this.factor();
    while (this.peekPunct("*") || this.peekPunct("/")) {
      const op = (this.tokens[this.pos] as { c: "*" | "/" }).c;
      this.pos++;
      const right = this.factor();
      left = { kind: "binop", op, l: left, r: right };
    }
    return left;
  }

  private factor(): FormulaNode {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error(`formula '${this.src}': unexpected end of input`);

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
      const inner = this.expr();
      this.expectPunct(")");
      return inner;
    }
    if (tok.kind === "ident") {
      // Function call vs variable: look ahead for `(`.
      const next = this.tokens[this.pos + 1];
      if (next && next.kind === "punct" && next.c === "(" && FUNCTIONS.has(tok.name as "min" | "max" | "clamp")) {
        const fn = tok.name as "min" | "max" | "clamp";
        this.pos += 2; // consume ident and '('
        const args: FormulaNode[] = [];
        if (!this.peekPunct(")")) {
          args.push(this.expr());
          while (this.peekPunct(",")) {
            this.pos++;
            args.push(this.expr());
          }
        }
        this.expectPunct(")");
        const [min, max] = FUNCTION_ARITY[fn];
        if (args.length < min || args.length > max) {
          throw new Error(`formula '${this.src}': '${fn}' takes ${min === max ? min : `${min}–${max}`} args, got ${args.length}`);
        }
        return { kind: "call", fn, args };
      }
      this.pos++;
      return { kind: "var", name: tok.name };
    }
    throw new Error(`formula '${this.src}': unexpected token at position ${this.pos}`);
  }

  private peekPunct(c: string): boolean {
    const t = this.tokens[this.pos];
    return !!t && t.kind === "punct" && t.c === c;
  }

  private expectPunct(c: ")" | "(" | ","): void {
    const t = this.tokens[this.pos];
    if (!t || t.kind !== "punct" || t.c !== c) {
      throw new Error(`formula '${this.src}': expected '${c}'`);
    }
    this.pos++;
  }
}

function collectVars(ast: FormulaNode, out: Set<string>): void {
  switch (ast.kind) {
    case "num": return;
    case "var": out.add(ast.name); return;
    case "neg": collectVars(ast.child, out); return;
    case "binop": collectVars(ast.l, out); collectVars(ast.r, out); return;
    case "call": for (const a of ast.args) collectVars(a, out); return;
  }
}

// ---- public API -----------------------------------------------------------

export function parseFormula(source: string): ParsedFormula {
  const tokens = tokenize(source);
  if (tokens.length === 0) {
    throw new Error(`formula '${source}': empty expression`);
  }
  const ast = new Parser(tokens, source).parse();
  const vars = new Set<string>();
  collectVars(ast, vars);
  return { source, ast, vars };
}

export type FormulaScope = Readonly<Record<string, number>>;

export function evalFormula(parsed: ParsedFormula, scope: FormulaScope): number {
  return evalNode(parsed.ast, scope, parsed.source);
}

function evalNode(n: FormulaNode, scope: FormulaScope, src: string): number {
  switch (n.kind) {
    case "num": return n.v;
    case "var": {
      const v = scope[n.name];
      if (v === undefined) {
        throw new Error(`formula '${src}': undefined variable '${n.name}'`);
      }
      return v;
    }
    case "neg": return -evalNode(n.child, scope, src);
    case "binop": {
      const l = evalNode(n.l, scope, src);
      const r = evalNode(n.r, scope, src);
      switch (n.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
      }
    }
    /* istanbul ignore next */ // exhaustive
    // deno-lint-ignore no-fallthrough
    case "call": {
      const args = n.args.map((a) => evalNode(a, scope, src));
      switch (n.fn) {
        case "min": return Math.min(...args);
        case "max": return Math.max(...args);
        case "clamp": {
          const [x, lo, hi] = args;
          return x < lo ? lo : x > hi ? hi : x;
        }
      }
    }
  }
}

/**
 * Validate that every variable a formula references is in `knownVars`.
 * Returns the unsatisfied set (empty when the formula is sound). Used by
 * T-124's recipe-graph validator at server boot.
 */
export function checkVars(parsed: ParsedFormula, knownVars: ReadonlySet<string>): Set<string> {
  const missing = new Set<string>();
  for (const v of parsed.vars) {
    if (!knownVars.has(v)) missing.add(v);
  }
  return missing;
}
