import { Controller, Get } from "@nestjs/common";
import { RegistryService } from "../registry/registry.service";

@Controller("cloud")
export class CloudController {
  constructor(private reg: RegistryService) {}

  // How many status pushes this machine still owes the cloud. The board renders a distinct
  // indicator for it: the browser's Realtime channel can be healthy while our own pushes are
  // stuck (expired token, blocked host), and only this process can see that.
  @Get("outbox")
  outbox(): { pending: number } {
    return { pending: this.reg.listOutbox().length };
  }
}
