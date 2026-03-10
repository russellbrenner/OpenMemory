# OpenMemory — Project Instructions

## Repository Layout

```
packages/openmemory-js/   TypeScript MCP server + REST API (primary package)
dashboard/                Next.js dashboard UI
plans/                    Implementation plans (committed, never gitignore)
plans/reports/            Post-execution project reports
```

## Development Workflow

### Before Pushing to Production

**Always test in the openmemory-test environment first.**

Test endpoint: `https://openmemory-test.itsa.house`
Dashboard: `https://memory-test.itsa.house`
Namespace: `openmemory-test` (k3s cluster)
Database: `openmemory_test` (postgres.itsa.house)

The test environment mirrors production:
- Same embedding provider (Isaacus Kanon-2, 1792-dim)
- Same PostgreSQL backend
- Same ExternalSecret wiring (secrets from 1Password via external-secrets operator)
- Real API calls (not synthetic embeddings)

**Test checklist before merging to main:**

1. Build and push dev image: `docker build -t git.itsa.house/homelab/openmemory-api:<branch> .`
2. Patch test deployment image: `kubectl set image deploy/openmemory-api api=git.itsa.house/homelab/openmemory-api:<branch> -n openmemory-test`
3. Confirm rollout: `kubectl rollout status deploy/openmemory-api -n openmemory-test`
4. Health: `curl https://openmemory-test.itsa.house/health`
5. Embedding info: `curl https://openmemory-test.itsa.house/embedding/info` — verify provider=isaacus, dimensions=1792
6. Store a memory, query it back, verify similarity score > 0.5
7. Check enrichment: stored memory metadata should include `ilgs` key when `OM_ISAACUS_ENRICH=true`
8. Check metrics: `curl https://openmemory-test.itsa.house/metrics | grep embed`

### Applying Test Manifests

```bash
# Bootstrap (first time or after namespace deletion)
kubectl apply -k /home/rbrenner/git/homelab/k8s/openmemory-test/

# Check ExternalSecret synced (wait ~30s after apply)
kubectl get externalsecret -n openmemory-test

# Force re-sync if secret is stale
kubectl annotate externalsecret openmemory-secrets -n openmemory-test \
  force-sync=$(date +%s) --overwrite
```

## Embedding Provider

**Provider:** Isaacus Kanon-2 (`kanon-2-embedder`)
**Dimensions:** 1792
**Domain:** Australian legal text (+26% MAP@10 over Voyage-3 on AU case law)
**Enricher:** `kanon-2-enricher` (opt-in: `OM_ISAACUS_ENRICH=true`)
**API key:** `op://homelab/isaacus api key/credential`

The enricher extracts a legal knowledge graph (ILGS) from stored memories and
saves it under `metadata.ilgs`. Enable in production via the ConfigMap.

### Vector Dimension Migration

If switching from a different provider (e.g. Voyage AI at 1024-dim):

```bash
# 1. Apply migration to the target DB
psql -h postgres.itsa.house -U openmemory -d openmemory \
  -f packages/openmemory-js/migrations/003_vector_1792.sql

# 2. Re-embed all memories
ISAACUS_API_KEY=<key> OM_EMBEDDINGS=isaacus OM_VEC_DIM=1792 \
OM_METADATA_BACKEND=postgres OM_PG_HOST=postgres.itsa.house \
npx tsx packages/openmemory-js/scripts/reembed.ts
```

The test DB (`openmemory_test`) has already had migration 003 applied.

## CI/CD

CI runs on Gitea Actions (`.gitea/workflows/build.yaml`):
- Triggers on push to `main`
- Builds API + dashboard images with buildah
- Pushes to `git.itsa.house/homelab/openmemory-api:latest`
- Rolls out to production `openmemory` namespace via k8s API patch

Production URL: `https://openmemory.itsa.house`
Dashboard URL: `https://memory.itsa.house`

## Key Files

| File | Purpose |
|------|---------|
| `packages/openmemory-js/src/core/cfg.ts` | All env var config (single source of truth) |
| `packages/openmemory-js/src/memory/embed.ts` | Embedding providers + enricher |
| `packages/openmemory-js/src/memory/hsg.ts` | Memory add/delete/reinforce (transaction management) |
| `packages/openmemory-js/src/core/db.ts` | DB init, `make_transaction()` factory |
| `packages/openmemory-js/migrations/` | SQL migrations (apply manually for PG) |
| `packages/openmemory-js/scripts/reembed.ts` | Post-migration vector reconstruction |
| `/home/rbrenner/git/homelab/k8s/openmemory/` | Production k8s manifests |
| `/home/rbrenner/git/homelab/k8s/openmemory-test/` | Test k8s manifests |

## Commit Conventions

All commits require:
```
Co-Authored-By: Claude <noreply@anthropic.com>
AI-Generated: true
```
