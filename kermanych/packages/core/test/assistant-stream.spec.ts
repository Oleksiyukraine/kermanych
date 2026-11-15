import { expect, test } from "vitest";
import { visibleProse } from "../src/assistant-stream";
import { parseCukReply } from "../src/cuk-actions";

const OPEN = "```kermanych-action\n";
const BODY = '{ "kind": "navigate", "place": "board" }';

test("prose without blocks passes through", () => {
  expect(visibleProse("Відкриваю дошку.")).toEqual({ text: "Відкриваю дошку.", acting: false });
});

test("a closed block is cut like the parser cuts it", () => {
  const raw = `Відкриваю дошку.\n\n${OPEN}${BODY}\n\`\`\`\n\nГотово.`;
  expect(visibleProse(raw)).toEqual({ text: "Відкриваю дошку.\n\nГотово.", acting: false });
  expect(visibleProse(raw).text).toBe(parseCukReply(raw).text.trimEnd());
});

test("an unclosed block hides everything from its fence and reports acting", () => {
  expect(visibleProse(`Зараз.\n\n${OPEN}{ "kind": "nav`)).toEqual({ text: "Зараз.", acting: true });
  expect(visibleProse(`Зараз.\n${OPEN.trimEnd()}`)).toEqual({ text: "Зараз.", acting: true });
});

test("a fence still being typed is held back, wherever the delta split it", () => {
  for (const cut of ["`", "``", "```", "```kerm", "```kermanych-act"])
    expect(visibleProse(`Зараз.\n${cut}`)).toEqual({ text: "Зараз.", acting: false });
  // Inline backticks inside a sentence are prose.
  expect(visibleProse("Команда `omp").text).toBe("Команда `omp");
});

test("two blocks: the first closed, the second open", () => {
  const raw = `Перше.\n${OPEN}${BODY}\n\`\`\`\nДруге.\n${OPEN}[`;
  expect(visibleProse(raw)).toEqual({ text: "Перше.\n\nДруге.", acting: true });
});

test("another language's code block is left alone", () => {
  const raw = "Приклад:\n```ts\nconst a = 1;\n```";
  expect(visibleProse(raw)).toEqual({ text: raw, acting: false });
});
