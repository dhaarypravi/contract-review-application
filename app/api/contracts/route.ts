import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { uploadDir } from "@/config";
import { contracts, db } from "@/db";
import { requireUserId } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { readUpload } from "@/lib/upload";
import { enqueueReview } from "@/queue";
import { deleteOwnedContract, listQuery } from "@/services/contracts";
import { MIME_TYPES } from "@/services/extract";
import { summaryOf } from "@/services/views";

export async function GET() {
  try {
    const userId = await requireUserId();
    const rows = await listQuery(userId);
    return NextResponse.json({ contracts: rows.map(summaryOf) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Validates, stores and queues. The worker does everything slow. */
export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const upload = await readUpload(request);

    const id = randomUUID();
    const directory = path.resolve(uploadDir());
    const storagePath = path.join(directory, `${id}.${upload.kind}`);
    await mkdir(directory, { recursive: true });
    await writeFile(storagePath, upload.bytes);

    try {
      const [contract] = await db
        .insert(contracts)
        .values({
          id,
          userId,
          filename: upload.filename,
          mimeType: MIME_TYPES[upload.kind],
          sizeBytes: upload.bytes.byteLength,
          storagePath,
        })
        .returning();
      await enqueueReview({ contractId: id, userId });
      return NextResponse.json({ contract: summaryOf(contract!) }, { status: 201 });
    } catch (error) {
      // Nothing will ever process this row, so do not leave it "processing".
      console.error("upload could not be queued:", error);
      await deleteOwnedContract(id, userId).catch(() => {});
      await unlink(storagePath).catch(() => {});
      throw new ValidationError("queue_unavailable", "The upload could not be queued. Please try again.", 503);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
