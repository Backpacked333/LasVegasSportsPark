import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import type { Response } from 'express';
import { sql } from 'kysely';
import { Public } from '../auth/public.decorator';
import type { AppConfig } from '../config';
import { APP_CONFIG, DATABASE } from '../tokens';

@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async databaseStatus(): Promise<'ok' | 'unavailable'> {
    try {
      await sql`select 1`.execute(this.db);
      return 'ok';
    } catch {
      return 'unavailable';
    }
  }

  @Public()
  @Get('health')
  async health(): Promise<{ status: 'ok'; version: string; database: 'ok' | 'unavailable' }> {
    return {
      status: 'ok',
      version: this.config.APP_VERSION,
      database: await this.databaseStatus(),
    };
  }

  @Public()
  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const database = await this.databaseStatus();
    res
      .status(database === 'ok' ? 200 : 503)
      .json({ status: database === 'ok' ? 'ready' : 'not_ready', database });
  }
}
