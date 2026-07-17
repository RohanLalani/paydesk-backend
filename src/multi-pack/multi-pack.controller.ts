import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { MultiPackService } from './multi-pack.service';

@Controller('stores/:storeId')
@UseGuards(JwtAuthGuard)
export class MultiPackController {
  constructor(private readonly multiPackService: MultiPackService) {}

  @Get('products/:productId/multi-packs')
  listActive(
    @Param('storeId') storeId: string,
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.listProductMultiPacks(
      storeId,
      productId,
      query,
      request.user,
    );
  }

  @Get('multi-packs/case-barcode/:barcode')
  findCaseBarcode(
    @Param('storeId') storeId: string,
    @Param('barcode') barcode: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.findByCaseBarcode(
      storeId,
      barcode,
      request.user,
    );
  }

  @Get('multi-pack-proposals')
  listProposals(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.listProposals(storeId, query, request.user);
  }

  @Post('multi-pack-proposals')
  submitProposal(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.submitProposal(storeId, body, request.user);
  }

  @Post('multi-pack-proposals/approve-all')
  approveAllPendingProposals(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.approveAllPendingProposals(
      storeId,
      body,
      request.user,
    );
  }

  @Get('multi-pack-proposals/:proposalId')
  getProposal(
    @Param('storeId') storeId: string,
    @Param('proposalId') proposalId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.getProposal(storeId, proposalId, request.user);
  }

  @Patch('multi-pack-proposals/:proposalId')
  updateProposal(
    @Param('storeId') storeId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.updateProposal(
      storeId,
      proposalId,
      body,
      request.user,
    );
  }

  @Post('multi-pack-proposals/:proposalId/approve')
  approveProposal(
    @Param('storeId') storeId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.approveProposal(
      storeId,
      proposalId,
      body,
      request.user,
    );
  }

  @Post('multi-pack-proposals/:proposalId/reject')
  rejectProposal(
    @Param('storeId') storeId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.rejectProposal(
      storeId,
      proposalId,
      body,
      request.user,
    );
  }

  @Get('multi-pack-logs')
  listLogs(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.multiPackService.listLogs(storeId, query, request.user);
  }
}
