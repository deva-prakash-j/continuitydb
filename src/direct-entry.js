import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export function filesystemPathsEqual(left, right, { platform = process.platform } = {}) {
  if (typeof left !== "string" || !left || typeof right !== "string" || !right) return false;
  const path = platform === "win32" ? win32 : posix;
  const normalize = (value) => path.normalize(path.resolve(value));
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function isDirectEntrypoint(moduleUrl, argvPath = process.argv[1], options = {}) {
  if (!argvPath) return false;
  return filesystemPathsEqual(fileURLToPath(moduleUrl), argvPath, options);
}
