import type { FileChange, IndexedFile, LineChange } from "../shared";

export function compareFileIndexes(oldFiles: IndexedFile[], newFiles: IndexedFile[], includeUnchanged = false): FileChange[] {
  const oldMap = new Map(oldFiles.map((file) => [file.relativePath, file]));
  const newMap = new Map(newFiles.map((file) => [file.relativePath, file]));
  return [...new Set([...oldMap.keys(), ...newMap.keys()])].sort().flatMap((relativePath) => {
    const oldFile = oldMap.get(relativePath);
    const newFile = newMap.get(relativePath);
    const kind = !oldFile ? "added" : !newFile ? "deleted" : oldFile.hash === newFile.hash ? "unchanged" : "modified";
    if (kind === "unchanged" && !includeUnchanged) return [];
    return [{
      relativePath,
      kind,
      oldHash: oldFile?.hash || null,
      newHash: newFile?.hash || null,
      oldSize: oldFile?.size ?? null,
      newSize: newFile?.size ?? null,
    } satisfies FileChange];
  });
}

export function createLineDiff(oldContent: string, newContent: string): LineChange[] {
  const before = oldContent.split(/\r?\n/);
  const after = newContent.split(/\r?\n/);
  if (before.length * after.length > 1_000_000) {
    return [
      ...before.map((content, index) => ({ kind: "deleted" as const, oldLine: index + 1, newLine: null, content })),
      ...after.map((content, index) => ({ kind: "added" as const, oldLine: null, newLine: index + 1, content })),
    ];
  }
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      table[left][right] = before[left] === after[right] ? table[left + 1][right + 1] + 1 : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }
  const result: LineChange[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      result.push({ kind: "context", oldLine: left + 1, newLine: right + 1, content: before[left] }); left += 1; right += 1;
    } else if (right < after.length && (left === before.length || table[left][right + 1] >= table[left + 1][right])) {
      result.push({ kind: "added", oldLine: null, newLine: right + 1, content: after[right] }); right += 1;
    } else {
      result.push({ kind: "deleted", oldLine: left + 1, newLine: null, content: before[left] }); left += 1;
    }
  }
  return result;
}
