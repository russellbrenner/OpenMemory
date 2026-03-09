# Isaacus Integration + auslaw-mcp Deployment

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Voyage AI with the Isaacus Kanon-2 embedding provider in openmemory-js, add optional legal enrichment (ILGS metadata), migrate the PG vector schema from 1024 to 1792 dims, re-embed all existing memories, and deploy auslaw-mcp to k3s with Gitea Actions CI.

**Architecture:** Two independent workstreams — (A) openmemory embedding provider swap + enricher, (B) auslaw-mcp k8s deploy + CI. Workstream A requires a PG migration and full corpus re-embed before the new image ships. Workstream B is a straight k8s deploy with a CI pipeline attached. Both land on the same `main` branch of their respective repos; there are no shared runtime dependencies between them at deploy time (auslaw-mcp calls `rag.itsa.house`, not openmemory directly).

**Tech Stack:** TypeScript/Node, PostgreSQL + pgvector, Gitea Actions (buildah), k3s, 1Password Connect (MCP). Isaacus SDK: `npm install isaacus`. auslaw-mcp is already containerised.

---

## Critical Files

| File | Role |
|------|------|
| `packages/openmemory-js/src/core/cfg.ts` | Env var definitions — add ISAACUS_API_KEY, base URL, model, enrich flag |
| `packages/openmemory-js/src/core/models.ts` | Per-sector model defaults — add isaacus entries |
| `packages/openmemory-js/src/memory/embed.ts` | Provider switch, batch path, getEmbeddingInfo |
| `packages/openmemory-js/src/memory/hsg.ts` | add_hsg_memory — call enricher when opt-in is set |
| `packages/openmemory-js/tests/test_omnibus.ts` | Add isaacus provider tests and enricher tests |
| `packages/openmemory-js/scripts/reembed.ts` | New: one-shot re-embed all memories after migration |
| `packages/openmemory-js/Dockerfile` | Add OM_VEC_DIM=1792 and OM_EMBEDDINGS=isaacus |
| `k8s/openmemory/` (homelab repo) | Update ConfigMap + Secret for ISAACUS_API_KEY |
| `/home/rbrenner/git/auslaw-mcp/.gitea/workflows/build.yaml` | New: Gitea Actions CI for auslaw-mcp |
| `/home/rbrenner/git/auslaw-mcp/k8s/secret.yaml` | New: JADE_SESSION_COOKIE k8s Secret manifest |

---

## Environment Variables (new)

| Var | Default | Purpose |
|-----|---------|---------|
| `ISAACUS_API_KEY` | — | Auth for Isaacus API (required when OM_EMBEDDINGS=isaacus) |
| `OM_ISAACUS_BASE_URL` | `https://api.isaacus.com/v1` | API base URL |
| `OM_ISAACUS_MODEL` | `kanon-2-embedder` | Embedding model override |
| `OM_ISAACUS_ENRICH` | `false` | Enable kanon-2-enricher (stores ILGS in memory metadata) |
| `OM_ISAACUS_ENRICH_MODEL` | `kanon-2-enricher` | Enricher model override |
| `OM_VEC_DIM` | `1792` | Must match embedding dimensions (was 1024 for Voyage) |

---

## Task 1: Add Isaacus config to cfg.ts and models.ts

**Files:**
- Modify: `packages/openmemory-js/src/core/cfg.ts`
- Modify: `packages/openmemory-js/src/core/models.ts`

**Step 1: Add env vars to cfg.ts**

In `cfg.ts`, in the `env` object (after the `voyage_*` entries), add:

```typescript
isaacus_key: str(process.env.ISAACUS_API_KEY ?? process.env.OM_ISAACUS_API_KEY, ""),
isaacus_base_url: str(process.env.OM_ISAACUS_BASE_URL, "https://api.isaacus.com/v1"),
isaacus_model: str(process.env.OM_ISAACUS_MODEL, "kanon-2-embedder"),
isaacus_enrich: (process.env.OM_ISAACUS_ENRICH ?? "false") === "true",
isaacus_enrich_model: str(process.env.OM_ISAACUS_ENRICH_MODEL, "kanon-2-enricher"),
```

**Step 2: Add isaacus entries to models.ts**

In `get_defaults()`, add an `isaacus` key with the same model for all sectors (the kanon-2-embedder is a single model, not sector-specific):

```typescript
isaacus: {
    episodic: "kanon-2-embedder",
    semantic: "kanon-2-embedder",
    procedural: "kanon-2-embedder",
    emotional: "kanon-2-embedder",
    reflective: "kanon-2-embedder",
},
```

In `get_model()`, add the isaacus override case:

