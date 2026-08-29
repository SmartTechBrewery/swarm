# Label colors

Canonical colors for GitHub issue labels across the org's repos, so new labels
stay consistent. `swarm` is the source of truth for any label name shared
between repos.

## Shared labels (same name, must match across repos)

| Label | Color | Used in |
|---|---|---|
| `bug` | `#d73a4a` | swarm, rover |
| `documentation` | `#0075ca` | swarm, rover |
| `duplicate` | `#cfd3d7` | swarm, rover |
| `enhancement` | `#a2eeef` | swarm, rover |
| `good first issue` | `#7057ff` | swarm, rover |
| `help wanted` | `#008672` | swarm, rover |
| `invalid` | `#e4e669` | swarm, rover |
| `question` | `#d876e3` | swarm, rover |
| `wontfix` | `#ffffff` | swarm, rover |
| `swarm` | `#031b66` | swarm, rover |
| `feature` | `#0e8a16` | swarm, rover |
| `planned` | `#0e8a16` | swarm, rover |
| `swarm:split-child` | `#ededed` | swarm, rover |

## swarm-only labels

| Label | Color |
|---|---|
| `phase-0` | `#1d76db` |
| `phase-1` | `#1d76db` |
| `phase-2` | `#1d76db` |
| `phase-3` | `#1d76db` |
| `phase-4` | `#1d76db` |
| `phase-5` | `#1d76db` |
| `phase-6` | `#1d76db` |
| `HITL` | `#D93F0B` |
| `swarm:replan` | `#d93f0b` |

## rover-only labels

| Label | Color |
|---|---|
| `core` | `#0E8A16` |
| `daemon` | `#1D76DB` |
| `backend` | `#5319E7` |
| `cli` | `#FBCA04` |
| `mcp` | `#A2EEEF` |
| `docs` | `#BFD4F2` |

## Adding a new label

- If the same label name will exist in another repo, reuse its color from the
  table above instead of picking a new one.
- If it's a genuinely new shared concept, pick a color here first and add it
  to both repos with the same hex value, then record it in this file.
