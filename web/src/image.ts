const MAX_SIDE = 1800;
const RECOMPRESS_ABOVE = 1.5 * 1024 * 1024;

/**
 * Réduit les grosses captures avant l'envoi (taille max 1800 px, JPEG) pour rester sous la limite
 * des clients MCP. Les petites images (PNG compris) partent telles quelles.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= RECOMPRESS_ABOVE) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  return out && out.size < file.size ? out : file;
}