```typescript
if (provider === "isaacus") return env.isaacus_model;
```

**Step 3: Build to check types**

```bash
cd packages/openmemory-js && npm run build 2>&1 | tail -10
```
Expected: zero errors.

**Step 4: Commit**

```bash
git add packages/openmemory-js/src/core/cfg.ts packages/openmemory-js/src/core/models.ts
git commit -m "feat(cfg): add Isaacus Kanon-2 provider config and model defaults"
```

---

## Task 2: Implement emb_isaacus() in embed.ts

**Files:**
- Modify: `packages/openmemory-js/src/memory/embed.ts`

**Step 1: Add npm dependency**

```bash
cd packages/openmemory-js && npm install isaacus
```

**Step 2: Add import at the top of embed.ts**

```typescript
import Isaacus from "isaacus";
```

**Step 3: Add the single-text embedding function**

Find the section where `emb_voyage()` is defined. Add `emb_isaacus()` after it:

```typescript
const emb_isaacus = async (text: string, sector: string): Promise<number[]> => {
    const client = new Isaacus({ apiKey: env.isaacus_key });
    // Use retrieval/document task type for storage; retrieval/query for search
    const task_type = sector === "__query__" ? "retrieval/query" : "retrieval/document";
    const res = await client.embeddings.create({
        model: env.isaacus_model,
        input: [text],
        task_type,
    });
    return res.data[0].embedding;
};
```

Note: pass `"__query__"` as the sector when embedding a search query (not storage). The callers in embed.ts use the sector name for storage and a separate query path.

**Step 4: Add case to embed_with_provider()**

In the `switch (provider)` block in `embed_with_provider()`:

```typescript
case "isaacus":
    result = await emb_isaacus(t, s);
    break;
```

**Step 5: Add case to emb_batch_with_fallback()**

Isaacus supports batching up to 128 texts. Add a batch path:

```typescript
const emb_batch_isaacus = async (texts: string[], sector: string): Promise<number[][]> => {
    const client = new Isaacus({ apiKey: env.isaacus_key });
    const task_type = sector === "__query__" ? "retrieval/query" : "retrieval/document";
    const res = await client.embeddings.create({
        model: env.isaacus_model,
        input: texts,
        task_type,
    });
    return res.data.map((d: any) => d.embedding);
};
```

In the batch switch:

```typescript
case "isaacus":
    vecs = await emb_batch_isaacus(texts, sector);
    break;
```

**Step 6: Add getEmbeddingInfo() case**

In the `getEmbeddingInfo()` function, add the isaacus info block following the existing voyage pattern:

```typescript
} else if (env.emb_kind === "isaacus") {
    info.provider = "isaacus";
    info.model_override = env.isaacus_model;
    info.base_url = env.isaacus_base_url;
    info.enrich_enabled = env.isaacus_enrich;
    info.enrich_model = env.isaacus_enrich_model;
}
```

**Step 7: Build**

```bash
cd packages/openmemory-js && npm run build 2>&1 | tail -10
```
Expected: zero errors.

**Step 8: Commit**

```bash
git add packages/openmemory-js/src/memory/embed.ts packages/openmemory-js/package.json packages/openmemory-js/package-lock.json
git commit -m "feat(embed): add Isaacus Kanon-2 embedding provider (emb_isaacus, batch, info)"
```

---

## Task 3: Add kanon-2-enricher support to hsg.ts

**Files:**
- Modify: `packages/openmemory-js/src/memory/hsg.ts`

The enricher runs after the memory is stored, merges the ILGS JSON into the memory's metadata field. It is completely opt-in and does NOT run if `OM_ISAACUS_ENRICH` is not `true` or if `OM_EMBEDDINGS` is not `isaacus`.

**Step 1: Create the enricher helper function in embed.ts**

Add to `embed.ts`:

```typescript
export interface ILGSResult {
    persons?: string[];
    locations?: string[];
    statutes?: string[];
    cases?: string[];
    defined_terms?: string[];
    dates?: string[];
    [key: string]: unknown;
}

export const enrich_isaacus = async (text: string): Promise<ILGSResult | null> => {
    if (!env.isaacus_enrich || env.emb_kind !== "isaacus") return null;
    try {
        const client = new Isaacus({ apiKey: env.isaacus_key });
        const res = await client.enrichments.create({
            model: env.isaacus_enrich_model,
            input: [text],
        });
        return res.data[0]?.enrichment ?? null;
    } catch (e) {
        console.error("[ENRICH] Isaacus enricher failed (non-fatal):", e);
        return null;
    }
};
```

Note: enrichment failure is non-fatal — it logs and returns null. The memory is still stored without enrichment.

