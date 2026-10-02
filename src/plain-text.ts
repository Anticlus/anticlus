import { z } from 'zod';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** A bounded string with no control characters (tab, newline and carriage return are kept). */
export function plainText(min: number, max: number) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), 'control characters are not allowed');
}
