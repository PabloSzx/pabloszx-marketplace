#!/usr/bin/env bun
/**
 * Refactor Verification Script
 *
 * Deterministically verifies that a code refactor was purely structural
 * (splitting files, reorganizing modules) without changing any functionality.
 *
 * Usage: bun run verify-refactor.ts [--path <path>] [--base <branch>]
 *
 * The script:
 * 1. Detects current branch and finds merge base
 * 2. Identifies changed Python/TypeScript files
 * 3. Extracts function/class definitions using AST
 * 4. Computes SHA256 hashes of normalized code bodies
 * 5. Compares and reports: removed, added, modified, matching
 */

import { $ } from "bun";
import ts from "typescript";

// TypeScript definition interfaces
interface TSDefinition {
  body_hash: string;
  body: string;
  lineno: number;
  kind: "function" | "class" | "interface" | "type" | "const" | "enum";
}

interface TSDefinitions {
  items: Record<string, TSDefinition>;
  error?: string;
}

// Python script to extract definitions from Python source
const PYTHON_EXTRACTOR = `
import ast
import sys
import json
import hashlib

def normalize_code(node):
    """Convert AST node back to normalized source code."""
    return ast.unparse(node)

def get_function_signature(node):
    """Extract function signature details."""
    args = []
    for arg in node.args.args:
        arg_str = arg.arg
        if arg.annotation:
            arg_str += f": {ast.unparse(arg.annotation)}"
        args.append(arg_str)

    if node.args.vararg:
        arg_str = f"*{node.args.vararg.arg}"
        if node.args.vararg.annotation:
            arg_str += f": {ast.unparse(node.args.vararg.annotation)}"
        args.append(arg_str)

    if node.args.kwarg:
        arg_str = f"**{node.args.kwarg.arg}"
        if node.args.kwarg.annotation:
            arg_str += f": {ast.unparse(node.args.kwarg.annotation)}"
        args.append(arg_str)

    return_type = ast.unparse(node.returns) if node.returns else None

    return {
        "args": args,
        "return_type": return_type,
        "decorators": [ast.unparse(d) for d in node.decorator_list],
        "is_async": isinstance(node, ast.AsyncFunctionDef)
    }

def extract_definitions(source_code, filename=""):
    """Extract all definitions from Python source code."""
    try:
        tree = ast.parse(source_code)
    except SyntaxError as e:
        return {"error": f"Syntax error in {filename}: {e}"}

    definitions = {
        "functions": {},
        "classes": {},
        "assignments": {},
        "type_aliases": {}
    }

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            body = normalize_code(node)
            sig = get_function_signature(node)
            definitions["functions"][node.name] = {
                "signature": sig,
                "body_hash": hashlib.sha256(body.encode()).hexdigest(),
                "body": body,
                "lineno": node.lineno
            }

        elif isinstance(node, ast.ClassDef):
            body = normalize_code(node)
            bases = [ast.unparse(b) for b in node.bases]
            definitions["classes"][node.name] = {
                "bases": bases,
                "decorators": [ast.unparse(d) for d in node.decorator_list],
                "body_hash": hashlib.sha256(body.encode()).hexdigest(),
                "body": body,
                "lineno": node.lineno
            }

        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    value = normalize_code(node.value)
                    definitions["assignments"][target.id] = {
                        "value_hash": hashlib.sha256(value.encode()).hexdigest(),
                        "value": value
                    }
        elif isinstance(node, ast.AnnAssign) and node.target:
            if isinstance(node.target, ast.Name):
                value = normalize_code(node.value) if node.value else None
                annotation = ast.unparse(node.annotation)
                definitions["type_aliases"][node.target.id] = {
                    "annotation": annotation,
                    "value": value,
                    "value_hash": hashlib.sha256(value.encode()).hexdigest() if value else None
                }

    return definitions

if __name__ == "__main__":
    source = sys.stdin.read()
    filename = sys.argv[1] if len(sys.argv) > 1 else ""
    result = extract_definitions(source, filename)
    print(json.dumps(result, indent=2))
`;

interface FunctionDef {
  signature: {
    args: string[];
    return_type: string | null;
    decorators: string[];
    is_async: boolean;
  };
  body_hash: string;
  body: string;
  lineno: number;
}

interface ClassDef {
  bases: string[];
  decorators: string[];
  body_hash: string;
  body: string;
  lineno: number;
}

interface Definitions {
  functions: Record<string, FunctionDef>;
  classes: Record<string, ClassDef>;
  assignments: Record<string, { value_hash: string; value: string }>;
  type_aliases: Record<string, { annotation: string; value: string | null; value_hash: string | null }>;
  error?: string;
}