**Step 2: Call enrich_isaacus in add_hsg_memory in hsg.ts**

Import `enrich_isaacus` from embed.ts:

```typescript
import { embedMultiSector, enrich_isaacus } from "./embed";
```

In `add_hsg_memory`, after the embedding but before the DB transaction (enrichment is async and should not hold the transaction):

```typescript
// Opt-in legal enrichment (Isaacus kanon-2-enricher only)
const ilgs = await enrich_isaacus(content);
const enriched_meta = ilgs ? { ...meta_obj, ilgs } : meta_obj;
```

Then use `enriched_meta` in the `q.ins_mem.run()` call instead of the raw `meta_obj`.

**Step 3: Build**

```bash
cd packages/openmemory-js && npm run build 2>&1 | tail -10
```
Expected: zero errors.

**Step 4: Commit**

```bash
git add packages/openmemory-js/src/memory/embed.ts packages/openmemory-js/src/memory/hsg.ts
git commit -m "feat(hsg): add optional kanon-2-enricher support (ILGS metadata, opt-in via OM_ISAACUS_ENRICH)"
```

---

## Task 4: Write tests for the Isaacus provider

**Files:**
- Modify: `packages/openmemory-js/tests/test_omnibus.ts`

**Step 1: Add a mock Isaacus provider test (no real API key needed)**

These tests run with `OM_EMBEDDINGS=synthetic` but verify the config parsing and provider switch behave correctly.

Add to the synthetic/unit test block in `test_omnibus.ts`:

```typescript
// Isaacus provider config is parsed correctly
test("isaacus config defaults are set", () => {
    // env is imported from cfg.ts; check defaults without real key
    expect(env.isaacus_base_url).toBe("https://api.isaacus.com/v1");
    expect(env.isaacus_model).toBe("kanon-2-embedder");
    expect(env.isaacus_enrich).toBe(false);
    expect(env.isaacus_enrich_model).toBe("kanon-2-enricher");
});

// enrich_isaacus returns null when provider is not isaacus
test("enrich_isaacus is a no-op when OM_EMBEDDINGS != isaacus", async () => {
    const result = await enrich_isaacus("test legal text");
    expect(result).toBeNull();
});
```

Import `env` from cfg.ts and `enrich_isaacus` from embed.ts at the top of the test file.

**Step 2: Run the tests (synthetic backend)**

```bash
cd packages/openmemory-js && OM_EMBEDDINGS=synthetic npx tsx tests/test_omnibus.ts 2>&1 | tail -20
```
Expected: all tests pass including the two new ones.

**Step 3: Run against PG to confirm no regressions**

```bash
OM_BACKEND=postgres OM_PG_HOST=postgres.itsa.house OM_PG_PORT=5432 \
OM_PG_USER=openmemory OM_PG_PASS=vmoFRbfDbugEjv5xlUjH3Ckq OM_PG_DB=openmemory_test \
OM_EMBEDDINGS=synthetic npx tsx tests/test_omnibus.ts 2>&1 | tail -20
```
Expected: all tests pass.

**Step 4: Commit**

```bash
git add packages/openmemory-js/tests/test_omnibus.ts
git commit -m "test(omnibus): add Isaacus provider config and enricher no-op tests"
```

---

## Task 5: PG vector dimension migration (1024 → 1792)

**Files:**
- Create: `packages/openmemory-js/migrations/003_vector_1792.sql`

The PG vectors table has `vec vector(1024)`. Isaacus produces 1792-dim vectors. The column must be migrated before the new image ships.

**Step 1: Create the migration SQL**

```sql
-- Migration 003: Expand vector dimension from 1024 to 1792 for Isaacus Kanon-2
-- Run against openmemory (production) and openmemory_test (test)
-- This deletes existing vectors — a re-embed script must be run immediately after.

ALTER TABLE "public"."openmemory_vectors" DROP COLUMN vec;
ALTER TABLE "public"."openmemory_vectors" ADD COLUMN vec vector(1792);

-- Recreate the HNSW index at the new dimension
DROP INDEX IF EXISTS "public"."vectors_hnsw_idx";
CREATE INDEX vectors_hnsw_idx
    ON "public"."openmemory_vectors"
    USING hnsw (vec vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

COMMENT ON COLUMN "public"."openmemory_vectors".vec IS 'Isaacus Kanon-2 1792-dim L2-normalised vector';
```

**Step 2: Apply to test DB first**

```bash
PGPASSWORD=vmoFRbfDbugEjv5xlUjH3Ckq psql \
  -h postgres.itsa.house -U openmemory -d openmemory_test \
  -f packages/openmemory-js/migrations/003_vector_1792.sql
```
Expected: `ALTER TABLE` × 2, `DROP INDEX`, `CREATE INDEX`, `COMMENT`.

