---
name: verify-refactor
description: Deterministically verify a code refactor is purely structural with no logic changes
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
argument-hint: "[--detailed]"
---

# Verify Refactor Command

Verify that the current branch's refactor is purely structural with no unintended logic changes.

## Process

### Step 1: Gather Context

Run git commands to understand the current state:

```bash
git fetch origin && \
echo "=== BRANCH ===" && git rev-parse --abbrev-ref HEAD && \
echo "=== MERGE BASE ===" && git merge-base origin/staging HEAD 2>/dev/null || git merge-base origin/main HEAD && \
echo "=== CHANGED FILES ===" && git diff origin/staging --stat 2>/dev/null || git diff origin/main --stat
```

### Step 2: Run Verification

Execute the verification script:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/verify-refactor.ts
```

### Step 3: Analyze Results

Review the output:

- **Removed**: Functions/classes missing in new code - potential regression
- **Added**: New functions/classes - may be intentional
- **Modified**: Same name, different body - investigate
- **Matching**: Identical definitions - good

### Step 4: Get Details (if --detailed or modifications found)

If the user requested `--detailed` or if there are modifications, run:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/verify-refactor-detailed.ts
```

### Step 5: Report Findings

Summarize:

1. **Verification status**: PASSED (pure refactor) or FAILED (changes detected)
2. **Statistics**: Count of removed/added/modified/matching
3. **Intentional improvements**: Type annotations, typo fixes, etc.
4. **Regressions to fix**: Missing functions, logic changes

If regressions found, suggest specific fixes based on the diff output.

## Fallback: Self-Healing Script Creation

**If the baked scripts fail** (parsing errors, missing dependencies, unsupported syntax), create a local adapted script:

### Step F1: Diagnose the Failure

Analyze the error output:
- **Parsing error**: The file may use syntax not supported by the extractor
- **Missing dependency**: Bun or Python not available
- **Path issues**: Files don't match expected structure

### Step F2: Create Local Script

Create a simplified local script in the repository root that handles the specific case:

```bash
# Create local script adapted to the specific files being verified
cat > /tmp/verify-refactor-local.py << 'SCRIPT'
#!/usr/bin/env python3
"""
Local refactor verification script - adapted for this specific verification.
"""
import ast
import hashlib
import subprocess
import sys

def get_file_from_git(ref: str, path: str) -> str:
    """Get file content from git at specific ref."""
    try:
        result = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            capture_output=True, text=True, check=True
        )
        return result.stdout
    except subprocess.CalledProcessError:
        return ""

def extract_python_definitions(source: str) -> dict[str, str]:
    """Extract function and class definitions from Python source."""
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        print(f"Syntax error: {e}", file=sys.stderr)
        return {}

    definitions = {}
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            name = node.name
            body = ast.unparse(node)
            definitions[name] = body
        elif isinstance(node, ast.ClassDef):
            name = node.name
            body = ast.unparse(node)
            definitions[name] = body
    return definitions

def hash_body(body: str) -> str:
    """Compute SHA256 hash of normalized body."""
    return hashlib.sha256(body.encode()).hexdigest()[:12]

def compare_definitions(old_defs: dict, new_defs: dict) -> dict:
    """Compare old and new definitions."""
    old_names = set(old_defs.keys())
    new_names = set(new_defs.keys())

    removed = old_names - new_names
    added = new_names - old_names
    common = old_names & new_names

    modified = []
    matching = []
    for name in common:
        old_hash = hash_body(old_defs[name])
        new_hash = hash_body(new_defs[name])
        if old_hash != new_hash:
            modified.append((name, old_hash, new_hash))
        else:
            matching.append(name)

    return {
        "removed": list(removed),
        "added": list(added),
        "modified": modified,
        "matching": matching
    }

if __name__ == "__main__":
    # Customize these for your verification
    BASE_REF = "origin/staging"  # or origin/main
    FILES = [
        # Add files to verify here
        # "path/to/old_file.py:path/to/new_file.py",
    ]

    # Get merge base
    result = subprocess.run(
        ["git", "merge-base", BASE_REF, "HEAD"],
        capture_output=True, text=True
    )
    merge_base = result.stdout.strip()
    print(f"Comparing against merge base: {merge_base[:8]}")

    # Compare each file pair
    for file_spec in FILES:
        if ":" in file_spec:
            old_path, new_path = file_spec.split(":")
        else:
            old_path = new_path = file_spec

        print(f"\n=== {old_path} → {new_path} ===")

        old_content = get_file_from_git(merge_base, old_path)
        with open(new_path) as f:
            new_content = f.read()

        old_defs = extract_python_definitions(old_content)
        new_defs = extract_python_definitions(new_content)

        results = compare_definitions(old_defs, new_defs)

        print(f"Removed: {len(results['removed'])}")
        print(f"Added: {len(results['added'])}")
        print(f"Modified: {len(results['modified'])}")
        print(f"Matching: {len(results['matching'])}")

        if results['removed']:
            print(f"  ⚠️  Removed: {', '.join(results['removed'])}")
        if results['modified']:
            for name, old_h, new_h in results['modified']:
                print(f"  ⚠️  Modified: {name} ({old_h} → {new_h})")
SCRIPT
```

### Step F3: Customize and Run

1. Edit the `FILES` list in the script to include the files being verified
2. Adjust `BASE_REF` if needed (staging vs main)
3. Run the local script:

```bash
python3 /tmp/verify-refactor-local.py
```

### Step F4: TypeScript Fallback

For TypeScript files, create a simpler text-based comparison if AST parsing fails:

```bash
# Simple text-based extraction for TypeScript
cat > /tmp/verify-ts-simple.sh << 'SCRIPT'
#!/bin/bash
# Extract function/class signatures and compare

OLD_REF="${1:-origin/staging}"
FILE="$2"

echo "=== Comparing $FILE ==="
MERGE_BASE=$(git merge-base "$OLD_REF" HEAD)

echo "Old definitions:"
git show "$MERGE_BASE:$FILE" 2>/dev/null | grep -E "^(export )?(async )?(function|class|interface|type) " | sort

echo ""
echo "New definitions:"
grep -E "^(export )?(async )?(function|class|interface|type) " "$FILE" | sort
SCRIPT
chmod +x /tmp/verify-ts-simple.sh
```

### When to Use Fallback

Use the fallback approach when:
- Baked scripts fail with parsing errors
- Files use newer syntax features not yet supported
- Environment doesn't have required dependencies (Bun)
- Files are in languages other than Python/TypeScript

The local script approach allows adapting the verification logic to the specific files and syntax being verified.

## Notes

- The script auto-detects the base branch (staging or main)
- Python and TypeScript files are supported
- Comments and whitespace changes don't affect verification
- Renamed functions are detected if they follow common patterns
- **If scripts fail, create local adapted versions using the fallback instructions above**
