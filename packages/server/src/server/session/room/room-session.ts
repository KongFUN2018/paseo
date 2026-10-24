import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { RoomService } from "../../room/service.js";

export interface RoomSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface RoomSessionOptions {
  host: RoomSessionHost;
  roomService?: RoomService;
  logger: pino.Logger;
}

type RoomRequest = Extract<SessionInboundMessage, { type: `room.${string}.request` }>;

/**
 * Room RPC handlers (design §4). Mirrors ScheduleSession: translate a request
 * into a RoomService call, answer with a snapshot, and route failures to
 * rpc_error with the original requestId.
 */
export class RoomSession {
  private readonly host: RoomSessionHost;
  private readonly roomService?: RoomService;
  private readonly logger: pino.Logger;

  constructor(options: RoomSessionOptions) {
    this.host = options.host;
    this.roomService = options.roomService;
    this.logger = options.logger;
  }

  handle(request: RoomRequest): Promise<void> {
    if (!this.roomService) {
      this.emitRpcError(request, new Error("Room service is unavailable on this daemon"));
      return Promise.resolve();
    }
    return this.dispatch(request).catch((error) => this.emitRpcError(request, error));
  }

  private async dispatch(request: RoomRequest): Promise<void> {
    const service = this.roomService;
    if (!service) return;
    switch (request.type) {
      case "room.create.request": {
        const room = await service.create({
          workspaceId: request.workspaceId,
          name: request.name,
          topic: request.topic,
          moderator: request.moderator,
          members: request.members.map((member) => ({
            provider: member.provider,
            model: member.model ?? null,
            modeId: member.modeId ?? null,
            persona: member.persona,
            ...(member.displayName ? { displayName: member.displayName } : {}),
            ...(member.roleId ? { roleId: member.roleId } : {}),
          })),
          artifactPath: request.artifactPath,
          limits: request.limits,
        });
        this.host.emit({
          type: "room.create.response",
          payload: { requestId: request.requestId, roomId: room.id, error: null },
        });
        return;
      }
      case "room.list.request": {
        const rooms = await service.list();
        this.host.emit({
          type: "room.list.response",
          payload: { requestId: request.requestId, rooms, error: null },
        });
        return;
      }
      case "room.get.request": {
        const { room, truncated } = await service.get(request.roomId);
        this.host.emit({
          type: "room.get.response",
          payload: {
            requestId: request.requestId,
            room,
            truncated: room ? truncated : undefined,
            error: room ? null : `Room ${request.roomId} not found`,
          },
        });
        return;
      }
      case "room.start.request": {
        const room = await service.start(request.roomId, request.resume ?? false);
        this.host.emit({
          type: "room.start.response",
          payload: { requestId: request.requestId, room, error: null },
        });
        return;
      }
      case "room.pause.request": {
        const room = await service.pause(request.roomId);
        this.host.emit({
          type: "room.pause.response",
          payload: { requestId: request.requestId, room, error: null },
        });
        return;
      }
      case "room.resume.request": {
        const room = await service.resume(request.roomId);
        this.host.emit({
          type: "room.resume.response",
          payload: { requestId: request.requestId, room, error: null },
        });
        return;
      }
      case "room.interject.request": {
        const room = await service.interject(request.roomId, request.text);
        this.host.emit({
          type: "room.interject.response",
          payload: { requestId: request.requestId, room, error: null },
        });
        return;
      }
      case "room.close.request": {
        const room = await service.close(request.roomId);
        this.host.emit({
          type: "room.close.response",
          payload: { requestId: request.requestId, room, error: null },
        });
        return;
      }
      case "room.reopen.request": {
        const room = await service.reopen(request.roomId);
        this.host.emit({
          type: "room.reopen.response",
          payload: { requestId: request.requestId, room, error: null },
        });
        return;
      }
      // COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
      case "room.member.add.request": {
        const room = await service.addMember(request.roomId, {
          provider: request.member.provider,
          model: request.member.model ?? null,
          modeId: request.member.modeId ?? null,
          persona: request.member.persona,
          displayName: request.member.displayName,
          roleId: request.member.roleId,
        });
        this.host.emit({
          type: "room.member.add.response",
          payload: { requestId: request.requestId, room, error: null },
        });
        return;
      }
      // COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
      case "room.files.list.request": {
        const files = await service.listFiles(request.roomId);
        this.host.emit({
          type: "room.files.list.response",
          payload: { requestId: request.requestId, error: null, files },
        });
        return;
      }
    }
  }

  private emitRpcError(request: RoomRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Room request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "room_request_failed",
      },
    });
  }
}
