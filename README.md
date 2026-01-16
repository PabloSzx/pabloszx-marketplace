# PabloSzx Marketplace

Claude Code plugins by PabloSzx.

## Plugins

- **refactor-verifier** - Deterministically verify that code refactors are purely structural with no unintended logic changes

## Installation

Add to your `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "pabloszx-marketplace": {
      "source": {
        "source": "url",
        "url": "https://github.com/PabloSzx/pabloszx-marketplace.git"
      }
    }
  },
  "enabledPlugins": {
    "refactor-verifier@pabloszx-marketplace": true
  }
}
```
