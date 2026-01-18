#!/usr/bin/env bun
/**
 * Detailed Refactor Verification Script
 *
 * Shows line-by-line differences between old and new implementations.
 * Use this after verify-refactor.ts identifies modifications.
 *
 * Usage: bun run verify-refactor-detailed.ts
 */

import { $ } from "bun";
import ts from "typescript";

// TypeScript definitions interface for detailed view
interface TSDefinitionsDetailed {
  items: Record<string, string>;
  error?: string;
}

// Python script to extract code definitions
const PYTHON_EXTRACTOR = `
import ast
import sys
import json

def normalize_code(node):
    """Convert AST node back to normalized source code."""
    return ast.unparse(node)

def extract_definitions(source_code, filename=""):
    """Extract all definitions from Python source code."""
    try:
        tree = ast.parse(source_code)
    except SyntaxError as e:
        return {"error": f"Syntax error in {filename}: {e}"}

    definitions = {
        "functions": {},
        "classes": {}
    }

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            body = normalize_code(node)
            definitions["functions"][node.name] = body

        elif isinstance(node, ast.ClassDef):
            body = normalize_code(node)
            definitions["classes"][node.name] = body

    return definitions

if __name__ == "__main__":
    source = sys.stdin.read()
    filename = sys.argv[1] if len(sys.argv) > 1 else ""
    result = extract_definitions(source, filename)
    print(json.dumps(result, indent=2))
`;

interface Definitions {
  functions: Record<string, string>;
  classes: Record<string, string>;
  error?: string;
}

async function extractDefinitions(sourceCode: string, filename: string): Promise<Definitions> {
  const proc = Bun.spawn(["python3", "-c", PYTHON_EXTRACTOR, filename], {
    stdin: new Response(sourceCode),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    return { functions: {}, classes: {}, error: stderr };
  }

  return JSON.parse(stdout);
}

async function getBaseBranch(): Promise<string> {
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

function extractTSDefinitionsDetailed(sourceCode: string, filename: string): TSDefinitionsDetailed {
  const defs: TSDefinitionsDetailed = { items: {} };

  try {
    const sourceFile = ts.createSourceFile(
      filename,
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    function visit(node: ts.Node) {
      // Function declarations
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end).trim();
        defs.items[`fn:${name}`] = body;
      }

      // Variable declarations with arrow/function
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const name = decl.name.text;
            const init = decl.initializer;

            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init)) {
              const body = sourceCode.slice(node.pos, node.end).trim();
              defs.items[`const:${name}`] = body;
            }
          }
        }
      }

      // Class declarations
      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end).trim();
        defs.items[`class:${name}`] = body;
      }

      // Interface declarations
      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end).trim();
        defs.items[`interface:${name}`] = body;
      }

      // Type alias declarations
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end).trim();
        defs.items[`type:${name}`] = body;
      }

      // Enum declarations
      if (ts.isEnumDeclaration(node)) {
        const name = node.name.text;
        const body = sourceCode.slice(node.pos, node.end).trim();
        defs.items[`enum:${name}`] = body;
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  } catch (e) {
    defs.error = `Parse error in ${filename}: ${e}`;
  }

  return defs;
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

function simpleDiff(oldCode: string, newCode: string): string {
  const oldLines = oldCode.split("\n");
  const newLines = newCode.split("\n");

  const result: string[] = [];

  // Find first difference
  let i = 0;
  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
    i++;
  }

  if (i === oldLines.length && i === newLines.length) {
    return "(identical)";
  }

  // Show context around diff
  const contextStart = Math.max(0, i - 2);
  if (contextStart > 0) {
    result.push(`  ... (${contextStart} identical lines)`);
  }

  for (let j = contextStart; j < Math.min(i + 10, Math.max(oldLines.length, newLines.length)); j++) {
    if (j < oldLines.length && j < newLines.length && oldLines[j] === newLines[j]) {
      result.push(`    ${oldLines[j].substring(0, 80)}`);
    } else {
      if (j < oldLines.length) {
        result.push(`  - ${oldLines[j].substring(0, 80)}`);
      }
      if (j < newLines.length) {
        result.push(`  + ${newLines[j].substring(0, 80)}`);
      }
    }
  }

  const remaining = Math.max(oldLines.length, newLines.length) - i - 10;
  if (remaining > 0) {
    result.push(`  ... (${remaining} more lines)`);
  }

  return result.join("\n");
}

