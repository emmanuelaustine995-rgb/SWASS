import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { CreateReceiptDto, ReceiptsService } from './receipts.service';

@Controller('api/v1/receipts')
@UseGuards(AuthGuard, RolesGuard)
export class ReceiptsController {
  constructor(private receipts: ReceiptsService) {}

  @Get()
  @Roles('cashier', 'manager', 'owner')
  list(@Req() req: any, @Query('q') q?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('limit') limit?: string) {
    return this.receipts.list(req.user, { q, from, to, limit });
  }

  @Post()
  @Roles('cashier', 'manager', 'owner')
  create(@Req() req: any, @Body() dto: CreateReceiptDto) {
    return this.receipts.create(req.user, dto);
  }

  /** Uploads receipts made offline; each one is idempotent on clientUuid. */
  @Post('sync')
  @Roles('cashier', 'manager', 'owner')
  async sync(@Req() req: any, @Body() body: { receipts: CreateReceiptDto[] }) {
    if (!Array.isArray(body?.receipts) || body.receipts.length === 0 || body.receipts.length > 100) {
      throw new BadRequestException('receipts must contain between 1 and 100 sales');
    }
    const results: unknown[] = [];
    for (const dto of body.receipts) {
      try {
        results.push({ clientUuid: dto.clientUuid, ok: true, receipt: await this.receipts.create(req.user, dto) });
      } catch (e: any) {
        results.push({ clientUuid: dto?.clientUuid, ok: false, error: 'Sale could not be synced' });
      }
    }
    return { results };
  }
}
