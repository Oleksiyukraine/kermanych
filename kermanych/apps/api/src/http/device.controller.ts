// apps/api/src/http/device.controller.ts
// The session's virtual device over REST (docs/specs/2026-11-03-mobile-device-preview.md and the
// contract table of its plan): the device row's info, the project's base-device choice, the
// «Агент» pause, «◎ Вказати» and a screenshot. The stream and the operator's input are the
// `/device` socket (ws/device.gateway.ts). Every refusal is a plain 400 message, as the preview
// routes do; an unknown session or project is a 404.
import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Put, StreamableFile } from "@nestjs/common";
import { isDevicePlatform, type DeviceChoice, type DeviceInfo, type DevicePick } from "@kermanych/core";
import { DEVICE_API, type DeviceApi } from "../device/device.contract";
import { PreviewService } from "../preview/preview.service";
import { RegistryService } from "../registry/registry.service";
import { sessionFailure } from "./session-failure";

@Controller()
export class DeviceController {
  constructor(
    @Inject(DEVICE_API) private device: DeviceApi,
    private preview: PreviewService,
    private registry: RegistryService,
  ) {}

  private session(id: string) {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new NotFoundException("session not found");
    return s;
  }

  // `platforms` are what the session's own `.kermanych/preview.json` configures, read again on
  // every call so an agent's edit shows (PreviewService reads the file the way a start does).
  @Get("sessions/:id/device")
  async info(@Param("id") id: string): Promise<DeviceInfo> {
    const s = this.session(id);
    try {
      return await this.device.info(id, s.projectId, this.preview.platformsOf(id));
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Put("projects/:id/device-choice")
  setChoice(@Param("id") id: string, @Body() b: DeviceChoice = {}): DeviceChoice {
    if (!this.registry.listProjects().some((p) => p.id === id)) throw new NotFoundException("project not found");
    if (b.platform !== undefined && !isDevicePlatform(b.platform)) throw new BadRequestException(`unknown platform ${JSON.stringify(b.platform)}`);
    for (const k of ["ios", "android"] as const) {
      if (b[k] !== undefined && typeof b[k] !== "string") throw new BadRequestException(`${k} must be a base device id`);
    }
    return this.device.setChoice(id, b);
  }

  @Put("sessions/:id/device/pause")
  setPaused(@Param("id") id: string, @Body() b: { paused?: unknown } = {}): { paused: boolean } {
    this.session(id);
    if (typeof b.paused !== "boolean") throw new BadRequestException("paused must be true or false");
    this.device.setPaused(id, b.paused);
    return { paused: this.device.paused(id) };
  }

  // `x`, `y`: fractions of the screen. `more`: the pick held Shift (the operator keeps picking).
  @Post("sessions/:id/device/pick")
  async pick(@Param("id") id: string, @Body() b: { x?: unknown; y?: unknown; more?: unknown } = {}): Promise<DevicePick> {
    this.session(id);
    const x = Number(b.x);
    const y = Number(b.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new BadRequestException("x and y must be fractions of the screen (0..1)");
    try {
      const pick = await this.device.pick(id, { x, y });
      return b.more === true ? { ...pick, more: true } : pick;
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // StreamableFile: a bare Buffer would be JSON-serialized.
  @Get("sessions/:id/device/screenshot")
  async screenshot(@Param("id") id: string): Promise<StreamableFile> {
    this.session(id);
    let png: Buffer;
    try {
      png = await this.device.screenshot(id);
    } catch (err) {
      throw sessionFailure(err);
    }
    return new StreamableFile(png, { type: "image/png", length: png.length });
  }
}