function analyzeTSDefinitions(
  oldDefs: TSDefinitionsDetailed,
  newDefs: TSDefinitionsDetailed
) {
  console.log("\n" + "=".repeat(70));
  console.log("TYPESCRIPT ANALYSIS");
  console.log("=".repeat(70));

  const oldItems = new Set(Object.keys(oldDefs.items));
  const newItems = new Set(Object.keys(newDefs.items));

  // Check removed
  console.log("\n❌ REMOVED:");
  let removedCount = 0;
  for (const name of oldItems) {
    if (!newItems.has(name)) {
      console.log(`  - ${name}`);
      removedCount++;
    }
  }
  if (removedCount === 0) console.log("  (none)");

  // Check added
  console.log("\n➕ ADDED:");
  let addedCount = 0;
  for (const name of newItems) {
    if (!oldItems.has(name)) {
      console.log(`  - ${name}`);
      addedCount++;
    }
  }
  if (addedCount === 0) console.log("  (none)");

  // Check modified
  console.log("\n⚠️  MODIFIED:");
  let modifiedCount = 0;
  for (const name of oldItems) {
    if (newItems.has(name)) {
      const oldCode = oldDefs.items[name];
      const newCode = newDefs.items[name];

      if (oldCode !== newCode) {
        modifiedCount++;
        console.log(`\n  --- ${name} ---`);
        console.log(simpleDiff(oldCode, newCode));
      }
    }
  }
  if (modifiedCount === 0) console.log("  (none)");

  const matches = [...oldItems].filter(
    (n) => newItems.has(n) && oldDefs.items[n] === newDefs.items[n]
  ).length;

  return { matches, total: oldItems.size };
}

