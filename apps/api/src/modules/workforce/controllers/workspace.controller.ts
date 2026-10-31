import { Controller, Get } from '@nestjs/common';
import { MyAssignmentsQuery, type MyAssignments, type Principal } from '@sportspark/contracts';
import { CurrentPrincipal, ZodQuery } from '../../../kernel';
import { WorkspaceService } from '../services/workspace.service';

/** Coach and referee workspace (SPK-UX-007). */
@Controller('me')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('assignments')
  myAssignments(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(MyAssignmentsQuery) query: MyAssignmentsQuery,
  ): Promise<MyAssignments> {
    return this.workspace.myAssignments(principal, query);
  }
}
