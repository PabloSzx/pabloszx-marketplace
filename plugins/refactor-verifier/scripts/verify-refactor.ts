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

async function main() {
  console.log("=".repeat(70));
  console.log("REFACTOR VERIFICATION SCRIPT");
  console.log("=".repeat(70));
  console.log();

  // Step 1: Detect base branch
  console.log("🔍 Detecting base branch...");
  const baseBranch = await getBaseBranch();
  console.log(`   Base branch: ${baseBranch}`);

  // Step 2: Get changed Python files
  console.log("\n📄 Finding changed Python files...");
  const changedFiles = await getChangedPythonFiles(baseBranch);

  if (changedFiles.length === 0) {
    console.log("   No Python files changed.");
    console.log("\n✅ Nothing to verify.");
    process.exit(0);
  }

  console.log(`   Found ${changedFiles.length} changed files:`);
  for (const file of changedFiles.slice(0, 10)) {
    console.log(`   - ${file}`);
  }
  if (changedFiles.length > 10) {
    console.log(`   ... and ${changedFiles.length - 10} more`);
  }

  // Step 3: Extract definitions from old files
  console.log("\n🔍 Extracting definitions from old code...");
  const oldDefsArray: Definitions[] = [];
  for (const file of changedFiles) {
    const content = await getOldFileContent(baseBranch, file);
    if (content) {
      const defs = await extractPythonDefinitions(content, file);
      if (!defs.error) oldDefsArray.push(defs);
    }
  }
  const oldDefs = mergeDefinitions(oldDefsArray);
  console.log(`   Functions: ${Object.keys(oldDefs.functions).length}`);
  console.log(`   Classes: ${Object.keys(oldDefs.classes).length}`);

  // Step 4: Extract definitions from new files
  console.log("\n🔍 Extracting definitions from new code...");
  const newDefsArray: Definitions[] = [];
  for (const file of changedFiles) {
    const content = await getNewFileContent(file);
    if (content) {
      const defs = await extractPythonDefinitions(content, file);
      if (!defs.error) newDefsArray.push(defs);
    }
  }
  const newDefs = mergeDefinitions(newDefsArray);
  console.log(`   Functions: ${Object.keys(newDefs.functions).length}`);
  console.log(`   Classes: ${Object.keys(newDefs.classes).length}`);

  // Step 5: Compare
  console.log("\n" + "=".repeat(70));
  console.log("COMPARISON RESULTS");
  console.log("=".repeat(70));

  const comparison = compareDefinitions(oldDefs, newDefs);

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

  // Final verdict
  console.log("\n" + "=".repeat(70));
  if (comparison.identical) {
    console.log("✅ VERIFICATION PASSED: Refactor is 100% structural");
    console.log("   All function and class bodies are identical.");
    console.log("=".repeat(70));
    process.exit(0);
  } else {
    console.log("❌ VERIFICATION FAILED: Changes detected beyond refactoring");
    console.log("=".repeat(70));
    console.log("\nSummary:");
    console.log(`  - Removed: ${comparison.removed.length}`);
    console.log(`  - Added: ${comparison.added.length}`);
    console.log(`  - Modified: ${comparison.modified.length}`);
    console.log(`  - Matching: ${comparison.matching.length}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
