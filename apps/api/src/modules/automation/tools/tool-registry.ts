import { Injectable } from '@nestjs/common';
import type { ContextReferenceType } from '@sportspark/contracts';
import type { AssistantToolSpec } from '../ports/assistant-provider.port';
import { CommandTools } from './command-tools';
import { QueryTools } from './query-tools';
import type { AnyCommandTool, AnyQueryTool, AnyTool } from './tool.types';

/** The catalogue of module tools the assistant may ask for, by name. */
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  constructor(queries: QueryTools, commands: CommandTools) {
    for (const tool of [...queries.all(), ...commands.all()]) {
      if (this.tools.has(tool.name)) throw new Error(`duplicate assistant tool ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  command(actionId: string): AnyCommandTool | undefined {
    const tool = this.tools.get(actionId);
    return tool?.kind === 'command' ? tool : undefined;
  }

  forContext(type: ContextReferenceType): AnyQueryTool {
    for (const tool of this.tools.values()) {
      if (tool.kind === 'query' && tool.contextType === type) return tool;
    }
    throw new Error(`no assistant tool resolves context references of type ${type}`);
  }

  /** What the provider is told it may ask for (descriptions only; no authority is implied). */
  specs(): AssistantToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      kind: t.kind,
      description: t.description,
      arguments: t.argumentsDoc,
    }));
  }
}
