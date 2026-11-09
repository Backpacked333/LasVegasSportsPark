import { Injectable } from '@nestjs/common';

/**
 * Whether this process still takes new traffic (R3-OPERATIONS-10). The API's stop handler sets
 * `draining` first, so `GET /v1/ready` answers 503 and the load balancer routes new requests
 * elsewhere while the requests in flight finish.
 */
@Injectable()
export class ReadinessState {
  draining = false;
}
