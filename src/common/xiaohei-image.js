// @ts-check
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

/**
 * Get the xiaohei image as base64 data URI
 * @returns {string} Base64 data URI of the xiaohei image
 */
export const getXiaoheiImage = () => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const imagePath = join(__dirname, "../../xiaohei.webp");
    const imageBuffer = readFileSync(imagePath);
    const base64Image = imageBuffer.toString("base64");
    return `data:image/webp;base64,${base64Image}`;
  } catch (error) {
    // If image not found, return empty string
    console.error("Failed to load xiaohei image:", error);
    return "";
  }
};
