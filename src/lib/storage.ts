import { createSupabaseClient } from "./supabase.js";

const BUCKET_NAME = "documents";

/**
 * Upload a file to Supabase Storage documents bucket.
 * Path format: documents/{id}/{filename}
 */
export async function uploadDocument(
  buffer: Buffer,
  path: string,
  options?: { contentType?: string; upsert?: boolean }
): Promise<{ path: string; error?: string }> {
  const supabase = createSupabaseClient();

  const { data: buckets } = await supabase.storage.listBuckets();
  const bucketExists = buckets?.some((b) => b.name === BUCKET_NAME);
  if (!bucketExists) {
    await supabase.storage.createBucket(BUCKET_NAME, {
      public: false,
      fileSizeLimit: 50 * 1024 * 1024, // 50MB
    });
  }

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(path, buffer, {
      contentType: options?.contentType,
      upsert: options?.upsert ?? false,
    });

  if (error) {
    return { path: "", error: error.message };
  }
  return { path: data.path };
}

/**
 * Create a signed URL for viewing/downloading a document.
 */
export async function createSignedUrl(
  storagePath: string,
  expiresIn = 3600
): Promise<{ url: string | null; error?: string }> {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, expiresIn);

  if (error) {
    return { url: null, error: error.message };
  }
  return { url: data.signedUrl };
}

/**
 * Download a document from storage as a Buffer (for processing jobs).
 */
export async function downloadDocument(
  storagePath: string
): Promise<{ buffer: Buffer; error?: string }> {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .download(storagePath);

  if (error) {
    return { buffer: Buffer.from([]), error: error.message };
  }
  if (!data) {
    return { buffer: Buffer.from([]), error: "No data returned" };
  }
  const arrayBuffer = await data.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer) };
}

export { BUCKET_NAME };
