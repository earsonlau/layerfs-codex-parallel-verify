import { UsageError } from "./errors.js";

/** Same shape LayerFS uses for a project name, which a Branch name must fit. */
export const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;

export const MAX_CANDIDATES = 256;
export const SANDBOX_CAPACITY = 16;
export const MESSAGE_BYTES = 4096;

export function assertName(name, what) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new UsageError(`${what} must be 1–63 characters of lowercase letters, digits, "_", ".", or "-", and start and end with a letter or digit`);
  }
  return name;
}

export function candidateNames(prefix, count) {
  assertName(prefix, "a branch prefix");
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CANDIDATES) {
    throw new UsageError(`--count must be a whole number from 1 to ${MAX_CANDIDATES}`);
  }
  const names = [];
  for (let index = 1; index <= count; index += 1) {
    const name = `${prefix}-${index}`;
    if (!NAME.test(name)) {
      throw new UsageError(`branch name ${name} does not fit LayerFS's name rule; use a shorter prefix`);
    }
    names.push(name);
  }
  return names;
}

/** A Commit message stays inside the SDK's 4096-byte limit. */
export function boundedMessage(prefix, body, suffix) {
  let text = `${prefix}${body}${suffix}`;
  while (Buffer.byteLength(text) > MESSAGE_BYTES && body.length > 0) {
    body = body.slice(0, -1);
    text = `${prefix}${body}${suffix}`;
  }
  return text;
}

export function verifyMessage(branch, command, exitCode) {
  return boundedMessage(`verify ${branch}: `, command, ` (exit ${exitCode})`);
}
