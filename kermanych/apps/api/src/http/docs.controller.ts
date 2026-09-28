// apps/api/src/http/docs.controller.ts
import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import type { DocLinkEmbedCheck } from "@kermanych/core";
import { checkEmbeddable } from "../docs/embed-check";

// Project-independent helpers for the Project Documentation screen. The repository-backed
// routes (tree/file/raw/reindex) stay under /projects/:id because they read a bound checkout;
// this one only looks at a public URL.
@Controller("docs")
export class DocsController {
  // Whether a documentation link's page allows being framed — the screen shows the page
  // inline when it does and offers the default browser when it does not.
  @Get("embed-check")
  async embedCheck(@Query("url") url?: string): Promise<DocLinkEmbedCheck> {
    try {
      return await checkEmbeddable(url ?? "");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
}
