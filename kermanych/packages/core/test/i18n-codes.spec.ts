import { expect, test } from "vitest";
import { NOTICE_CODES, API_ERROR_CODES, MANAGEMENT_REJECTION_CODES } from "../src/i18n-codes";

// The unions and their runtime arrays are kept in lockstep at compile time (the `as const
// satisfies` + `AssertNever` guards in src/i18n-codes.ts, checked by `tsc`). What tsc cannot
// see is a member listed twice in an array — a duplicate still satisfies the union — so that
// is the invariant this test defends: a code names exactly one message, never two.
test("NOTICE_CODES has no duplicates", () => {
  expect(new Set(NOTICE_CODES).size).toBe(NOTICE_CODES.length);
});
test("API_ERROR_CODES has no duplicates", () => {
  expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
});
test("MANAGEMENT_REJECTION_CODES has no duplicates", () => {
  expect(new Set(MANAGEMENT_REJECTION_CODES).size).toBe(MANAGEMENT_REJECTION_CODES.length);
});
// A code is a wire identifier: stable, machine-read, snake_case. A stray space or capital
// would ship as a key no catalog could match, silently forcing the Ukrainian fallback.
test("every code is a non-empty snake_case identifier", () => {
  for (const code of [...NOTICE_CODES, ...API_ERROR_CODES, ...MANAGEMENT_REJECTION_CODES]) {
    expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
  }
});
test("all code catalogs are populated", () => {
  expect(NOTICE_CODES.length).toBeGreaterThan(0);
  expect(API_ERROR_CODES.length).toBeGreaterThan(0);
  expect(MANAGEMENT_REJECTION_CODES.length).toBeGreaterThan(0);
});
