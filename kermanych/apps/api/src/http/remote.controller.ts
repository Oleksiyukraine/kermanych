import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put } from "@nestjs/common";
import type { RemotePairing, RemoteState } from "@kermanych/core";
import { relay } from "../management/coded-error";
import { RemoteService } from "../remote/remote.service";

// «Пульт» on this computer (docs/specs/2026-11-24-mobile-remote-control.md, decisions 5-7, 10):
// «Налаштування → Застосунок → Пульт» and the bottom-bar mark read and change it here, behind the
// same bearer as every route of the main api. The phone never reaches these: it talks to the
// RemoteServer (remote/remote-server.ts), a separate listener with its own whitelist. Machine-local
// like «Посіпака»: a phone pairs with THIS computer.
@Controller("remote")
export class RemoteController {
  constructor(private remote: RemoteService) {}

  @Get()
  get(): RemoteState {
    return this.remote.state();
  }

  // On answers `starting` at once; the Tailscale steps arrive as `remote_update`.
  @Put()
  update(@Body() b: { enabled?: unknown }): Promise<RemoteState> {
    if (typeof b?.enabled !== "boolean") throw new BadRequestException("enabled must be a boolean");
    return this.remote.setEnabled(b.enabled);
  }

  @Post("recheck")
  recheck(): Promise<RemoteState> {
    return this.remote.recheck();
  }

  // Linux (decision 10): the system's own password dialog through pkexec, then the checks again.
  @Post("operator")
  async operator(): Promise<RemoteState> {
    try {
      return await this.remote.setOperator();
    } catch (err) {
      relay(err);
    }
  }

  @Post("pairing")
  async pairing(): Promise<RemotePairing> {
    try {
      return await this.remote.createPairing();
    } catch (err) {
      relay(err);
    }
  }

  @Delete("devices/:id")
  removeDevice(@Param("id") id: string): RemoteState {
    try {
      return this.remote.removeDevice(id);
    } catch (err) {
      if ((err as Error).message === "device not found") throw new NotFoundException("device not found");
      relay(err);
    }
  }
}