**Step 3: Run omnibus test suite against migrated test DB (synthetic embeddings)**

```bash
OM_BACKEND=postgres OM_PG_HOST=postgres.itsa.house OM_PG_PORT=5432 \
OM_PG_USER=openmemory OM_PG_PASS=vmoFRbfDbugEjv5xlUjH3Ckq OM_PG_DB=openmemory_test \
OM_EMBEDDINGS=synthetic OM_VEC_DIM=1792 npx tsx tests/test_omnibus.ts 2>&1 | tail -20
```
Expected: all tests pass. (Synthetic embeddings resize to any dimension via `resize_vec()`.)

**Step 4: Apply to production DB**

```bash
PGPASSWORD=vmoFRbfDbugEjv5xlUjH3Ckq psql \
  -h postgres.itsa.house -U openmemory -d openmemory \
  -f packages/openmemory-js/migrations/003_vector_1792.sql
```

Note: this drops all existing vectors. The memory content and metadata are untouched (stored in `openmemory_memories`, not `openmemory_vectors`). Semantic search will return empty results until the re-embed script runs (Task 6). Plan maintenance window accordingly.

**Step 5: Commit**

```bash
git add packages/openmemory-js/migrations/003_vector_1792.sql
git commit -m "feat(db): migration 003 — expand vector column from 1024 to 1792 dims for Isaacus"
```

---

## Task 6: Write and run the re-embed script

**Files:**
- Create: `packages/openmemory-js/scripts/reembed.ts`

This script iterates all memories and calls `embedMultiSector()` for each, rebuilding the vectors table using the configured provider (isaacus).

**Step 1: Create the re-embed script**

```typescript
/**
 * scripts/reembed.ts
 *
 * Re-embeds all memories using the current OM_EMBEDDINGS provider.
 * Run after a vector dimension migration.
 *
 * Usage:
 *   ISAACUS_API_KEY=<key> OM_EMBEDDINGS=isaacus OM_VEC_DIM=1792 \
 *   OM_BACKEND=postgres OM_PG_HOST=... npx tsx scripts/reembed.ts
 */

import { init_db, q, all_async } from "../src/core/db";
import { embedMultiSector } from "../src/memory/embed";
import { memories_table } from "../src/core/db";

async function main() {
    await init_db();

    const rows = await all_async(`SELECT id, content FROM ${memories_table} ORDER BY created_at ASC`);
    console.log(`[REEMBED] Found ${rows.length} memories to re-embed`);

    let ok = 0, fail = 0;
    for (const row of rows) {
        try {
            await embedMultiSector(row.id, row.content);
            ok++;
            if (ok % 50 === 0) console.log(`[REEMBED] Progress: ${ok}/${rows.length}`);
        } catch (e) {
            fail++;
            console.error(`[REEMBED] Failed for ${row.id}:`, e);
        }
    }

    console.log(`[REEMBED] Done. OK: ${ok}, Failed: ${fail}`);
    process.exit(fail > 0 ? 1 : 0);
}

main();
```

**Step 2: Run against test DB first**

```bash
cd packages/openmemory-js
ISAACUS_API_KEY=$(op item get "Isaacus API Key" --field credential 2>/dev/null || echo "$ISAACUS_API_KEY") \
OM_EMBEDDINGS=isaacus OM_VEC_DIM=1792 \
OM_BACKEND=postgres OM_PG_HOST=postgres.itsa.house OM_PG_PORT=5432 \
OM_PG_USER=openmemory OM_PG_PASS=vmoFRbfDbugEjv5xlUjH3Ckq OM_PG_DB=openmemory_test \
npx tsx scripts/reembed.ts 2>&1 | tail -20
```
Expected: `[REEMBED] Done. OK: <N>, Failed: 0`

**Step 3: Verify semantic search works on test DB after re-embed**

```bash
OM_BACKEND=postgres OM_PG_HOST=postgres.itsa.house OM_PG_PORT=5432 \
OM_PG_USER=openmemory OM_PG_PASS=vmoFRbfDbugEjv5xlUjH3Ckq OM_PG_DB=openmemory_test \
OM_EMBEDDINGS=isaacus OM_VEC_DIM=1792 \
ISAACUS_API_KEY=$ISAACUS_API_KEY \
npx tsx tests/test_omnibus.ts 2>&1 | tail -20
```
Expected: all tests pass, including query/recall tests.

**Step 4: Run against production DB**

