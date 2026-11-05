import { Module, type DynamicModule } from '@nestjs/common';
import { KernelModule, type KernelModuleOptions } from './kernel/kernel.module';
import { DOMAIN_MODULES } from './modules';

@Module({})
export class AppModule {
  static forRoot(options: KernelModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [KernelModule.forRoot(options), ...DOMAIN_MODULES],
    };
  }
}