async function main() {
  console.log("=".repeat(70));
  console.log("DETAILED REFACTOR VERIFICATION");
  console.log("=".repeat(70));
  console.log();

  // Get base branch and files
  const baseBranch = await getBaseBranch();
  console.log(`📄 Comparing against: ${baseBranch}`);

  const pythonFiles = await getChangedPythonFiles(baseBranch);
  const tsFiles = await getChangedTSFiles(baseBranch);

  if (pythonFiles.length === 0 && tsFiles.length === 0) {
    console.log("No Python or TypeScript files changed.");
    process.exit(0);
  }

  let pythonStats = { funcMatches: 0, funcTotal: 0, classMatches: 0, classTotal: 0 };
  let tsStats = { matches: 0, total: 0 };

  // === PYTHON FILES ===
  if (pythonFiles.length > 0) {
    console.log(`\n📁 Analyzing ${pythonFiles.length} Python files...\n`);

    // Collect all definitions
    const oldDefs: Definitions = { functions: {}, classes: {} };
    const newDefs: Definitions = { functions: {}, classes: {} };

    for (const file of pythonFiles) {
      const oldContent = await getOldFileContent(baseBranch, file);
      const newContent = await getNewFileContent(file);

      if (oldContent) {
        const defs = await extractDefinitions(oldContent, file);
        Object.assign(oldDefs.functions, defs.functions);
        Object.assign(oldDefs.classes, defs.classes);
      }

      if (newContent) {
        const defs = await extractDefinitions(newContent, file);
        Object.assign(newDefs.functions, defs.functions);
        Object.assign(newDefs.classes, defs.classes);
      }
    }

    // Common renames to check
    const renames: Record<string, string> = {
      // Add common rename patterns here
      // "_private_func": "public_func",
    };

    console.log("=".repeat(70));
    console.log("PYTHON FUNCTION ANALYSIS");
    console.log("=".repeat(70));

    const oldFuncs = new Set(Object.keys(oldDefs.functions));
    const newFuncs = new Set(Object.keys(newDefs.functions));

    // Check renamed functions
    if (Object.keys(renames).length > 0) {
      console.log("\n📝 RENAMED FUNCTIONS:");
      for (const [oldName, newName] of Object.entries(renames)) {
        if (oldFuncs.has(oldName) && newFuncs.has(newName)) {
          console.log(`\n  ${oldName} → ${newName}`);
          const oldCode = oldDefs.functions[oldName];
          const normalizedOldCode = oldCode.replace(new RegExp(`\\b${oldName}\\b`, "g"), newName);
          const newCode = newDefs.functions[newName];

          if (normalizedOldCode === newCode) {
            console.log("  ✅ Body identical (just renamed)");
          } else {
            console.log("  ⚠️  Body also changed:");
            console.log(simpleDiff(normalizedOldCode, newCode));
          }
        }
      }
    }

    // Check truly removed functions
    console.log("\n❌ REMOVED FUNCTIONS:");
    let removedCount = 0;
    for (const name of oldFuncs) {
      if (!newFuncs.has(name) && !Object.keys(renames).includes(name)) {
        console.log(`  - ${name}`);
        removedCount++;
      }
    }
    if (removedCount === 0) console.log("  (none)");

    // Check truly added functions
    console.log("\n➕ ADDED FUNCTIONS:");
    let addedCount = 0;
    for (const name of newFuncs) {
      if (!oldFuncs.has(name) && !Object.values(renames).includes(name)) {
        console.log(`  - ${name}`);
        addedCount++;
      }
    }
    if (addedCount === 0) console.log("  (none)");

    // Check modified functions
    console.log("\n⚠️  MODIFIED FUNCTIONS:");
    let modifiedCount = 0;
    for (const name of oldFuncs) {
      if (newFuncs.has(name)) {
        const oldCode = oldDefs.functions[name];
        const newCode = newDefs.functions[name];

        if (oldCode !== newCode) {
          modifiedCount++;
          console.log(`\n  --- ${name} ---`);
          console.log(simpleDiff(oldCode, newCode));
        }
      }
    }
    if (modifiedCount === 0) console.log("  (none)");

    console.log("\n" + "=".repeat(70));
    console.log("PYTHON CLASS ANALYSIS");
    console.log("=".repeat(70));

    const oldClasses = new Set(Object.keys(oldDefs.classes));
    const newClasses = new Set(Object.keys(newDefs.classes));

    // Check modified classes
    console.log("\n⚠️  MODIFIED CLASSES:");
    modifiedCount = 0;
    for (const name of oldClasses) {
      if (newClasses.has(name)) {
        const oldCode = oldDefs.classes[name];
        const newCode = newDefs.classes[name];

        if (oldCode !== newCode) {
          modifiedCount++;
          console.log(`\n  --- ${name} ---`);
          console.log(simpleDiff(oldCode, newCode));
        }
      }
    }
    if (modifiedCount === 0) console.log("  (none)");

    pythonStats.funcMatches = [...oldFuncs].filter(
      (n) => newFuncs.has(n) && oldDefs.functions[n] === newDefs.functions[n]
    ).length;
    pythonStats.funcTotal = oldFuncs.size;
    pythonStats.classMatches = [...oldClasses].filter(
      (n) => newClasses.has(n) && oldDefs.classes[n] === newDefs.classes[n]
    ).length;
    pythonStats.classTotal = oldClasses.size;
  }

  // === TYPESCRIPT FILES ===
  if (tsFiles.length > 0) {
    console.log(`\n📁 Analyzing ${tsFiles.length} TypeScript files...\n`);

    const oldTSDefs: TSDefinitionsDetailed = { items: {} };
    const newTSDefs: TSDefinitionsDetailed = { items: {} };

    for (const file of tsFiles) {
      const oldContent = await getOldFileContent(baseBranch, file);
      const newContent = await getNewFileContent(file);

      if (oldContent) {
        const defs = extractTSDefinitionsDetailed(oldContent, file);
        Object.assign(oldTSDefs.items, defs.items);
      }

      if (newContent) {
        const defs = extractTSDefinitionsDetailed(newContent, file);
        Object.assign(newTSDefs.items, defs.items);
      }
    }

    tsStats = analyzeTSDefinitions(oldTSDefs, newTSDefs);
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));

  if (pythonFiles.length > 0) {
    console.log(`\nPython Functions: ${pythonStats.funcMatches}/${pythonStats.funcTotal} identical`);
    console.log(`Python Classes: ${pythonStats.classMatches}/${pythonStats.classTotal} identical`);
  }

  if (tsFiles.length > 0) {
    console.log(`\nTypeScript Definitions: ${tsStats.matches}/${tsStats.total} identical`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