```bash
ISAACUS_API_KEY=<key from 1Password> \
OM_EMBEDDINGS=isaacus OM_VEC_DIM=1792 \
OM_BACKEND=postgres OM_PG_HOST=postgres.itsa.house OM_PG_PORT=5432 \
OM_PG_USER=openmemory OM_PG_PASS=vmoFRbfDbugEjv5xlUjH3Ckq OM_PG_DB=openmemory \
npx tsx scripts/reembed.ts 2>&1
```

This will take a few minutes (~1300 memories × 5 sectors = 6500 API calls).
Expected: `[REEMBED] Done. OK: 1316, Failed: 0` (approximate count).

**Step 5: Commit**

```bash
git add packages/openmemory-js/scripts/reembed.ts
git commit -m "feat(scripts): add reembed.ts for post-migration corpus re-embedding"
```

---

## Task 7: Update openmemory Dockerfile and k8s ConfigMap

**Files:**
- Modify: `packages/openmemory-js/Dockerfile`
- Modify: `k8s/openmemory/configmap.yaml` (homelab repo at `~/git/homelab`)
- Create/Modify: `k8s/openmemory/secret.yaml` (homelab repo) — add ISAACUS_API_KEY

**Step 1: Update Dockerfile ENV defaults**

In `packages/openmemory-js/Dockerfile`, update (or add) the ENV block:

```dockerfile
ENV OM_EMBEDDINGS=isaacus \
    OM_VEC_DIM=1792 \
    OM_EMBEDDING_FALLBACK=synthetic \
    OM_ISAACUS_BASE_URL=https://api.isaacus.com/v1 \
    OM_ISAACUS_MODEL=kanon-2-embedder \
    OM_ISAACUS_ENRICH=false \
    OM_ISAACUS_ENRICH_MODEL=kanon-2-enricher
```

**Step 2: Update k8s ConfigMap in homelab repo**

In `~/git/homelab/k8s/openmemory/configmap.yaml` (or wherever the openmemory ConfigMap lives), update:

```yaml
data:
  OM_EMBEDDINGS: "isaacus"
  OM_VEC_DIM: "1792"
  OM_EMBEDDING_FALLBACK: "synthetic"
  OM_ISAACUS_BASE_URL: "https://api.isaacus.com/v1"
  OM_ISAACUS_MODEL: "kanon-2-embedder"
  OM_ISAACUS_ENRICH: "false"
  OM_ISAACUS_ENRICH_MODEL: "kanon-2-enricher"
```

Remove the `VOYAGE_API_KEY` reference from the ConfigMap (it will remain in the Secret for rollback safety, but set to empty).

**Step 3: Add ISAACUS_API_KEY to the k8s Secret**

The ISAACUS_API_KEY is sensitive. Get it from 1Password via MCP:

```
mcp__agent-tools__op_get_secret with path: "op://Homelab/Isaacus API Key/credential"
```

Then patch the existing openmemory Secret (or create a new one):

```bash
kubectl create secret generic openmemory-secrets \
  -n openmemory \
  --from-literal=ISAACUS_API_KEY=<value> \
  --dry-run=client -o yaml | kubectl apply -f -
```

Update the Deployment to mount this new key as an env var from the Secret.

**Step 4: Commit homelab changes**

```bash
cd ~/git/homelab
git add k8s/openmemory/
git commit -m "feat(k8s): update openmemory configmap for Isaacus provider (1792-dim)"
```

**Step 5: Build and verify**

```bash
cd /home/rbrenner/git/openmemory/packages/openmemory-js
npm run build 2>&1 | tail -10
```

---

## Task 8: Push openmemory, trigger CI, deploy

**Step 1: Push to origin**

```bash
cd /home/rbrenner/git/openmemory && git push origin main
```

**Step 2: Monitor CI**

```bash
# Poll Gitea for latest run status
watch -n 10 'curl -s "https://git.itsa.house/api/v1/repos/rbrenner/openmemory/actions/runs?limit=3" \
  -H "Authorization: token bf7f2e6c0eb757f396028bdb3b8173bfa57ea25a" | \
  python3 -c "import sys,json; [print(r[\"id\"], r[\"status\"], r[\"head_commit\"][\"message\"][:50]) for r in json.load(sys.stdin)[\"workflow_runs\"]]"'
```
Expected: both `build-api` and `build-dashboard` jobs succeed.

**Step 3: Apply homelab k8s changes**

```bash
cd ~/git/homelab
kubectl apply -f k8s/openmemory/configmap.yaml
kubectl apply -f k8s/openmemory/
kubectl rollout restart deployment/openmemory-api -n openmemory
kubectl rollout status deployment/openmemory-api -n openmemory --timeout=240s
```

