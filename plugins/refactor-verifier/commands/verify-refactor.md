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

## Notes

- The script auto-detects the base branch (staging or main)
- Python and TypeScript files are supported
- Comments and whitespace changes don't affect verification
- Renamed functions are detected if they follow common patterns