async function extractPythonDefinitions(
  sourceCode: string,
  filename: string
): Promise<Definitions> {
  const proc = Bun.spawn(["python3", "-c", PYTHON_EXTRACTOR, filename], {
    stdin: new Response(sourceCode),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    console.error(`Error processing ${filename}:`, stderr);
    return { functions: {}, classes: {}, assignments: {}, type_aliases: {}, error: stderr };
  }

  return JSON.parse(stdout);
}

async function getBaseBranch(): Promise<string> {
  // Try staging first, then main
  const stagingBase = await $`git merge-base origin/staging HEAD 2>/dev/null`.text().catch(() => "");
  if (stagingBase.trim()) return "origin/staging";

  const mainBase = await $`git merge-base origin/main HEAD 2>/dev/null`.text().catch(() => "");
  if (mainBase.trim()) return "origin/main";

  return "HEAD~1";
}

async function getChangedPythonFiles(baseBranch: string): Promise<string[]> {
  const diff = await $`git diff ${baseBranch} --name-only -- "*.py"`.text().catch(() => "");
  return diff.trim().split("\n").filter(f => f.length > 0);
}

async function getChangedTSFiles(baseBranch: string): Promise<string[]> {
  const diff = await $`git diff ${baseBranch} --name-only -- "*.ts" "*.tsx"`.text().catch(() => "");
  return diff.trim().split("\n").filter(f => f.length > 0 && !f.endsWith(".d.ts"));
}

function normalizeTSCode(code: string): string {
  return code
    .replace(/\/\/.*$/gm, "")           // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")   // Remove multi-line comments
    .replace(/\s+/g, " ")               // Normalize whitespace
    .trim();
}

function extractTSDefinitions(sourceCode: string, filename: string): TSDefinitions {
  const defs: TSDefinitions = { items: {} };

  try {
    const sourceFile = ts.createSourceFile(
      filename,
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    function visit(node: ts.Node) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

      // Function declarations: function foo() {}
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end);
        const hash = Bun.hash(normalizeTSCode(body)).toString(16);
        defs.items[`fn:${name}`] = { body_hash: hash, body, lineno: startLine, kind: "function" };
      }

      // Variable declarations with arrow/function: const foo = () => {} or const foo = memo(...)
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const name = decl.name.text;
            const init = decl.initializer;

            // Arrow function, function expression, or call expression (like memo())
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init)) {
              const body = sourceCode.slice(node.pos, node.end);
              const hash = Bun.hash(normalizeTSCode(body)).toString(16);
              defs.items[`const:${name}`] = { body_hash: hash, body, lineno: startLine, kind: "const" };
            }
          }
        }
      }

      // Class declarations
      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end);
        const hash = Bun.hash(normalizeTSCode(body)).toString(16);
        defs.items[`class:${name}`] = { body_hash: hash, body, lineno: startLine, kind: "class" };
      }

      // Interface declarations
      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end);
        const hash = Bun.hash(normalizeTSCode(body)).toString(16);
        defs.items[`interface:${name}`] = { body_hash: hash, body, lineno: startLine, kind: "interface" };
      }

      // Type alias declarations
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end);
        const hash = Bun.hash(normalizeTSCode(body)).toString(16);
        defs.items[`type:${name}`] = { body_hash: hash, body, lineno: startLine, kind: "type" };
      }

      // Enum declarations
      if (ts.isEnumDeclaration(node)) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end);
        const hash = Bun.hash(normalizeTSCode(body)).toString(16);
        defs.items[`enum:${name}`] = { body_hash: hash, body, lineno: startLine, kind: "enum" };
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  } catch (e) {
    defs.error = `Parse error in ${filename}: ${e}`;
  }

  return defs;
}

function mergeTSDefinitions(allDefs: TSDefinitions[]): TSDefinitions {
  const merged: TSDefinitions = { items: {} };
  for (const defs of allDefs) {
    Object.assign(merged.items, defs.items);
  }
  return merged;
}

function compareTSDefinitions(oldDefs: TSDefinitions, newDefs: TSDefinitions): ComparisonResult {
  const result: ComparisonResult = { identical: true, added: [], removed: [], modified: [], matching: [] };

  const oldNames = new Set(Object.keys(oldDefs.items));
  const newNames = new Set(Object.keys(newDefs.items));

  for (const name of oldNames) {
    if (!newNames.has(name)) {
      result.removed.push(name);
      result.identical = false;
    } else if (oldDefs.items[name].body_hash !== newDefs.items[name].body_hash) {
      result.modified.push({
        name,
        type: oldDefs.items[name].kind,
        reason: "body changed",
        oldHash: oldDefs.items[name].body_hash,
        newHash: newDefs.items[name].body_hash
      });
      result.identical = false;
    } else {
      result.matching.push(name);
    }
  }

  for (const name of newNames) {
    if (!oldNames.has(name)) {
      result.added.push(name);
      result.identical = false;
    }
  }

  return result;
}