**Step 4: Smoke test**

```bash
POD=$(kubectl get pod -n openmemory -l app.kubernetes.io/component=api -o name | head -1)
kubectl exec -n openmemory $POD -- wget -qO- \
  --header="Accept: application/json" \
  http://localhost:8080/health | python3 -m json.tool
```
Expected: `"provider": "isaacus"`, `"dim": 1792`.

**Step 5: Store a test memory and query it back**

```bash
kubectl exec -n openmemory $POD -- wget -qO- \
  --header="Content-Type: application/json" \
  --header="Accept: application/json, text/event-stream" \
  --post-data='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"openmemory_store","arguments":{"content":"Isaacus Kanon-2 smoke test memory","user_id":"smoke-test"}}}' \
  http://localhost:8080/mcp
```

Then query it back:

```bash
kubectl exec -n openmemory $POD -- wget -qO- \
  --header="Content-Type: application/json" \
  --header="Accept: application/json, text/event-stream" \
  --post-data='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"openmemory_query","arguments":{"query":"Kanon smoke test","user_id":"smoke-test"}}}' \
  http://localhost:8080/mcp
```
Expected: returns the stored memory with a high relevance score.

---

## Task 9: auslaw-mcp — Gitea remote + CI pipeline

**Files:**
- Create: `/home/rbrenner/git/auslaw-mcp/.gitea/workflows/build.yaml`

**Step 1: Check if auslaw-mcp has a Gitea remote**

```bash
cd ~/git/auslaw-mcp && git remote -v
```

If no Gitea remote exists, create the repo and add it:

```bash
# Create repo in Gitea
curl -s -X POST "https://git.itsa.house/api/v1/user/repos" \
  -H "Authorization: token bf7f2e6c0eb757f396028bdb3b8173bfa57ea25a" \
  -H "Content-Type: application/json" \
  -d '{"name":"auslaw-mcp","description":"Australian law MCP server","private":true,"auto_init":false}'

git remote add origin https://git.itsa.house/rbrenner/auslaw-mcp.git
git push -u origin main
```

**Step 2: Add DEPLOY_TOKEN and REGISTRY_TOKEN secrets to auslaw-mcp repo**

These are the same values used for the openmemory repo:

```bash
# DEPLOY_TOKEN
curl -s -X PUT "https://git.itsa.house/api/v1/repos/rbrenner/auslaw-mcp/actions/secrets/DEPLOY_TOKEN" \
  -H "Authorization: token bf7f2e6c0eb757f396028bdb3b8173bfa57ea25a" \
  -H "Content-Type: application/json" \
  -d '{"data":"bf7f2e6c0eb757f396028bdb3b8173bfa57ea25a"}'

# REGISTRY_TOKEN — get from 1Password via MCP op_get_secret
# path: op://Homelab/Gitea Registry Token/credential
curl -s -X PUT "https://git.itsa.house/api/v1/repos/rbrenner/auslaw-mcp/actions/secrets/REGISTRY_TOKEN" \
  -H "Authorization: token bf7f2e6c0eb757f396028bdb3b8173bfa57ea25a" \
  -H "Content-Type: application/json" \
  -d "{\"data\":\"<registry-token-from-1password>\"}"

# MATTERMOST_AGENT_WEBHOOK (same as openmemory)
curl -s -X PUT "https://git.itsa.house/api/v1/repos/rbrenner/auslaw-mcp/actions/secrets/MATTERMOST_AGENT_WEBHOOK" \
  -H "Authorization: token bf7f2e6c0eb757f396028bdb3b8173bfa57ea25a" \
  -H "Content-Type: application/json" \
  -d '{"data":"<webhook-url-from-1password>"}'

curl -s -X PUT "https://git.itsa.house/api/v1/repos/rbrenner/auslaw-mcp/actions/secrets/MATTERMOST_ALERTS_WEBHOOK" \
  -H "Authorization: token bf7f2e6c0eb757f396028bdb3b8173bfa57ea25a" \
  -H "Content-Type: application/json" \
  -d '{"data":"https://chat.itsa.house/hooks/4odxkb9agp8tjqsbnic519yepc"}'
```

**Step 3: Create the Gitea Actions workflow**

Create `/home/rbrenner/git/auslaw-mcp/.gitea/workflows/build.yaml`:

