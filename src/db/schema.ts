import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { embeddingDimensions } from "@/config";
import type { PageSpan } from "@/services/extract";
import type { Citation } from "@/services/chat";

/*
 * user_id (the Clerk user id) is on every table on purpose. A join is something
 * a developer can forget; a WHERE user_id on the table being queried is not.
 *
 * These definitions type the queries. src/db/migrate.ts creates the tables,
 * indexes and foreign keys.
 */

export type ContractStatus = "processing" | "reviewed" | "failed";
export type FindingStatus = "found" | "not_found" | "unclear";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const contracts = pgTable("contracts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storagePath: text("storage_path").notNull(),
  status: text("status").$type<ContractStatus>().notNull().default("processing"),
  /** Why it failed, or a warning on a reviewed contract. Shown to the user. */
  statusDetail: text("status_detail"),
  pageCount: integer("page_count"),
  fullText: text("full_text"),
  pageMap: jsonb("page_map").$type<PageSpan[]>(),
  hasRealPages: boolean("has_real_pages"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

const contractId = () =>
  uuid("contract_id")
    .notNull()
    .references(() => contracts.id, { onDelete: "cascade" });

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  contractId: contractId(),
  userId: text("user_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  sectionLabel: text("section_label"),
  pageFrom: integer("page_from"),
  pageTo: integer("page_to"),
  charStart: integer("char_start").notNull(),
  charEnd: integer("char_end").notNull(),
  embedding: vector("embedding", { dimensions: embeddingDimensions() }).notNull(),
  createdAt: createdAt(),
});

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: contractId(),
    userId: text("user_id").notNull(),
    itemKey: text("item_key").notNull(),
    status: text("status").$type<FindingStatus>().notNull(),
    summary: text("summary").notNull(),
    /** Only ever the contract's own characters, sliced from full_text. */
    quote: text("quote"),
    sectionLabel: text("section_label"),
    pageNumber: integer("page_number"),
    quoteVerified: boolean("quote_verified").notNull().default(false),
    quoteCharStart: integer("quote_char_start"),
    quoteCharEnd: integer("quote_char_end"),
    chunkId: uuid("chunk_id").references(() => chunks.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [unique("findings_contract_item_key").on(t.contractId, t.itemKey)],
);

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  contractId: contractId(),
  userId: text("user_id").notNull(),
  role: text("role").$type<"user" | "assistant">().notNull(),
  content: text("content").notNull(),
  citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
  createdAt: createdAt(),
});

export type Contract = typeof contracts.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
