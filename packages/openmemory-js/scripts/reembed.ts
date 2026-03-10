/**
 * Re-embeds all memories using the current OM_EMBEDDINGS provider.
 * Run after a vector dimension migration.
 * Usage: ISAACUS_API_KEY=<key> OM_EMBEDDINGS=isaacus OM_VEC_DIM=1792 \
 *   OM_BACKEND=postgres OM_PG_HOST=... npx tsx scripts/reembed.ts
 */
import { all_async, memories_table } from "../src/core/db";
import { embedMultiSector } from "../src/memory/embed";

async function main() {
    // db auto-initialises at import time; no explicit init_db() needed.
    const rows = await all_async(`SELECT id, content FROM ${memories_table} ORDER BY created_at ASC`);
    console.log(`[REEMBED] Found ${rows.length} memories`);
    let ok = 0, fail = 0;
    for (const row of rows) {
        try {
            // Use all sectors for a full re-embed (pass no secs = use the default classify path)
            // embedMultiSector expects (id, content, sectors), derive sectors from content.
            const { classify_content, sectors } = await import("../src/memory/hsg");
            const cls = classify_content(row.content);
            const all_sectors = [cls.primary, ...cls.additional].length > 0
                ? [cls.primary, ...cls.additional]
                : sectors;
            await embedMultiSector(row.id, row.content, all_sectors);
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
