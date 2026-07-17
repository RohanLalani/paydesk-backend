import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AuditAction,
  AuditEntityType,
  MultiPackProposalAction,
  MultiPackProposalStatus,
  MultiPackStatus,
  MultiPackType,
  Prisma,
  StaffRole,
  StorePermissionKey,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

const MAX_UNITS_PER_PACK = 10_000;
const MAX_REJECTION_LENGTH = 500;
const MAX_BULK_APPROVAL_PROPOSALS = 500;
const BULK_APPROVAL_FAILURE_MESSAGE =
  'Some multi-pack changes need attention before they can be sent.';

type ProductCostInput = {
  unitCostAfterDiscountAndRebate: number | null;
  unitCost: number | null;
  caseCost: number | null;
  unitsPerCase: number | null;
};

@Injectable()
export class MultiPackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    private readonly audit: AuditService,
  ) {}

  async listProductMultiPacks(
    storeId: string,
    productId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanSubmit(storeId, user);
    const active =
      query.active === undefined
        ? true
        : this.requiredBoolean(query.active, 'active');

    return this.prisma.productMultiPack.findMany({
      where: {
        storeId,
        productId,
        ...(active ? { isActive: true, status: MultiPackStatus.ACTIVE } : {}),
      },
      orderBy: [{ type: 'asc' }, { unitsPerPack: 'asc' }],
    });
  }

  async findByCaseBarcode(
    storeId: string,
    barcodeValue: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.process_sales,
    );
    const barcode = this.validateBarcode(barcodeValue, 'barcode');
    const multiPack = await this.prisma.productMultiPack.findFirst({
      where: {
        storeId,
        caseBarcode: barcode,
        isActive: true,
        status: MultiPackStatus.ACTIVE,
      },
      include: {
        product: {
          include: {
            department: true,
            tax: true,
          },
        },
      },
    });

    if (!multiPack) {
      throw new NotFoundException('Multi-pack not found');
    }

    return {
      id: multiPack.id,
      type: multiPack.type,
      unitsPerPack: multiPack.unitsPerPack,
      caseBarcode: multiPack.caseBarcode,
      multiPackRetail: multiPack.multiPackRetail.toString(),
      product: {
        id: multiPack.product.id,
        productNumber: multiPack.product.productNumber,
        barcode: multiPack.product.barcode,
        name: multiPack.product.name,
        taxStyle: multiPack.product.taxStyle,
        tax: multiPack.product.tax,
        department: multiPack.product.department,
      },
    };
  }

  async listProposals(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanReview(storeId, user);
    const pagination = this.parsePagination(query);
    const status = this.optionalEnum(
      query.status,
      MultiPackProposalStatus,
      MultiPackProposalStatus.PENDING,
      'status',
    );
    const action = this.optionalEnum(
      query.action,
      MultiPackProposalAction,
      undefined,
      'action',
    );
    const type = this.optionalEnum(
      query.type,
      MultiPackType,
      undefined,
      'type',
    );
    const search = this.optionalString(query.search, 'search');

    const where: Prisma.MultiPackProposalWhereInput = {
      storeId,
      ...(status ? { status } : {}),
      ...(action ? { action } : {}),
      ...(type ? { proposedType: type } : {}),
      ...(search
        ? {
            OR: [
              {
                proposedCaseBarcode: { contains: search, mode: 'insensitive' },
              },
              {
                product: { barcode: { contains: search, mode: 'insensitive' } },
              },
              { product: { name: { contains: search, mode: 'insensitive' } } },
              ...(this.isPositiveIntegerText(search)
                ? [{ product: { productNumber: Number(search) } }]
                : []),
            ],
          }
        : {}),
    };

    const orderBy =
      status === MultiPackProposalStatus.PENDING
        ? { submittedAt: 'asc' as const }
        : { submittedAt: 'desc' as const };

    const [items, total] = await Promise.all([
      this.prisma.multiPackProposal.findMany({
        where,
        orderBy,
        skip: pagination.skip,
        take: pagination.limit,
        include: this.proposalInclude,
      }),
      this.prisma.multiPackProposal.count({ where }),
    ]);

    return {
      items: items.map((item) => this.serializeProposal(item)),
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async getProposal(
    storeId: string,
    proposalId: string,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanSubmit(storeId, user);
    const proposal = await this.prisma.multiPackProposal.findFirst({
      where: { id: proposalId, storeId },
      include: this.proposalInclude,
    });

    if (!proposal) {
      throw new NotFoundException('Multi-pack proposal not found');
    }

    return this.serializeProposal(proposal);
  }

  async submitProposal(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanSubmit(storeId, user);
    const dto = this.parseProposalBody(body);
    const product = await this.findProductOrThrow(storeId, dto.productId);
    const target = dto.targetMultiPackId
      ? await this.findMultiPackOrThrow(storeId, dto.targetMultiPackId)
      : null;

    if (dto.action !== MultiPackProposalAction.CREATE && !target) {
      throw new BadRequestException(
        'An active multi-pack is required for this action',
      );
    }

    if (dto.action === MultiPackProposalAction.CREATE && target) {
      throw new BadRequestException(
        'New multi-pack proposals cannot target an existing configuration',
      );
    }

    if (dto.type === MultiPackType.CASE_SALE) {
      await this.ensureCaseBarcodeAvailable(
        storeId,
        dto.caseBarcode,
        product.id,
        null,
      );
    }

    await this.ensureNoDuplicatePending(storeId, dto);

    const snapshots = this.calculateSnapshots(
      product,
      dto.unitsPerPack,
      dto.multiPackRetail,
    );

    const proposal = await this.prisma.$transaction(async (tx) => {
      const created = await tx.multiPackProposal.create({
        data: {
          storeId,
          productId: product.id,
          targetMultiPackId: target?.id ?? null,
          action: dto.action,
          proposedType: dto.type,
          proposedUnitsPerPack: dto.unitsPerPack,
          proposedCaseBarcode:
            dto.type === MultiPackType.CASE_SALE ? dto.caseBarcode : null,
          proposedMultiPackRetail: dto.multiPackRetail,
          unitCostSnapshot: snapshots.unitCost,
          aggregateCostSnapshot: snapshots.aggregateCost,
          marginSnapshot: snapshots.margin,
          multiPackVersionSnapshot: target?.version ?? null,
          submittedByActorId: user.staffId,
        },
        include: this.proposalInclude,
      });

      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        ownerId: user.type === StaffRole.owner ? user.accountId : null,
        action: AuditAction.proposal_submitted,
        entityType: AuditEntityType.multi_pack_proposal,
        entityId: created.id,
        entityName: product.name,
        summary: `Submitted multi-pack proposal for ${product.name}`,
        after: created,
        metadata: { source: 'multi_pack_pricing' },
      });

      return created;
    });

    return this.serializeProposal(proposal);
  }

  async updateProposal(
    storeId: string,
    proposalId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanSubmit(storeId, user);
    const dto = this.parseProposalBody(body);

    return this.prisma.$transaction(async (tx) => {
      const proposal = await tx.multiPackProposal.findFirst({
        where: { id: proposalId, storeId },
        include: this.proposalInclude,
      });

      if (!proposal) {
        throw new NotFoundException('Multi-pack proposal not found');
      }

      if (proposal.status !== MultiPackProposalStatus.PENDING) {
        throw new ConflictException(
          'Only pending multi-pack proposals can be edited.',
        );
      }

      if (proposal.productId !== dto.productId) {
        throw new BadRequestException(
          'The selected product does not match this proposal.',
        );
      }

      const product = await tx.product.findFirst({
        where: { id: dto.productId, storeId, isActive: true },
        include: {
          department: true,
          productCategory: true,
        },
      });

      if (!product) {
        throw new NotFoundException('Product not found');
      }

      const target = dto.targetMultiPackId
        ? await tx.productMultiPack.findFirst({
            where: { id: dto.targetMultiPackId, storeId },
          })
        : null;

      if (dto.action !== MultiPackProposalAction.CREATE && !target) {
        throw new BadRequestException(
          'An active multi-pack is required for this action',
        );
      }

      if (dto.action === MultiPackProposalAction.CREATE && target) {
        throw new BadRequestException(
          'New multi-pack proposals cannot target an existing configuration',
        );
      }

      if (dto.type === MultiPackType.CASE_SALE) {
        await this.ensureCaseBarcodeAvailable(
          storeId,
          dto.caseBarcode,
          product.id,
          target?.id ?? null,
          tx,
          proposal.id,
        );
      }

      await this.ensureNoDuplicatePending(storeId, dto, proposal.id, tx);

      const snapshots = this.calculateSnapshots(
        product,
        dto.unitsPerPack,
        dto.multiPackRetail,
      );

      const updated = await tx.multiPackProposal.update({
        where: { id: proposal.id },
        data: {
          targetMultiPackId: target?.id ?? null,
          action: dto.action,
          proposedType: dto.type,
          proposedUnitsPerPack: dto.unitsPerPack,
          proposedCaseBarcode:
            dto.type === MultiPackType.CASE_SALE ? dto.caseBarcode : null,
          proposedMultiPackRetail: dto.multiPackRetail,
          unitCostSnapshot: snapshots.unitCost,
          aggregateCostSnapshot: snapshots.aggregateCost,
          marginSnapshot: snapshots.margin,
          multiPackVersionSnapshot: target?.version ?? null,
        },
        include: this.proposalInclude,
      });

      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        ownerId: user.type === StaffRole.owner ? user.accountId : null,
        action: AuditAction.proposal_updated,
        entityType: AuditEntityType.multi_pack_proposal,
        entityId: updated.id,
        entityName: product.name,
        summary: `Updated pending multi-pack proposal for ${product.name}`,
        before: proposal,
        after: updated,
        metadata: { source: 'multi_pack_pricing' },
      });

      return this.serializeProposal(updated);
    });
  }

  async approveProposal(
    storeId: string,
    proposalId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanReview(storeId, user);
    const reviewNote = this.optionalString(body.reviewNote, 'reviewNote');

    return this.prisma.$transaction(async (tx) => {
      const proposal = await tx.multiPackProposal.findFirst({
        where: { id: proposalId, storeId },
        include: this.proposalInclude,
      });

      if (!proposal) {
        throw new NotFoundException('Multi-pack proposal not found');
      }

      const { reviewed } = await this.applyPendingProposal(
        tx,
        storeId,
        proposal,
        user,
        reviewNote,
      );

      return this.serializeProposal(reviewed);
    });
  }

  async approveAllPendingProposals(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanReview(storeId, user);
    const requestedProposalIds = this.optionalStringArray(
      body.proposalIds,
      'proposalIds',
    );
    const where: Prisma.MultiPackProposalWhereInput = {
      storeId,
      status: MultiPackProposalStatus.PENDING,
      ...(requestedProposalIds ? { id: { in: requestedProposalIds } } : {}),
    };
    const pendingCount = await this.prisma.multiPackProposal.count({ where });

    if (pendingCount > MAX_BULK_APPROVAL_PROPOSALS) {
      throw new BadRequestException(
        `A maximum of ${MAX_BULK_APPROVAL_PROPOSALS} pending multi-pack changes can be sent to POS at once.`,
      );
    }

    if (pendingCount === 0) {
      return {
        approvedCount: 0,
        failedCount: 0,
        approvedProposalIds: [],
        failures: [],
      };
    }

    const batchId = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const lockedRows = requestedProposalIds
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "MultiPackProposal"
            WHERE "storeId" = ${storeId}
              AND "status" = 'PENDING'
              AND "id" IN (${Prisma.join(requestedProposalIds)})
            ORDER BY "submittedAt" ASC
            FOR UPDATE
          `
        : await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "MultiPackProposal"
            WHERE "storeId" = ${storeId}
              AND "status" = 'PENDING'
            ORDER BY "submittedAt" ASC
            FOR UPDATE
          `;
      const lockedIds = lockedRows.map((row) => row.id);

      if (lockedIds.length !== pendingCount) {
        throw new ConflictException(
          'Pending multi-pack changes were updated while this batch was being sent. Please refresh and try again.',
        );
      }

      const proposals = await tx.multiPackProposal.findMany({
        where: { id: { in: lockedIds }, storeId },
        include: this.proposalInclude,
      });
      const proposalsById = new Map(
        proposals.map((proposal) => [proposal.id, proposal]),
      );
      const orderedProposals = lockedIds.map((id) => proposalsById.get(id)!);
      const approvedProposalIds: string[] = [];

      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        ownerId: user.type === StaffRole.owner ? user.accountId : null,
        action: AuditAction.multi_pack_batch_sent_to_pos,
        entityType: AuditEntityType.multi_pack_batch,
        entityId: batchId,
        entityName: 'Multi-pack POS batch',
        summary: `${pendingCount} multi-pack changes sent to POS`,
        metadata: {
          batchId,
          storeId,
          reviewerId: user.staffId,
          approvedCount: pendingCount,
          maxBatchSize: MAX_BULK_APPROVAL_PROPOSALS,
          sentAt: new Date().toISOString(),
        },
      });

      for (const proposal of orderedProposals) {
        try {
          const { reviewed } = await this.applyPendingProposal(
            tx,
            storeId,
            proposal,
            user,
            null,
            batchId,
          );
          approvedProposalIds.push(reviewed.id);
        } catch (error) {
          throw new BadRequestException({
            message: BULK_APPROVAL_FAILURE_MESSAGE,
            issues: [
              {
                proposalId: proposal.id,
                productName: proposal.product.name,
                reason: this.toFriendlyBulkIssue(error),
              },
            ],
          });
        }
      }

      return {
        approvedCount: approvedProposalIds.length,
        failedCount: 0,
        approvedProposalIds,
        failures: [],
      };
    });
  }

  async rejectProposal(
    storeId: string,
    proposalId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanReview(storeId, user);
    const reason = this.requiredString(body.reason, 'reason');

    if (reason.length > MAX_REJECTION_LENGTH) {
      throw new BadRequestException('reason must be 500 characters or fewer');
    }

    return this.prisma.$transaction(async (tx) => {
      const proposal = await tx.multiPackProposal.findFirst({
        where: { id: proposalId, storeId },
        include: this.proposalInclude,
      });

      if (!proposal) {
        throw new NotFoundException('Multi-pack proposal not found');
      }

      if (proposal.status !== MultiPackProposalStatus.PENDING) {
        throw new ConflictException('This proposal has already been reviewed.');
      }

      const rejected = await tx.multiPackProposal.update({
        where: { id: proposal.id },
        data: {
          status: MultiPackProposalStatus.REJECTED,
          reviewedByActorId: user.staffId,
          reviewedAt: new Date(),
          rejectionReason: reason,
        },
        include: this.proposalInclude,
      });

      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        ownerId: user.type === StaffRole.owner ? user.accountId : null,
        action: AuditAction.proposal_rejected,
        entityType: AuditEntityType.multi_pack_proposal,
        entityId: rejected.id,
        entityName: rejected.product.name,
        summary: `Rejected multi-pack proposal for ${rejected.product.name}`,
        before: proposal,
        after: rejected,
        metadata: { reason },
      });

      return this.serializeProposal(rejected);
    });
  }

  async listLogs(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_audit_logs,
    );
    const pagination = this.parsePagination(query);
    const where: Prisma.AuditEventWhereInput = {
      storeId,
      entityType: {
        in: [
          AuditEntityType.multi_pack,
          AuditEntityType.multi_pack_proposal,
          AuditEntityType.multi_pack_batch,
        ],
      },
    };
    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          entityName: true,
          summary: true,
          metadata: true,
          createdAt: true,
          actor: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return { items, total, page: pagination.page, limit: pagination.limit };
  }

  private async writeActiveAudit(
    tx: Prisma.TransactionClient,
    storeId: string,
    user: AuthTokenPayload,
    before: unknown,
    after: unknown,
    productName: string,
    action: AuditAction,
  ) {
    await this.audit.record(tx, {
      storeId,
      actorId: user.staffId,
      ownerId: user.type === StaffRole.owner ? user.accountId : null,
      action,
      entityType: AuditEntityType.multi_pack,
      entityId: (after as { id?: string })?.id ?? null,
      entityName: productName,
      summary: `Updated active multi-pack configuration for ${productName}`,
      before,
      after,
    });
  }

  private async applyPendingProposal(
    tx: Prisma.TransactionClient,
    storeId: string,
    proposal: ProposalWithProduct,
    user: AuthTokenPayload,
    reviewNote: string | null,
    batchId?: string,
  ) {
    if (proposal.status !== MultiPackProposalStatus.PENDING) {
      throw new ConflictException('This proposal has already been reviewed.');
    }

    if (
      proposal.submittedByActorId === user.staffId &&
      user.type !== StaffRole.owner
    ) {
      throw new ForbiddenException(
        'You do not have permission to approve your own multi-pack proposal.',
      );
    }

    const product = await tx.product.findFirst({
      where: { id: proposal.productId, storeId, isActive: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const currentTarget = proposal.targetMultiPackId
      ? await tx.productMultiPack.findFirst({
          where: { id: proposal.targetMultiPackId, storeId },
        })
      : null;

    if (
      proposal.targetMultiPackId &&
      (!currentTarget ||
        currentTarget.version !== proposal.multiPackVersionSnapshot)
    ) {
      throw new ConflictException(
        'This proposal changed after it was submitted. Please submit it again.',
      );
    }

    if (proposal.proposedType === MultiPackType.CASE_SALE) {
      await this.ensureCaseBarcodeAvailable(
        storeId,
        proposal.proposedCaseBarcode,
        product.id,
        currentTarget?.id ?? null,
        tx,
        proposal.id,
      );
    }

    await this.ensureNoActiveDuplicateForApproval(
      storeId,
      proposal,
      currentTarget?.id ?? null,
      tx,
    );

    const snapshots = this.calculateSnapshots(
      product,
      proposal.proposedUnitsPerPack,
      proposal.proposedMultiPackRetail,
    );

    let active = currentTarget;
    const approvedAt = new Date();
    const activeData = {
      type: proposal.proposedType,
      unitsPerPack: proposal.proposedUnitsPerPack,
      caseBarcode:
        proposal.proposedType === MultiPackType.CASE_SALE
          ? proposal.proposedCaseBarcode
          : null,
      multiPackRetail: proposal.proposedMultiPackRetail,
      aggregateCostSnapshot: snapshots.aggregateCost,
      marginSnapshot: snapshots.margin,
      approvedFromProposalId: proposal.id,
      approvedByActorId: user.staffId,
      approvedAt,
    };

    if (proposal.action === MultiPackProposalAction.CREATE) {
      active = await tx.productMultiPack.create({
        data: {
          storeId,
          productId: product.id,
          ...activeData,
          status: MultiPackStatus.ACTIVE,
          isActive: true,
        },
      });
      await this.writeActiveAudit(
        tx,
        storeId,
        user,
        null,
        active,
        product.name,
        AuditAction.multi_pack_created,
      );
    } else if (proposal.action === MultiPackProposalAction.UPDATE && active) {
      const before = active;
      active = await tx.productMultiPack.update({
        where: { id: active.id },
        data: {
          ...activeData,
          status: MultiPackStatus.ACTIVE,
          isActive: true,
          version: { increment: 1 },
        },
      });
      await this.writeActiveAudit(
        tx,
        storeId,
        user,
        before,
        active,
        product.name,
        AuditAction.multi_pack_updated,
      );
    } else if (
      proposal.action === MultiPackProposalAction.DEACTIVATE &&
      active
    ) {
      const before = active;
      active = await tx.productMultiPack.update({
        where: { id: active.id },
        data: {
          status: MultiPackStatus.INACTIVE,
          isActive: false,
          approvedFromProposalId: proposal.id,
          approvedByActorId: user.staffId,
          approvedAt,
          version: { increment: 1 },
        },
      });
      await this.writeActiveAudit(
        tx,
        storeId,
        user,
        before,
        active,
        product.name,
        AuditAction.multi_pack_deactivated,
      );
    } else if (
      proposal.action === MultiPackProposalAction.REACTIVATE &&
      active
    ) {
      const before = active;
      active = await tx.productMultiPack.update({
        where: { id: active.id },
        data: {
          ...activeData,
          status: MultiPackStatus.ACTIVE,
          isActive: true,
          version: { increment: 1 },
        },
      });
      await this.writeActiveAudit(
        tx,
        storeId,
        user,
        before,
        active,
        product.name,
        AuditAction.multi_pack_reactivated,
      );
    } else {
      throw new ConflictException(
        'This proposal no longer matches an active multi-pack configuration.',
      );
    }

    const reviewed = await tx.multiPackProposal.update({
      where: { id: proposal.id },
      data: {
        status: MultiPackProposalStatus.APPROVED,
        reviewedByActorId: user.staffId,
        reviewedAt: approvedAt,
        reviewNote,
      },
      include: this.proposalInclude,
    });

    await this.audit.record(tx, {
      storeId,
      actorId: user.staffId,
      ownerId: user.type === StaffRole.owner ? user.accountId : null,
      action: AuditAction.proposal_approved,
      entityType: AuditEntityType.multi_pack_proposal,
      entityId: reviewed.id,
      entityName: product.name,
      summary: `Approved multi-pack proposal for ${product.name}`,
      before: proposal,
      after: reviewed,
      metadata: { activeMultiPackId: active?.id ?? null, reviewNote, batchId },
    });

    return { reviewed, active, product };
  }

  private async ensureCanSubmit(storeId: string, user: AuthTokenPayload) {
    return this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_multi_pack_pricing,
    );
  }

  private async ensureCanReview(storeId: string, user: AuthTokenPayload) {
    return this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.review_multi_pack_pricing,
    );
  }

  private async findProductOrThrow(storeId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, storeId, isActive: true },
      include: {
        department: true,
        productCategory: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  private async findMultiPackOrThrow(storeId: string, multiPackId: string) {
    const multiPack = await this.prisma.productMultiPack.findFirst({
      where: { id: multiPackId, storeId },
    });

    if (!multiPack) {
      throw new NotFoundException('Multi-pack not found');
    }

    return multiPack;
  }

  private async ensureCaseBarcodeAvailable(
    storeId: string,
    barcode: string | null,
    productId: string,
    allowedMultiPackId: string | null,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
    allowedProposalId: string | null = null,
  ) {
    if (!barcode) {
      throw new BadRequestException('Case barcode is required for case sales.');
    }

    const primaryProduct = await tx.product.findFirst({
      where: { storeId, barcode },
      select: { id: true },
    });

    if (primaryProduct) {
      if (primaryProduct.id === productId) {
        throw new ConflictException(
          'Case barcode cannot match the base product barcode.',
        );
      }

      throw new ConflictException(
        'This case barcode is already in use in this store.',
      );
    }

    const activeCase = await tx.productMultiPack.findFirst({
      where: {
        storeId,
        caseBarcode: barcode,
        isActive: true,
        ...(allowedMultiPackId ? { id: { not: allowedMultiPackId } } : {}),
      },
      select: { id: true },
    });

    if (activeCase) {
      throw new ConflictException(
        'This case barcode is already in use in this store.',
      );
    }

    const pendingCase = await tx.multiPackProposal.findFirst({
      where: {
        storeId,
        proposedCaseBarcode: barcode,
        status: MultiPackProposalStatus.PENDING,
        ...(allowedProposalId ? { id: { not: allowedProposalId } } : {}),
        ...(allowedMultiPackId
          ? { targetMultiPackId: { not: allowedMultiPackId } }
          : {}),
      },
      select: { id: true },
    });

    if (pendingCase) {
      throw new ConflictException(
        'This case barcode is already in use in this store.',
      );
    }
  }

  private async ensureNoDuplicatePending(
    storeId: string,
    dto: ProposalDto,
    excludedProposalId: string | null = null,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const duplicate = await tx.multiPackProposal.findFirst({
      where: {
        storeId,
        productId: dto.productId,
        ...(excludedProposalId ? { id: { not: excludedProposalId } } : {}),
        targetMultiPackId: dto.targetMultiPackId ?? null,
        action: dto.action,
        status: MultiPackProposalStatus.PENDING,
        proposedType: dto.type,
        proposedUnitsPerPack: dto.unitsPerPack,
        proposedCaseBarcode:
          dto.type === MultiPackType.CASE_SALE ? dto.caseBarcode : null,
        proposedMultiPackRetail: dto.multiPackRetail,
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException(
        'An identical multi-pack proposal is already waiting for review.',
      );
    }
  }

  private async ensureNoActiveDuplicateForApproval(
    storeId: string,
    proposal: {
      productId: string;
      proposedType: MultiPackType;
      proposedUnitsPerPack: number;
      proposedCaseBarcode: string | null;
    },
    allowedMultiPackId: string | null,
    tx: Prisma.TransactionClient,
  ) {
    const duplicate = await tx.productMultiPack.findFirst({
      where: {
        storeId,
        productId: proposal.productId,
        type: proposal.proposedType,
        unitsPerPack: proposal.proposedUnitsPerPack,
        caseBarcode:
          proposal.proposedType === MultiPackType.CASE_SALE
            ? proposal.proposedCaseBarcode
            : null,
        isActive: true,
        ...(allowedMultiPackId ? { id: { not: allowedMultiPackId } } : {}),
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException(
        'This multi-pack configuration is already active.',
      );
    }
  }

  private calculateSnapshots(
    product: ProductCostInput,
    unitsPerPack: number,
    retail: Prisma.Decimal,
  ) {
    const unitCost = this.resolveUnitCost(product);
    const aggregateCost = unitCost ? unitCost.mul(unitsPerPack) : null;
    const margin =
      aggregateCost && !retail.equals(0)
        ? retail.minus(aggregateCost).div(retail).mul(100)
        : null;

    return { unitCost, aggregateCost, margin };
  }

  private resolveUnitCost(product: ProductCostInput) {
    if (product.unitCostAfterDiscountAndRebate !== null) {
      return new Prisma.Decimal(product.unitCostAfterDiscountAndRebate);
    }

    if (product.unitCost !== null) {
      return new Prisma.Decimal(product.unitCost);
    }

    if (
      product.caseCost !== null &&
      product.unitsPerCase !== null &&
      product.unitsPerCase > 0
    ) {
      return new Prisma.Decimal(product.caseCost).div(product.unitsPerCase);
    }

    return null;
  }

  private parseProposalBody(body: Record<string, unknown>): ProposalDto {
    const type = this.requiredEnum(body.type, MultiPackType, 'type');
    const action = this.requiredEnum(
      body.action ?? MultiPackProposalAction.CREATE,
      MultiPackProposalAction,
      'action',
    );
    const caseBarcode =
      type === MultiPackType.CASE_SALE
        ? this.validateBarcode(body.caseBarcode, 'caseBarcode')
        : null;

    return {
      productId: this.requiredString(body.productId, 'productId'),
      targetMultiPackId: this.optionalString(
        body.targetMultiPackId,
        'targetMultiPackId',
      ),
      action,
      type,
      unitsPerPack: this.requiredUnits(body.unitsPerPack),
      caseBarcode,
      multiPackRetail: this.requiredCurrency(
        body.multiPackRetail,
        'multiPackRetail',
      ),
    };
  }

  private requiredUnits(value: unknown) {
    const text = this.requiredString(value, 'unitsPerPack');

    if (!/^\d+$/.test(text)) {
      throw new BadRequestException(
        'Number of units in pack must be a whole number.',
      );
    }

    const parsed = Number(text);

    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 2 ||
      parsed > MAX_UNITS_PER_PACK
    ) {
      throw new BadRequestException(
        'Number of units in pack must be between 2 and 10000.',
      );
    }

    return parsed;
  }

  private requiredCurrency(value: unknown, field: string) {
    const text = this.requiredString(value, field);

    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
      throw new BadRequestException(
        `${field} must be a valid currency amount.`,
      );
    }

    return new Prisma.Decimal(text);
  }

  private validateBarcode(value: unknown, field: string) {
    const barcode = this.requiredString(value, field)
      .replace(/[\r\n\t]+$/g, '')
      .trim();

    if (barcode.length > 64) {
      throw new BadRequestException(`${field} must be 64 characters or fewer`);
    }

    if (/\s/.test(barcode)) {
      throw new BadRequestException(`${field} cannot contain spaces`);
    }

    if (!/^[\x21-\x7e]+$/.test(barcode)) {
      throw new BadRequestException(`${field} contains unsupported characters`);
    }

    if (/^\d+$/.test(barcode) && [8, 12, 13].includes(barcode.length)) {
      const digits = [...barcode].map((digit) => Number(digit));
      const checkDigit = digits.pop();
      const sum = digits
        .reverse()
        .reduce(
          (total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1),
          0,
        );
      const expected = (10 - (sum % 10)) % 10;

      if (checkDigit !== expected) {
        throw new BadRequestException(
          `${field} has an invalid UPC/EAN check digit`,
        );
      }
    }

    return barcode;
  }

  private parsePagination(query: Record<string, unknown>) {
    const page = this.optionalPositiveInteger(query.page, 'page') ?? 1;
    const limit = Math.min(
      this.optionalPositiveInteger(query.limit, 'limit') ?? 25,
      MAX_BULK_APPROVAL_PROPOSALS,
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

  private optionalEnum<T extends Record<string, string>>(
    value: unknown,
    enumLike: T,
    fallback: T[keyof T] | undefined,
    field: string,
  ) {
    if (value === undefined || value === null || value === '') return fallback;
    return this.requiredEnum(value, enumLike, field);
  }

  private requiredEnum<T extends Record<string, string>>(
    value: unknown,
    enumLike: T,
    field: string,
  ) {
    if (typeof value !== 'string' || !Object.values(enumLike).includes(value)) {
      throw new BadRequestException(`${field} must be valid`);
    }

    return value as T[keyof T];
  }

  private requiredBoolean(value: unknown, field: string) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new BadRequestException(`${field} must be a boolean`);
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException(`${field} is required`);
    }

    const text = String(value).trim();

    if (!text) {
      throw new BadRequestException(`${field} is required`);
    }

    return text;
  }

  private optionalString(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') return null;
    return this.requiredString(value, field);
  }

  private optionalStringArray(value: unknown, field: string) {
    if (value === undefined || value === null) return null;

    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be a list of IDs`);
    }

    const values = value.map((entry) => this.requiredString(entry, field));
    const uniqueValues = [...new Set(values)];

    if (uniqueValues.length !== values.length) {
      throw new BadRequestException(`${field} cannot contain duplicate IDs`);
    }

    return uniqueValues;
  }

  private toFriendlyBulkIssue(error: unknown) {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException ||
      error instanceof NotFoundException
    ) {
      const response = error.getResponse();

      if (typeof response === 'string') return response;
      if (
        typeof response === 'object' &&
        response !== null &&
        'message' in response
      ) {
        const message = (response as { message?: unknown }).message;
        if (typeof message === 'string') return message;
        if (Array.isArray(message) && typeof message[0] === 'string') {
          return message[0];
        }
      }
    }

    return 'This request could not be validated. Edit it and try again.';
  }

  private isPositiveIntegerText(value: string) {
    return /^\d+$/.test(value) && Number(value) > 0;
  }

  private serializeProposal(proposal: ProposalWithProduct) {
    return {
      ...proposal,
      proposedMultiPackRetail: proposal.proposedMultiPackRetail.toString(),
      unitCostSnapshot: proposal.unitCostSnapshot?.toString() ?? null,
      aggregateCostSnapshot: proposal.aggregateCostSnapshot?.toString() ?? null,
      marginSnapshot: proposal.marginSnapshot?.toString() ?? null,
      product: {
        ...proposal.product,
        unitRetail: proposal.product.unitRetail,
        unitCost: proposal.product.unitCost,
        unitCostAfterDiscountAndRebate:
          proposal.product.unitCostAfterDiscountAndRebate,
      },
    };
  }

  private readonly proposalInclude = {
    product: {
      include: {
        department: true,
        productCategory: true,
      },
    },
  } satisfies Prisma.MultiPackProposalInclude;
}

type ProposalDto = {
  productId: string;
  targetMultiPackId: string | null;
  action: MultiPackProposalAction;
  type: MultiPackType;
  unitsPerPack: number;
  caseBarcode: string | null;
  multiPackRetail: Prisma.Decimal;
};

type ProposalWithProduct = Prisma.MultiPackProposalGetPayload<{
  include: {
    product: {
      include: {
        department: true;
        productCategory: true;
      };
    };
  };
}>;
