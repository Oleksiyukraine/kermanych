import { describe, expect, it } from "vitest";
import { describeDocLink, parseDocLinkUrl } from "../src/lib/doc-links";

describe("parseDocLinkUrl", () => {
  it("adds https:// to a pasted bare address", () =>
    expect(parseDocLinkUrl("  docs.google.com/document/d/abc/edit ")).toBe("https://docs.google.com/document/d/abc/edit"));
  it("keeps a host:port address instead of reading the host as a scheme", () =>
    expect(parseDocLinkUrl("localhost:3000/spec")).toBe("https://localhost:3000/spec"));
  it("refuses a script URL", () => expect(parseDocLinkUrl("javascript:alert(1)")).toBeNull());
  it("refuses a file URL", () => expect(parseDocLinkUrl("file:///etc/passwd")).toBeNull());
  it("refuses a word that is not an address", () => expect(parseDocLinkUrl("spec")).toBeNull());
  it("refuses text with spaces", () => expect(parseDocLinkUrl("https://a.com/x y")).toBeNull());
});

describe("describeDocLink", () => {
  it("frames a Google Doc editor URL through /preview, keeping the fragment", () => {
    const v = describeDocLink("https://docs.google.com/document/u/1/d/1AbC-d_9/edit?usp=sharing#heading=h.x");
    expect(v.provider).toBe("google-docs");
    expect(v.embedUrl).toBe("https://docs.google.com/document/d/1AbC-d_9/preview#heading=h.x");
  });

  it("keeps a published Google Sheet as it is", () => {
    const url = "https://docs.google.com/spreadsheets/d/e/2PACX-1v/pubhtml";
    expect(describeDocLink(url)).toMatchObject({ provider: "google-sheets", embedUrl: url });
  });

  it("embeds a Drive folder as the folder view", () =>
    expect(describeDocLink("https://drive.google.com/drive/folders/F1").embedUrl).toBe(
      "https://drive.google.com/embeddedfolderview?id=F1#list",
    ));

  it("embeds YouTube watch and short links by video id", () => {
    expect(describeDocLink("https://www.youtube.com/watch?v=vid1&t=3").embedUrl).toBe("https://www.youtube.com/embed/vid1");
    expect(describeDocLink("https://youtu.be/vid2").embedUrl).toBe("https://www.youtube.com/embed/vid2");
  });

  it("wraps a Figma design in Figma's embed page", () =>
    expect(describeDocLink("https://www.figma.com/design/KEY/Name").embedUrl).toBe(
      "https://www.figma.com/embed?embed_host=kermanych&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FKEY%2FName",
    ));

  it("moves a public Claude artifact to its claude.site embed form", () =>
    expect(describeDocLink("https://claude.ai/public/artifacts/0f-1a").embedUrl).toBe(
      "https://claude.site/public/artifacts/0f-1a/embed",
    ));

  it("labels an unknown site by its host and frames it unchanged", () =>
    expect(describeDocLink("https://www.wiki.example.com/page")).toEqual({
      provider: "web",
      label: "wiki.example.com",
      host: "wiki.example.com",
      embedUrl: "https://www.wiki.example.com/page",
    }));
});
