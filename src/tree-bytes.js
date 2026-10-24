import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** One shell command. Measures regular files in the Workspace, links not followed. */
export const SIZE_PROBE = "node -e 'const fs=require(\"fs\");const path=require(\"path\");let b=0;const stack=[\".\"];while(stack.length){const d=stack.pop();for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(d,e.name);if(e.isDirectory())stack.push(p);else if(e.isFile())b+=fs.statSync(p).size}}process.stdout.write(String(b))'";

export function parseByteCount(text) {
  const match = /^\d+$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isSafeInteger(value) ? value : null;
}

/** Bytes of regular files under `root`. Symlinks are not followed. One walk. */
export async function treeBytes(root) {
  let bytes = 0;
  let files = 0;
  let skipped = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile()) {
        try {
          bytes += (await lstat(path)).size;
          files += 1;
        } catch {
          skipped += 1;
        }
      }
    }
  }
  return { bytes, files, skipped };
}
