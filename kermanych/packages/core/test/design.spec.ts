// packages/core/test/design.spec.ts
import { expect, test } from "vitest";
import { designBrief, designReferenceLink } from "../src";

// What «+ Новий дизайн» keeps as a reference link: web addresses only, a bare host gets https,
// and a host:port is a host, not a scheme.
test("designReferenceLink keeps web addresses and refuses the rest", () => {
  expect(designReferenceLink("  https://dribbble.com/shots/1 ")).toBe("https://dribbble.com/shots/1");
  expect(designReferenceLink("http://example.com")).toBe("http://example.com/");
  expect(designReferenceLink("localhost:5173/orders")).toBe("http://localhost:5173/orders");
  expect(designReferenceLink("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
  expect(designReferenceLink("linear.app/method")).toBe("https://linear.app/method");
  expect(designReferenceLink("example.com:8080")).toBe("https://example.com:8080/");
  expect(designReferenceLink("javascript:alert(1)")).toBeUndefined();
  expect(designReferenceLink("mailto:a@b.co")).toBeUndefined();
  expect(designReferenceLink("ftp://example.com/x")).toBeUndefined();
  expect(designReferenceLink("orders")).toBeUndefined();
  expect(designReferenceLink("two words.com")).toBeUndefined();
  expect(designReferenceLink("")).toBeUndefined();
});

// The links follow the operator's text under their heading; with no links the text is untouched,
// and with no text the list stands alone (the Дизайнер's description is then just the list).
test("designBrief appends the reference links after the description", () => {
  expect(designBrief("  For managers  ", [])).toBe("For managers");
  expect(designBrief("For managers", ["https://a.com/", "https://b.com/x"])).toBe(
    "For managers\n\nReferences:\n- https://a.com/\n- https://b.com/x",
  );
  expect(designBrief(" ", ["https://a.com/"])).toBe("References:\n- https://a.com/");
});
