-- Migration 003: Expand vector dimension 1024 -> 1792 for Isaacus Kanon-2
-- WARNING: Drops all existing vectors. Run reembed.ts immediately after.
-- NOTE: The vector column in openmemory_vectors is named 'v', not 'vec'.

ALTER TABLE "public"."openmemory_vectors" DROP COLUMN IF EXISTS v;
ALTER TABLE "public"."openmemory_vectors" ADD COLUMN v vector(1792);

DROP INDEX IF EXISTS "public"."openmemory_vectors_hnsw_idx";
CREATE INDEX openmemory_vectors_hnsw_idx
    ON "public"."openmemory_vectors"
    USING hnsw (v vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
