# Refactor Verifier

Deterministically verify that code refactors are purely structural with no unintended logic changes.

## Features

- **AST-based comparison**: Extracts and compares function/class definitions using language-specific AST parsing
- **Hash-based verification**: Uses SHA256 hashes of normalized code bodies for deterministic comparison
- **Multi-language support**: Python and TypeScript extractors included
- **Git integration**: Auto-detects branch changes and compares against base branch
- **Detailed reporting**: Shows removed, added, modified, and renamed definitions

## Usage

### Skill (Auto-triggered)

Ask Claude about verifying refactors:
- "Can you verify this refactor didn't change any logic?"
- "I want to confirm this file split was purely structural"
- "Help me check if this code reorganization introduced changes"

### Command

```
/verify-refactor
```

Runs verification on the current branch against staging/main.

## Components

- **Skill**: `refactor-verification` - Knowledge about deterministic refactor analysis
- **Command**: `/verify-refactor` - Explicit verification invocation
- **Scripts**:
  - `verify-refactor.ts` - Summary verification with hash comparison
  - `verify-refactor-detailed.ts` - Detailed diff output

## Requirements

- Bun runtime (for TypeScript scripts)
- Python 3.8+ (for Python AST extraction)
- Git (for branch comparison)

## How It Works

1. Fetches old code from base branch (staging or main)
2. Reads new code from current working directory
3. Extracts all function/class definitions using AST parsing
4. Computes SHA256 hashes of normalized code bodies
5. Compares definitions to identify:
   - **Removed**: Exist in old, missing in new
   - **Added**: Exist in new, missing in old
   - **Modified**: Same name, different body hash
   - **Matching**: Identical definitions
6. Reports findings with optional detailed diffs
