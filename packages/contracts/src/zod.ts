import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Under zod 4 the `.openapi()` extension only applies to schemas created after extension.
// Every contract file (and every module API file in apps/api) must import `z` from here.
extendZodWithOpenApi(z);

export { z };
