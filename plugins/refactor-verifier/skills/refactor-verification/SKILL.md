---
name: Refactor Verification
description: This skill should be used when the user asks to "verify a refactor", "check if a refactor changed logic", "confirm a file split was structural", "analyze refactor changes deterministically", "compare old and new code after reorganization", or wants to ensure a code reorganization didn't introduce unintended changes. Provides AST-based deterministic verification for Python and TypeScript refactors.
---

# Refactor Verification

Deterministically verify that code refactors are purely structural with no unintended logic changes using AST-based comparison and hash verification.

## Overview

When refactoring code (splitting files, reorganizing modules, renaming), it's critical to verify no functional changes were introduced. This skill provides a deterministic approach using:

1. **AST Extraction**: Parse code to extract function/class definitions
2. **Normalization**: Convert AST back to normalized source code
3. **Hash Comparison**: SHA256 hash of normalized bodies for exact comparison
4. **Diff Reporting**: Identify removed, added, modified, and renamed definitions

## When to Use

- Reviewing PRs that split monolithic files into modules
- Verifying module reorganization didn't change behavior
- Confirming rename-only changes
- Auditing large-scale refactoring efforts

## Verification Process

### Step 1: Identify the Refactor Scope

Determine what files changed:

```bash
# Get files changed vs base branch
git diff origin/staging --stat

# Or vs main
git diff origin/main --stat
```

### Step 2: Run Verification Script

Execute the verification script from the repository root:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/verify-refactor.ts
```

The script automatically:
- Detects the current branch
- Finds the merge base with staging/main
- Fetches old file content from base branch
- Extracts definitions from both old and new code
- Compares and reports differences

### Step 3: Analyze Results

The script reports:

| Category | Meaning |
|----------|---------|
| **Removed** | Functions/classes in old code, missing in new |
| **Added** | Functions/classes in new code, missing in old |
| **Modified** | Same name but different body hash |
| **Matching** | Identical definitions (hash match) |

### Step 4: Investigate Differences

For modified items, run the detailed script:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/verify-refactor-detailed.ts
```

This shows line-by-line diffs for each modified function/class.

## Understanding Results

### Pure Refactor (No Changes)

```
✅ VERIFICATION PASSED: Refactor is 100% structural
   All function and class bodies are identical.
```

### Intentional Improvements

Some changes during refactoring are intentional improvements:

- **Type annotations added**: `def foo(x):` → `def foo(x: int) -> str:`
- **Import cleanup**: Moving imports to module level
- **Typo fixes**: `get_snipet` → `get_snippet`
- **Docstring fixes**: Correcting spelling/grammar

These show as "modified" but are acceptable.

### Regressions to Fix

Watch for unintended changes:

- **Missing functions**: Endpoint accidentally removed
- **Signature changes**: Arguments became keyword-only unexpectedly
- **Logic changes**: Conditional behavior modified
- **API examples truncated**: Documentation degraded

## Language Support

### Python

Uses Python's `ast` module for precise extraction:

- Functions: `def` and `async def` at module level
- Classes: All class definitions with methods
- Assignments: Top-level constants and type aliases

The extractor normalizes code using `ast.unparse()` for consistent comparison.

### TypeScript

Uses TypeScript compiler API for extraction:

- Functions: Named functions and arrow functions
- Classes: Class declarations with methods
- Interfaces: Interface definitions
- Types: Type aliases

## Handling Renames

The scripts detect common rename patterns:

```python
# Known renames (adjust as needed)
renames = {
    "_get_asset": "get_asset",           # Private to public
    "get_sql_snipet": "get_sql_snippet"  # Typo fix
}
```

Renamed functions are compared with the name normalized, so `_get_asset` → `get_asset` shows as "renamed" rather than "removed + added".

## Customization

### Specify Files to Compare

Edit the script constants to target specific paths:

```typescript
const V0_PATH = "agora/agora/web/api/public/v0";
const NEW_FILE_PATHS = [
  `${V0_PATH}/views/aop.py`,
  `${V0_PATH}/views/assets.py`,
  // ...
];
```

### Add Language Extractors

The Python extractor pattern can be adapted for other languages. Key requirements:

1. Parse source to AST
2. Extract top-level definitions
3. Normalize back to source string
4. Hash the normalized body

## Utility Scripts

### `verify-refactor.ts`

Summary verification script that:
- Extracts all definitions from old and new code
- Computes SHA256 hashes of normalized bodies
- Reports removed/added/modified/matching counts
- Shows full body for modified items

### `verify-refactor-detailed.ts`

Detailed diff script that:
- Shows line-by-line differences
- Highlights specific changes within functions
- Useful for investigating modifications

## Best Practices

### Before Running Verification

1. Ensure working directory is clean (`git status`)
2. Fetch latest from remote (`git fetch origin`)
3. Know the base branch (staging vs main)

### Interpreting Results

1. **100% matching**: Pure refactor, safe to merge
2. **Only type annotations added**: Likely intentional improvement
3. **Functions missing**: Investigate - may be regression
4. **Logic changes**: Review carefully before approving

### Fixing Regressions

When verification fails:

1. Identify the regression from the diff output
2. Compare against original implementation
3. Restore missing code or revert unintended changes
4. Re-run verification to confirm fix

## Example Workflow

```bash
# 1. Check current branch status
git status

# 2. Run summary verification
bun run plugins/refactor-verifier/scripts/verify-refactor.ts

# 3. If modifications found, get details
bun run plugins/refactor-verifier/scripts/verify-refactor-detailed.ts

# 4. Fix any regressions
# ... edit files ...

# 5. Re-verify
bun run plugins/refactor-verifier/scripts/verify-refactor.ts
```

## Limitations

- **Comments**: Changes to comments don't affect body hash (AST strips comments)
- **Formatting**: Whitespace changes don't affect hash (normalized)
- **Import order**: Import reorganization shows as "modified" for classes using decorators
- **Nested functions**: Only top-level definitions are compared

## Troubleshooting

### "Module not found" Error

Ensure Bun is installed and script path is correct:

```bash
bun --version
ls -la ${CLAUDE_PLUGIN_ROOT}/scripts/
```

### Python Syntax Error

The Python extractor requires Python 3.8+ for `ast.unparse()`. Check version:

```bash
python3 --version
```

### No Definitions Found

Verify the file paths in the script match actual locations in the repository.
