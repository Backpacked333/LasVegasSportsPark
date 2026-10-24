import { Logger, Module, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConflictDetector } from './conflicts/conflict-detector';
import { ClosuresController } from './controllers/closures.controller';
import { EventSeriesController } from './controllers/event-series.controller';
import { EventsController } from './controllers/events.controller';
import { ResourcesController } from './controllers/resources.controller';
import { ScheduleDraftsController } from './controllers/schedule-drafts.controller';
import {
  AVAILABILITY_PORT,
  CLOSURE_PORT,
  EVENT_SCHEDULING_PORT,
  FIXTURE_OBLIGATION_IMPL,
  FIXTURE_OBLIGATION_PORT,
  noFixtureObligations,
  RESERVATION_QUERY_PORT,
  type FixtureObligationPort,
} from './ports';
import { DEFAULT_SCHEDULING_POLICY, SCHEDULING_POLICY } from './scheduling.policy';
import { ClosuresService } from './services/closures.service';
import { EventSeriesService } from './services/event-series.service';
import { EventWriter } from './services/event-writer';
import { EventsService } from './services/events.service';
import { ResourcesService } from './services/resources.service';
import { ScheduleDraftsService } from './services/schedule-drafts.service';

/**
 * Resolves the competition module's fixture-obligation implementation lazily (no import cycle);
 * without one, publication verifies no obligations (SPK-SCHED-006 step 4, SPK-FIX-002).
 */
function lazyFixtureObligations(moduleRef: ModuleRef): FixtureObligationPort {
  const logger = new Logger('Scheduling');
  let warned = false;
  return {
    verify: async (check) => {
      try {
        const impl = moduleRef.get<FixtureObligationPort>(FIXTURE_OBLIGATION_IMPL, {
          strict: false,
        });
        return await impl.verify(check);
      } catch (error) {
        if (error instanceof Error && /Nest could not find/.test(error.message)) {
          if (!warned) {
            warned = true;
            logger.warn(
              'no FIXTURE_OBLIGATION_IMPL registered: publication verifies no fixture obligations',
            );
          }
          return noFixtureObligations.verify(check);
        }
        throw error;
      }
    },
  };
}

const providers: Provider[] = [
  { provide: SCHEDULING_POLICY, useValue: DEFAULT_SCHEDULING_POLICY },
  {
    provide: FIXTURE_OBLIGATION_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef) => lazyFixtureObligations(moduleRef),
  },
  ConflictDetector,
  EventWriter,
  EventsService,
  ResourcesService,
  ClosuresService,
  EventSeriesService,
  ScheduleDraftsService,
  { provide: EVENT_SCHEDULING_PORT, useExisting: EventsService },
  { provide: AVAILABILITY_PORT, useExisting: EventsService },
  { provide: RESERVATION_QUERY_PORT, useExisting: EventsService },
  { provide: CLOSURE_PORT, useExisting: ClosuresService },
];

/**
 * SchedulingModule (specification §3.7, §3.8 SPK-FIX-005, §4.4 Scheduling, §4.7 invariant 4).
 * Owns resources, configurations, conflict units, operating hours, closures, series, events,
 * reservations, commitments, schedule drafts and publications. Other modules use the exported
 * services and ports; they never write these tables (§4.2). The module consumes no domain events.
 */
@Module({
  providers,
  controllers: [
    ResourcesController,
    ClosuresController,
    EventsController,
    EventSeriesController,
    ScheduleDraftsController,
  ],
  exports: [
    EventsService,
    ResourcesService,
    ClosuresService,
    EventSeriesService,
    ScheduleDraftsService,
    EVENT_SCHEDULING_PORT,
    AVAILABILITY_PORT,
    RESERVATION_QUERY_PORT,
    CLOSURE_PORT,
    FIXTURE_OBLIGATION_PORT,
    SCHEDULING_POLICY,
  ],
})
export class SchedulingModule {}
