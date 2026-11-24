import crypto from "node:crypto";

interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}

function getCloudinaryConfig(): CloudinaryConfig | null {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) return null;
  const folder = process.env.CLOUDINARY_FOLDER?.trim() || "liquistock";
  return { cloudName, apiKey, apiSecret, folder };
}

export function isCloudinaryConfigured(): boolean {
  return getCloudinaryConfig() !== null;
}

export async function uploadImageToCloudinary(
  buffer: Buffer,
  mimetype: string,
  filename: string,
): Promise<string> {
  const cfg = getCloudinaryConfig();
  if (!cfg) {
    throw new Error("CLOUDINARY_NOT_CONFIGURED");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = filename.replace(/\.[^.]+$/, "");

  // Cloudinary SHA-1 signature requires params sorted alphabetically
  const paramsToSign = `folder=${cfg.folder}&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash("sha1")
    .update(`${paramsToSign}${cfg.apiSecret}`)
    .digest("hex");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimetype }), filename);
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", cfg.folder);
  form.append("public_id", publicId);
  form.append("signature", signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/image/upload`,
    {
      method: "POST",
      body: form,
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`CLOUDINARY_UPLOAD_FAILED (${response.status}): ${detail.slice(0, 200)}`);
  }

  const data = (await response.json()) as { secure_url?: string };
  if (!data.secure_url) {
    throw new Error("CLOUDINARY_MISSING_URL");
  }
  return data.secure_url;
}
