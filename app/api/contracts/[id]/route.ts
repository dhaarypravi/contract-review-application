import { unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import { loadOwnedContract, requireUserId } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { reviewQueue } from "@/queue";
import { deleteOwnedContract } from "@/services/contracts";
import { detailOf } from "@/services/views";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const userId = await requireUserId();
    const contract = await loadOwnedContract((await params).id, userId);
    return NextResponse.json({ contract: await detailOf(contract) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const storagePath = await deleteOwnedContract(id, userId);
    // Best effort from here: the row is gone, and a running job stops by itself.
    await unlink(storagePath).catch(() => {});
    await reviewQueue().remove(id).catch(() => {});
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
