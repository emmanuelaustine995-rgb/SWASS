import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DbService } from './db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get('maintenance')
  async maintenanceStatus() {
    await this.db.ensureOperationsSchema();
    const result = await this.db.pool.query('SELECT maintenance_enabled AS enabled, maintenance_title AS title, maintenance_message AS message, maintenance_starts_at AS starts_at FROM aurora_platform_operations WHERE id=1');
    return result.rows[0] || { enabled: false };
  }

  @Get()
  async check() {
    try {
      await this.db.pool.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'disconnected' });
    }
  }
}
