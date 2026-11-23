import { MAX_UPLOAD_BYTES } from "@/limits";
import { sniffKind, type FileKind } from "@/services/extract";
import { ValidationError } from "./errors";

const ENVELOPE_BYTES = 1024 * 1024; // room for the multipart headers

const tooLarge = () => new ValidationError("file_too_large", "The file is larger than 20 MB.", 413);

export interface Upload {
  filename: string;
  bytes: Uint8Array;
  kind: FileKind;
}

/** Reads and validates the one file in a multipart request. */
export async function readUpload(request: Request): Promise<Upload> {
  const limit = MAX_UPLOAD_BYTES + ENVELOPE_BYTES;
  if (Number(request.headers.get("content-length")) > limit) throw tooLarge();

  let form: FormData;
  let exceeded = false;
  try {
    // content-length can be absent or wrong, so count what actually arrives.
    let received = 0;
    const counted = request.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(piece, controller) {
          received += piece.byteLength;
          if (received > limit) {
            exceeded = true;
            controller.error(new Error("too large"));
          } else controller.enqueue(piece);
        },
      }),
    );
    form = await new Response(counted, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    if (exceeded) throw tooLarge();
    throw new ValidationError("invalid_upload", "Send the contract as a file in a multipart form.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("no_file", "Choose a file to upload.");
  if (file.size > MAX_UPLOAD_BYTES) throw tooLarge();
  if (file.size === 0) throw new ValidationError("empty_file", "The file is empty.", 422);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffKind(bytes);
  if (!kind) throw new ValidationError("unsupported_type", "Upload a PDF, DOCX or TXT file.", 415);
  return { filename: cleanFilename(file.name), bytes, kind };
}

/** Display only: the file is stored under its contract id, never under this name. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 255) || "contract";
}
