import "dotenv/config";
import postgres from "postgres";
import { databaseUrl, embeddingDimensions } from "@/config";

/**
 * Idempotent: converges to the same schema from empty or from a previous run,
 * and never prompts, so it can run unattended inside docker compose.
 */
export async function migrate(url = databaseUrl(), dimensions = embeddingDimensions()) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE TABLE IF NOT EXISTS contracts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        filename text NOT NULL,
        mime_type text NOT NULL,
        size_bytes integer NOT NULL,
        storage_path text NOT NULL,
        status text NOT NULL DEFAULT 'processing'
          CHECK (status IN ('processing', 'reviewed', 'failed')),
        status_detail text,
        page_count integer,
        full_text text,
        page_map jsonb,
        has_real_pages boolean,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS contracts_user_created_idx ON contracts (user_id, created_at DESC);
      -- Target of the composite foreign keys below.
      CREATE UNIQUE INDEX IF NOT EXISTS contracts_id_user_idx ON contracts (id, user_id);

      -- Children reference (contract_id, user_id) together, so the database
      -- itself refuses a row that pairs one user's contract with another user.
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id uuid NOT NULL,
        user_id text NOT NULL,
        ordinal integer NOT NULL,
        content text NOT NULL,
        section_label text,
        page_from integer,
        page_to integer,
        char_start integer NOT NULL,
        char_end integer NOT NULL,
        embedding vector(${dimensions}) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (contract_id, user_id) REFERENCES contracts (id, user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS chunks_contract_ordinal_idx ON chunks (contract_id, ordinal);
      CREATE INDEX IF NOT EXISTS chunks_content_trgm_idx ON chunks USING gin (content gin_trgm_ops);

      CREATE TABLE IF NOT EXISTS findings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id uuid NOT NULL,
        user_id text NOT NULL,
        item_key text NOT NULL,
        status text NOT NULL CHECK (status IN ('found', 'not_found', 'unclear')),
        summary text NOT NULL,
        quote text,
        section_label text,
        page_number integer,
        quote_verified boolean NOT NULL DEFAULT false,
        quote_char_start integer,
        quote_char_end integer,
        chunk_id uuid REFERENCES chunks (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (contract_id, item_key),
        -- The invariant, held by the database as well as the code.
        CHECK (status <> 'found' OR (quote_verified AND quote IS NOT NULL)),
        FOREIGN KEY (contract_id, user_id) REFERENCES contracts (id, user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS findings_contract_idx ON findings (contract_id);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id uuid NOT NULL,
        user_id text NOT NULL,
        role text NOT NULL CHECK (role IN ('user', 'assistant')),
        content text NOT NULL,
        citations jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (contract_id, user_id) REFERENCES contracts (id, user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS chat_contract_created_idx ON chat_messages (contract_id, created_at);
    `);
    // No index on chunks.embedding: every search filters to one contract first,
    // so an exact scan of a few hundred rows is faster and loses no recall. For
    // cross-contract search, add:
    //   CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
    // pgvector caps that at 2000 dimensions; above it, index embedding::halfvec(n).

    await matchEmbeddingWidth(sql, dimensions);
    console.log(`migration ok (embedding dimensions: ${dimensions})`);
  } finally {
    await sql.end();
  }
}

/** CREATE TABLE IF NOT EXISTS silently keeps an old vector width; this does not. */
async function matchEmbeddingWidth(sql: postgres.Sql, dimensions: number) {
  const [column] = await sql<{ width: number }[]>`
    SELECT atttypmod AS width FROM pg_attribute
    WHERE attrelid = 'chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`;
  if (column?.width === dimensions) return;

  console.warn(
    `WARNING: embedding width changes from ${column?.width} to ${dimensions}. Stored vectors are deleted ` +
      `(vectors from different models cannot be compared) and affected contracts must be uploaded again.`,
  );
  await sql.begin(async (tx) => {
    await tx`
      UPDATE contracts SET status = 'failed', updated_at = now(),
        status_detail = 'The embedding model changed. Please delete this contract and upload it again.'
      WHERE id IN (SELECT DISTINCT contract_id FROM chunks)`;
    await tx`DELETE FROM chunks`;
    await tx`ALTER TABLE chunks DROP COLUMN embedding`;
    await tx.unsafe(`ALTER TABLE chunks ADD COLUMN embedding vector(${dimensions}) NOT NULL`);
  });
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/db/migrate.ts")) {
  migrate().catch((error) => {
    console.error("migration failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