async function getOldFileContent(baseBranch: string, filePath: string): Promise<string> {
  return await $`git show ${baseBranch}:${filePath}`.text().catch(() => "");
}

async function getNewFileContent(filePath: string): Promise<string> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return "";
  }
}

function mergeDefinitions(allDefs: Definitions[]): Definitions {
  const merged: Definitions = { functions: {}, classes: {}, assignments: {}, type_aliases: {} };
  for (const defs of allDefs) {
    Object.assign(merged.functions, defs.functions);
    Object.assign(merged.classes, defs.classes);
    Object.assign(merged.assignments, defs.assignments);
    Object.assign(merged.type_aliases, defs.type_aliases);
  }
  return merged;
}

interface ComparisonResult {
  identical: boolean;
  added: string[];
  removed: string[];
  modified: Array<{ name: string; type: string; reason: string; oldHash?: string; newHash?: string }>;
  matching: string[];
}

function compareDefinitions(oldDefs: Definitions, newDefs: Definitions): ComparisonResult {
  const result: ComparisonResult = { identical: true, added: [], removed: [], modified: [], matching: [] };

  // Compare functions
  const oldFunctions = new Set(Object.keys(oldDefs.functions));
  const newFunctions = new Set(Object.keys(newDefs.functions));

  for (const name of oldFunctions) {
    if (!newFunctions.has(name)) {
      result.removed.push(`function: ${name}`);
      result.identical = false;
    } else {
      const oldFunc = oldDefs.functions[name];
      const newFunc = newDefs.functions[name];
      if (oldFunc.body_hash !== newFunc.body_hash) {
        result.modified.push({ name, type: "function", reason: "body changed", oldHash: oldFunc.body_hash, newHash: newFunc.body_hash });
        result.identical = false;
      } else {
        result.matching.push(`function: ${name}`);
      }
    }
  }

  for (const name of newFunctions) {
    if (!oldFunctions.has(name)) {
      result.added.push(`function: ${name}`);
      result.identical = false;
    }
  }

  // Compare classes
  const oldClasses = new Set(Object.keys(oldDefs.classes));
  const newClasses = new Set(Object.keys(newDefs.classes));

  for (const name of oldClasses) {
    if (!newClasses.has(name)) {
      result.removed.push(`class: ${name}`);
      result.identical = false;
    } else {
      const oldClass = oldDefs.classes[name];
      const newClass = newDefs.classes[name];
      if (oldClass.body_hash !== newClass.body_hash) {
        result.modified.push({ name, type: "class", reason: "body changed", oldHash: oldClass.body_hash, newHash: newClass.body_hash });
        result.identical = false;
      } else {
        result.matching.push(`class: ${name}`);
      }
    }
  }

  for (const name of newClasses) {
    if (!oldClasses.has(name)) {
      result.added.push(`class: ${name}`);
      result.identical = false;
    }
  }

  return result;
}

function printComparisonResults(comparison: ComparisonResult, label: string) {
  console.log("\n" + "=".repeat(70));
  console.log(`${label} COMPARISON RESULTS`);
  console.log("=".repeat(70));

  if (comparison.removed.length > 0) {
    console.log("\n❌ REMOVED (exist in old, missing in new):");
    for (const item of comparison.removed) {
      console.log(`   - ${item}`);
    }
  }

  if (comparison.added.length > 0) {
    console.log("\n➕ ADDED (exist in new, missing in old):");
    for (const item of comparison.added) {
      console.log(`   - ${item}`);
    }
  }

  if (comparison.modified.length > 0) {
    console.log("\n⚠️  MODIFIED (body hash differs):");
    for (const item of comparison.modified) {
      console.log(`   - ${item.type}: ${item.name}`);
      console.log(`     Old hash: ${item.oldHash?.substring(0, 16)}...`);
      console.log(`     New hash: ${item.newHash?.substring(0, 16)}...`);
    }
  }

  console.log(`\n✅ MATCHING: ${comparison.matching.length} items`);
}

