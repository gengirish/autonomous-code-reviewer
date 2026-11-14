"use strict";

const path = require("node:path");
const { exec } = require("node:child_process");
const { promisify } = require("node:util");

const execAsync = promisify(exec);

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/var/app/uploads";
const THUMB_DIR = path.join(UPLOAD_DIR, "thumbs");
const ALLOWED_WIDTHS = new Set([64, 128, 256, 512]);

/**
 * Writes a JPEG thumbnail of an uploaded image using ImageMagick.
 *
 * @param {string} fileName name of the stored upload inside UPLOAD_DIR
 * @param {number} width target width in pixels, one of ALLOWED_WIDTHS
 * @returns {Promise<string>} absolute path of the thumbnail
 */
async function createThumbnail(fileName, width) {
  if (!ALLOWED_WIDTHS.has(width)) {
    throw new RangeError(`unsupported thumbnail width: ${width}`);
  }
  const source = path.join(UPLOAD_DIR, fileName);
  const target = path.join(THUMB_DIR, `${width}-${path.parse(fileName).name}.jpg`);
  await execAsync(`convert "${source}" -auto-orient -thumbnail ${width}x -strip "${target}"`, { timeout: 15_000 });
  return target;
}

module.exports = { createThumbnail, ALLOWED_WIDTHS };
