export const MAX_HTTP_BODY_BYTES = 32 * 1024 * 1024;

export async function readLimitedBody(
  response: Response,
  limit = MAX_HTTP_BODY_BYTES,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared != null && declared !== "") {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0 || size > limit) {
      throw new Error(`response exceeds ${limit} bytes`);
    }
  }
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > limit) throw new Error(`response exceeds ${limit} bytes`);
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new Error(`response exceeds ${limit} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