```yaml
name: Build auslaw-mcp

on:
  workflow_dispatch:
  push:
    branches:
      - main

env:
  REGISTRY: git.itsa.house
  REGISTRY_USER: rbrenner
  IMAGE: git.itsa.house/rbrenner/auslaw-mcp
  K8S_NAMESPACE: auslaw-mcp
  DEPLOYMENT: auslaw-mcp

jobs:
  build:
    runs-on: self-hosted
    steps:
      - name: Setup
        run: |
          buildah --version
          SHORT_SHA=$(echo "${{ github.sha }}" | cut -c1-7)
          echo "SHORT_SHA=${SHORT_SHA}" >> "$GITHUB_ENV"

      - name: Checkout
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
        run: |
          REPO_URL="${{ github.server_url }}/${{ github.repository }}.git"
          AUTH_URL=$(echo "$REPO_URL" | sed "s|https://|https://token:${DEPLOY_TOKEN}@|")
          rm -rf checkout && git clone --depth=1 "$AUTH_URL" checkout

      - name: Login to registry
        env:
          REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }}
        run: |
          buildah login -u "${{ env.REGISTRY_USER }}" -p "${REGISTRY_TOKEN}" "${{ env.REGISTRY }}"

      - name: Build image
        run: |
          cd checkout
          buildah bud --isolation=chroot \
            -t "${{ env.IMAGE }}:latest" \
            -t "${{ env.IMAGE }}:${SHORT_SHA}" \
            -f Dockerfile .

      - name: Push image
        run: |
          push_retry() {
            local img=$1 attempt=0
            while [ $attempt -lt 3 ]; do
              attempt=$((attempt + 1))
              echo "Push attempt $attempt/3: $img"
              if buildah push "$img"; then return 0; fi
              echo "Attempt $attempt failed, retrying in 15s..."
              sleep 15
            done
            return 1
          }
          push_retry "${{ env.IMAGE }}:latest"
          push_retry "${{ env.IMAGE }}:${SHORT_SHA}"

      - name: Validate image
        run: |
          buildah pull "${{ env.IMAGE }}:${SHORT_SHA}"
          buildah inspect "${{ env.IMAGE }}:${SHORT_SHA}" | jq -r '.OCIv1.config.Cmd'
          echo "VALIDATED: ${{ env.DEPLOYMENT }}:${SHORT_SHA}"

      - name: Deploy to k3s
        run: |
          K8S_API="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"
          TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
          CACERT="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
          NAMESPACE="${{ env.K8S_NAMESPACE }}"
          DEPLOYMENT="${{ env.DEPLOYMENT }}"
          RESTART_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
          PATCH="{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"kubectl.kubernetes.io/restartedAt\":\"${RESTART_TS}\"}}}}}"
          HTTP_STATUS=$(curl -sf -o /tmp/patch_response.json -w "%{http_code}" \
            -X PATCH \
            -H "Authorization: Bearer ${TOKEN}" \
            -H "Content-Type: application/strategic-merge-patch+json" \
            --cacert "${CACERT}" \
            "${K8S_API}/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${DEPLOYMENT}" \
            -d "${PATCH}")
          echo "API response status: ${HTTP_STATUS}"
          if [ "${HTTP_STATUS}" != "200" ]; then cat /tmp/patch_response.json; exit 1; fi
          DEADLINE=$(($(date +%s) + 240))
          while [ "$(date +%s)" -lt "$DEADLINE" ]; do
            DEPLOY_JSON=$(curl -sf \
              -H "Authorization: Bearer ${TOKEN}" \
              --cacert "${CACERT}" \
              "${K8S_API}/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${DEPLOYMENT}")
            READY=$(echo "${DEPLOY_JSON}" | jq -r '.status.readyReplicas // 0')
            DESIRED=$(echo "${DEPLOY_JSON}" | jq -r '.spec.replicas // 1')
            echo "Rollout status: ${READY:-0}/${DESIRED:-?} replicas ready"
            if [ "${READY}" = "${DESIRED}" ] && [ -n "${READY}" ]; then
              echo "DEPLOYED: ${{ env.DEPLOYMENT }}:${SHORT_SHA}"
              exit 0
            fi
            sleep 5
          done
          echo "ERROR: Rollout did not complete within 240s"
          exit 1

      - name: Notify success
        if: success()
        env:
          WEBHOOK_URL: ${{ secrets.MATTERMOST_AGENT_WEBHOOK }}
        run: |
          curl -sf -X POST "$WEBHOOK_URL" \
            -H 'Content-Type: application/json' \
            -d "{\"text\": \"**[ci]** Built ${{ env.DEPLOYMENT }}:${SHORT_SHA} (buildah)\", \"username\": \"Gitea CI\"}" || true

      - name: Notify failure
        if: failure()
        env:
          WEBHOOK_URL: ${{ secrets.MATTERMOST_ALERTS_WEBHOOK }}
        run: |
          curl -sf -X POST "$WEBHOOK_URL" \
            -H 'Content-Type: application/json' \
            -d "{\"text\": \"**[ci] FAILED** :rotating_light: ${{ env.DEPLOYMENT }} build\nRun: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\", \"username\": \"Gitea CI\"}" || true
```

