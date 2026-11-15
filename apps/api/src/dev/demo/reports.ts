import type { ReportKey } from '@sportspark/contracts';
import { ReportRunsService } from '../../modules/reporting/services/report-runs.service';
import { calendarOf, optional, service, type DemoContext } from './context';
import type { DemoStaff } from './people';

/**
 * Stored report runs (SPK-REPORT-001 to 004), so the Reports screen opens on figures: this week's
 * sales by product line (the open-amount register lines are listed apart in it, SPK-PAY-016),
 * what is still owed, and the registration funnel.
 */
const REPORTS: readonly ReportKey[] = [
  'sales_by_product_line',
  'outstanding_obligations',
  'registration_funnel',
];

export async function seedReports(ctx: DemoContext, staff: DemoStaff): Promise<void> {
  const runs = service(ctx, ReportRunsService);
  const manager = staff.manager.principal;
  const calendar = calendarOf(ctx);
  for (const report of REPORTS) {
    await optional(ctx, `the stored run of the ${report} report`, async () => {
      const listed = await runs.list(manager, { report, limit: 5 });
      if (listed.items.length > 0) return;
      await runs.create(
        manager,
        {
          report,
          parameters: { facilityId: ctx.facilityId, from: calendar.day(-7), to: calendar.day(0) },
          policyReferences: [],
        },
        null,
      );
    });
  }
}
