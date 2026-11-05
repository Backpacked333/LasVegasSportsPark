import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'sportspark:public';

/** Marks a route as reachable without a bearer token; the principal is then anonymous. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
