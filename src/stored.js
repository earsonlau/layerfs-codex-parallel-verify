import { stat } from "node:fs/promises";
import { refusalOf } from "./errors.js";
import { storeFile } from "./host.js";

/**
 * The Store's on-disk size, reported as `stored`.
 * One `volume.list`. If that figure is missing, one `stat` of the Store file.
 * Neither call is repeated.
 */
export async function readStored(runtime, project, statImpl = stat) {
  let stored = null;
  let storedFrom = null;
  let storedError = null;
  try {
    const volumes = await runtime.volume.list();
    const match = volumes.find((volume) => volume.owner === "this" && volume.project === project.name)
      ?? volumes.find((volume) => volume.name === project.volume);
    if (match?.size != null) {
      stored = match.size;
      storedFrom = "volume";
    }
  } catch (error) {
    storedError = refusalOf(error);
  }
  if (stored == null && project.volume) {
    const file = storeFile(runtime.settings, project.volume);
    try {
      const info = await statImpl(file);
      stored = info.size;
      storedFrom = "store-file";
      storedError = null;
    } catch (error) {
      if (!storedError) {
        storedError = { code: error.code || "Failed", message: error.message, detail: { path: file } };
      }
    }
  }
  return { stored, storedFrom, storedError };
}
