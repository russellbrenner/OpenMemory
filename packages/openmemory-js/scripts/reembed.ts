/**
 * Re-embeds all memories using the current OM_EMBEDDINGS provider.
 * Run after a vector dimension migration (e.g. 003_vector_1792.sql).
 *
 * Usage:
 *   ISAACUS_API_KEY=<key> OM_EMBEDDINGS=isaacus OM_VEC_DIM=1792 \
 *   OM_BACKEND=postgres OM_PG_HOST=... npx tsx scripts/reembed.ts
 *
 * NOTE: Run 003_vector_1792.sql against the database BEFORE this script.
 * The migration drops and recreates the vector column — all existing vectors
 * are deleted and must be regenerated here.
 */
import { all_async, memories_table } from "../src/core/db";
import { embedMultiSector } from "../src/memory/embed";
import { sectors } from "../src/memory/hsg";

async function main() {
    // db auto-initialises at import time; no explicit init_db() needed.
    const rows = await all_async(`SELECT id, content FROM ${memories_table} ORDER BY created_at ASC`);
    console.log(`[REEMBED] Found ${rows.length} memories`);
    let ok = 0, fail = 0;
    for (const row of rows) {
        try {
            // Always re-embed all sectors: the migration drops the entire vector
            // column, so every sector for every memory must be regenerated.
            await embedMultiSector(row.id, row.content, sectors);
            ok++;
            if (ok % 50 === 0) console.log(`[REEMBED] ${ok}/${rows.length}`);
        } catch (e) {
            fail++;
            console.error(`[REEMBED] Failed ${row.id}:`, e);
        }
    }
    console.log(`[REEMBED] Done. OK=${ok} Fail=${fail}`);
    process.exit(fail > 0 ? 1 : 0);
}

main();
