import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The LayerFS commit this plugin is written against. */
export const pin = JSON.parse(readFileSync(join(PACKAGE_ROOT, "layerfs.json"), "utf8"));
