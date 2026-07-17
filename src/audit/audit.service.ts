import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  StorePermissionKey,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

type PrismaWriter = PrismaService | Prisma.TransactionClient;

type AuditRecordInput = {
  storeId: string;
  actorId?: string | null;
  ownerId?: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  entityName?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type AuditQuery = {
  page?: unknown;
  limit?: unknown;
  action?: unknown;
  entityType?: unknown;
  actorId?: unknown;
  search?: unknown;
};

const SENSITIVE_KEY_PATTERN =
  /password|token|secret|authorization|cookie|hash|code|reset|verification|fingerprint/i;
const MAX_STRING_LENGTH = 1_000;
const MAX_ARRAY_LENGTH = 50;

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async record(tx: PrismaWriter, input: AuditRecordInput) {
    const before = this.sanitize(input.before);
    const after = this.sanitize(input.after);

    return tx.auditEvent.create({
      data: {
        storeId: input.storeId,
        actorId: input.actorId ?? null,
        ownerId: input.ownerId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        entityName: input.entityName ?? null,
        summary: input.summary,
        before: before as Prisma.InputJsonValue,
        after: after as Prisma.InputJsonValue,
        changes: this.diff(before, after) as Prisma.InputJsonValue,
        metadata: this.sanitize(input.metadata) as Prisma.InputJsonValue,
        requestId: input.requestId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async list(storeId: string, user: AuthTokenPayload, query: AuditQuery = {}) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_audit_logs,
    );

    const pagination = this.parsePagination(query);
    const where = this.buildWhere(storeId, query);
    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        select: {
          id: true,
          storeId: true,
          actorId: true,
          action: true,
          entityType: true,
          entityId: true,
          entityName: true,
          summary: true,
          createdAt: true,
          actor: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
        },
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return {
      items,
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async get(storeId: string, eventId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_audit_logs,
    );

    const event = await this.prisma.auditEvent.findFirst({
      where: { id: eventId, storeId },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Audit event not found');
    }

    return event;
  }

  private buildWhere(storeId: string, query: AuditQuery) {
    const where: Prisma.AuditEventWhereInput = { storeId };
    const action = this.optionalEnum(query.action, AuditAction, 'action');
    const entityType = this.optionalEnum(
      query.entityType,
      AuditEntityType,
      'entityType',
    );
    const actorId = this.optionalString(query.actorId, 'actorId');
    const search = this.optionalString(query.search, 'search');

    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (actorId) where.actorId = actorId;
    if (search) {
      where.OR = [
        { summary: { contains: search, mode: 'insensitive' } },
        { entityName: { contains: search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private parsePagination(query: AuditQuery) {
    const page = this.optionalPositiveInteger(query.page, 'page') ?? 1;
    const limit = Math.min(
      this.optionalPositiveInteger(query.limit, 'limit') ?? 25,
      100,
    );

    return { page, limit, skip: (page - 1) * limit };
  }

  private optionalPositiveInteger(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    return parsed;
  }

  private optionalString(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') return undefined;

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    return value.trim() || undefined;
  }

  private optionalEnum<T extends Record<string, string>>(
    value: unknown,
    enumLike: T,
    field: string,
  ) {
    if (value === undefined || value === null || value === '') return undefined;

    if (typeof value !== 'string' || !Object.values(enumLike).includes(value)) {
      throw new BadRequestException(`${field} must be valid`);
    }

    return value as T[keyof T];
  }

  private sanitize(value: unknown, key = ''): unknown {
    if (value === undefined) return null;
    if (value === null) return null;
    if (SENSITIVE_KEY_PATTERN.test(key)) return '[redacted]';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Prisma.Decimal) return value.toString();
    if (typeof value === 'string') {
      return value.length > MAX_STRING_LENGTH
        ? `${value.slice(0, MAX_STRING_LENGTH)}...`
        : value;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_ARRAY_LENGTH)
        .map((item) => this.sanitize(item, key));
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entry]) => [entryKey, this.sanitize(entry, entryKey)],
      ),
    );
  }

  private diff(before: unknown, after: unknown) {
    if (!this.isPlainObject(before) || !this.isPlainObject(after)) return null;

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of keys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes[key] = { before: before[key], after: after[key] };
      }
    }

    return Object.keys(changes).length ? changes : null;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