**Step 4: Commit**

```bash
cd ~/git/auslaw-mcp
git add .gitea/workflows/build.yaml
git commit -m "ci: add Gitea Actions build pipeline (buildah, k8s deploy, Mattermost notify)"
```

---

## Task 10: auslaw-mcp — k8s Secret and initial deploy

**Files:**
- Create: `/home/rbrenner/git/auslaw-mcp/k8s/secret.yaml`

The existing k8s manifests are complete except for the JADE_SESSION_COOKIE Secret.

**Step 1: Get JADE_SESSION_COOKIE from 1Password**

Use MCP: `mcp__agent-tools__op_get_secret` with path `op://Homelab/jade.io/session_cookie` (or search for "jade" in 1Password).

**Step 2: Create the Secret manifest (gitignored — contains sensitive data)**

```yaml
# k8s/secret.yaml — DO NOT COMMIT (gitignored)
apiVersion: v1
kind: Secret
metadata:
  name: auslaw-mcp-secrets
  namespace: auslaw-mcp
type: Opaque
stringData:
  JADE_SESSION_COOKIE: "<value-from-1password>"
```

Add to `.gitignore`:

```
k8s/secret.yaml
```

**Step 3: Add imagePullSecret for private registry**

The Deployment pulls from `git.itsa.house/rbrenner/auslaw-mcp` which is a private registry. Create a pull secret:

```bash
kubectl create namespace auslaw-mcp --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret docker-registry gitea-registry \
  -n auslaw-mcp \
  --docker-server=git.itsa.house \
  --docker-username=rbrenner \
  --docker-password=<registry-token-from-1password> \
  --dry-run=client -o yaml | kubectl apply -f -
```

Patch the Deployment manifest to reference it:

```yaml
spec:
  template:
    spec:
      imagePullSecrets:
        - name: gitea-registry
      imagePullPolicy: Always
```

**Step 4: Apply all manifests**

```bash
cd ~/git/auslaw-mcp
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

**Step 5: Trigger initial build via CI**

```bash
cd ~/git/auslaw-mcp && git push origin main
```

Wait for CI to build and push the image, then the deploy step will trigger the k8s rollout.

**Step 6: Verify deployment**

```bash
kubectl rollout status deployment/auslaw-mcp -n auslaw-mcp --timeout=240s
kubectl get pods -n auslaw-mcp

POD=$(kubectl get pod -n auslaw-mcp -l app=auslaw-mcp -o name | head -1)
kubectl exec -n auslaw-mcp $POD -- wget -qO- http://localhost:3000/health
```
Expected: `{"status":"ok"}`

**Step 7: Smoke test a tool call**

```bash
kubectl exec -n auslaw-mcp $POD -- wget -qO- \
  --header="Content-Type: application/json" \
  --post-data='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_cases","arguments":{"query":"negligence","jurisdiction":"HCA","limit":3}}}' \
  http://localhost:3000/mcp
```
Expected: returns 3 High Court cases matching "negligence".

**Step 8: Commit .gitignore update**

```bash
cd ~/git/auslaw-mcp
git add .gitignore
git commit -m "chore: gitignore k8s/secret.yaml"
git push origin main
```

---

## Rollback Notes

| Component | Rollback |
|-----------|---------|
| Isaacus embedding | Set `OM_EMBEDDINGS=voyage`, `OM_VEC_DIM=1024`, re-run migration 003 in reverse, re-embed with Voyage |
| Vector dim migration | `ALTER TABLE openmemory_vectors DROP COLUMN vec; ALTER TABLE openmemory_vectors ADD COLUMN vec vector(1024);` |
| auslaw-mcp | `kubectl delete -f k8s/` to remove all resources |
| Gitea CI | Delete `.gitea/workflows/build.yaml` from repo |

---

## Mattermost Summary (post-completion)

```
:white_check_mark: *isaacus-integration + auslaw-mcp* complete.

*openmemory:* Voyage AI replaced with Isaacus Kanon-2 (1792-dim, +26% MAP@10 on AU law).
Vector DB migrated. 1316 memories re-embedded. Optional ILGS enricher added (OM_ISAACUS_ENRICH=true).

*auslaw-mcp:* Deployed to k3s. Gitea CI operational. 11 MCP tools live at auslaw.itsa.house.

*Commits:* [openmemory] [auslaw-mcp] | *Branch:* main
```