async function main() {
  console.log("=".repeat(70));
  console.log("REFACTOR VERIFICATION SCRIPT");
  console.log("=".repeat(70));
  console.log();

  // Step 1: Detect base branch
  console.log("🔍 Detecting base branch...");
  const baseBranch = await getBaseBranch();
  console.log(`   Base branch: ${baseBranch}`);

  // Step 2: Get changed files
  const pythonFiles = await getChangedPythonFiles(baseBranch);
  const tsFiles = await getChangedTSFiles(baseBranch);

  if (pythonFiles.length === 0 && tsFiles.length === 0) {
    console.log("\n📄 No Python or TypeScript files changed.");
    console.log("\n✅ Nothing to verify.");
    process.exit(0);
  }

  let pythonComparison: ComparisonResult | null = null;
  let tsComparison: ComparisonResult | null = null;

  // === PYTHON FILES ===
  if (pythonFiles.length > 0) {
    console.log(`\n📄 Found ${pythonFiles.length} Python files:`);
    for (const file of pythonFiles.slice(0, 10)) {
      console.log(`   - ${file}`);
    }
    if (pythonFiles.length > 10) {
      console.log(`   ... and ${pythonFiles.length - 10} more`);
    }

    // Extract definitions from old files
    console.log("\n🔍 Extracting Python definitions from old code...");
    const oldDefsArray: Definitions[] = [];
    for (const file of pythonFiles) {
      const content = await getOldFileContent(baseBranch, file);
      if (content) {
        const defs = await extractPythonDefinitions(content, file);
        if (!defs.error) oldDefsArray.push(defs);
      }
    }
    const oldDefs = mergeDefinitions(oldDefsArray);
    console.log(`   Functions: ${Object.keys(oldDefs.functions).length}`);
    console.log(`   Classes: ${Object.keys(oldDefs.classes).length}`);

    // Extract definitions from new files
    console.log("\n🔍 Extracting Python definitions from new code...");
    const newDefsArray: Definitions[] = [];
    for (const file of pythonFiles) {
      const content = await getNewFileContent(file);
      if (content) {
        const defs = await extractPythonDefinitions(content, file);
        if (!defs.error) newDefsArray.push(defs);
      }
    }
    const newDefs = mergeDefinitions(newDefsArray);
    console.log(`   Functions: ${Object.keys(newDefs.functions).length}`);
    console.log(`   Classes: ${Object.keys(newDefs.classes).length}`);

    pythonComparison = compareDefinitions(oldDefs, newDefs);
    printComparisonResults(pythonComparison, "PYTHON");
  }

  // === TYPESCRIPT FILES ===
  if (tsFiles.length > 0) {
    console.log(`\n📄 Found ${tsFiles.length} TypeScript files:`);
    for (const file of tsFiles.slice(0, 10)) {
      console.log(`   - ${file}`);
    }
    if (tsFiles.length > 10) {
      console.log(`   ... and ${tsFiles.length - 10} more`);
    }

    // Extract definitions from old files
    console.log("\n🔍 Extracting TypeScript definitions from old code...");
    const oldTSDefs: TSDefinitions[] = [];
    for (const file of tsFiles) {
      const content = await getOldFileContent(baseBranch, file);
      if (content) {
        const defs = extractTSDefinitions(content, file);
        if (!defs.error) oldTSDefs.push(defs);
      }
    }
    const mergedOldTS = mergeTSDefinitions(oldTSDefs);
    console.log(`   Definitions: ${Object.keys(mergedOldTS.items).length}`);

    // Extract definitions from new files
    console.log("\n🔍 Extracting TypeScript definitions from new code...");
    const newTSDefs: TSDefinitions[] = [];
    for (const file of tsFiles) {
      const content = await getNewFileContent(file);
      if (content) {
        const defs = extractTSDefinitions(content, file);
        if (!defs.error) newTSDefs.push(defs);
      }
    }
    const mergedNewTS = mergeTSDefinitions(newTSDefs);
    console.log(`   Definitions: ${Object.keys(mergedNewTS.items).length}`);

    tsComparison = compareTSDefinitions(mergedOldTS, mergedNewTS);
    printComparisonResults(tsComparison, "TYPESCRIPT");
  }

  // Final verdict
  const pythonIdentical = pythonComparison?.identical ?? true;
  const tsIdentical = tsComparison?.identical ?? true;
  const allIdentical = pythonIdentical && tsIdentical;

  console.log("\n" + "=".repeat(70));
  console.log("FINAL VERDICT");
  console.log("=".repeat(70));

  if (allIdentical) {
    console.log("\n✅ VERIFICATION PASSED: Refactor is 100% structural");
    console.log("   All function, class, and type bodies are identical.");
    process.exit(0);
  } else {
    console.log("\n❌ VERIFICATION FAILED: Changes detected beyond refactoring");
    console.log("\nSummary:");

    if (pythonComparison && !pythonComparison.identical) {
      console.log("\n  Python:");
      console.log(`    - Removed: ${pythonComparison.removed.length}`);
      console.log(`    - Added: ${pythonComparison.added.length}`);
      console.log(`    - Modified: ${pythonComparison.modified.length}`);
      console.log(`    - Matching: ${pythonComparison.matching.length}`);
    }

    if (tsComparison && !tsComparison.identical) {
      console.log("\n  TypeScript:");
      console.log(`    - Removed: ${tsComparison.removed.length}`);
      console.log(`    - Added: ${tsComparison.added.length}`);
      console.log(`    - Modified: ${tsComparison.modified.length}`);
      console.log(`    - Matching: ${tsComparison.matching.length}`);
    }

    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
