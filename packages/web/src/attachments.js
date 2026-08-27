// Client-side image-attachment pipeline for the chat composer: validates,
// downscales via canvas so the user never has to manually resize, and
// base64-encodes for the wire. Kept out of task.jsx to keep the resize loop
// out of the component.
import { MAX_IMAGES_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_RAW_BYTES, ALLOWED_IMAGE_MIME_TYPES } from '../../shared/protocol.mjs';

// Fixed per-image budget rather than dynamically re-splitting the total
// across however many attachments currently exist — simpler (no need to
// re-encode already-added images when a new one arrives) and still generous
// per image; 4 images at this budget sums to exactly the shared total.
const PER_IMAGE_BUDGET_BYTES = Math.floor(MAX_ATTACHMENT_TOTAL_RAW_BYTES / MAX_IMAGES_PER_MESSAGE);
const MIN_DIMENSION = 200;
const QUALITY_FLOOR = 0.5;
const MAX_ITERATIONS = 8;

let nextId = 1;

function encodeAtSize(bitmap, width, height, outputType, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  return new Promise(resolve => canvas.toBlob(resolve, outputType, quality));
}

// Iteratively reduces JPEG/WEBP quality, then (or for PNG, which has no
// quality knob) the longest-edge dimension, until the encoded blob fits
// under budgetBytes. Returns null if it still doesn't fit at the floor.
async function downscaleToFit(file, budgetBytes) {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width;
  let height = bitmap.height;
  const canQuality = file.type !== 'image/png';
  let quality = 0.85;
  let blob = null;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    blob = await encodeAtSize(bitmap, width, height, file.type, canQuality ? quality : undefined);
    if (blob && blob.size <= budgetBytes) return blob;
    if (canQuality && quality > QUALITY_FLOOR) {
      quality = Math.max(QUALITY_FLOOR, quality - 0.15);
    } else if (width > MIN_DIMENSION && height > MIN_DIMENSION) {
      width = Math.round(width * 0.8);
      height = Math.round(height * 0.8);
    } else {
      break;
    }
  }
  return null;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

// Returns {id, mediaType, data (base64, no data: prefix), previewUrl,
// sizeBytes, name} on success, or {id, name, error} if the file can't be
// used (wrong type, or too large even after downscaling to the floor).
export async function addAttachment(file) {
  const id = `att-${nextId++}`;
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
    return { id, name: file.name, error: `不支持的图片格式:${file.type || '未知'}` };
  }
  let blob = file;
  if (file.size > PER_IMAGE_BUDGET_BYTES) {
    blob = await downscaleToFit(file, PER_IMAGE_BUDGET_BYTES);
    if (!blob) return { id, name: file.name, error: '图片过大,无法压缩到可发送大小' };
  }
  try {
    const data = await blobToBase64(blob);
    const previewUrl = URL.createObjectURL(blob);
    return { id, mediaType: blob.type || file.type, data, previewUrl, sizeBytes: blob.size, name: file.name };
  } catch (e) {
    return { id, name: file.name, error: e.message || '图片读取失败' };
  }
}

export function revoke(attachment) {
  if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}
