import { z } from '@sportspark/contracts';

/**
 * The §5.10 workload manifest: the synthetic envelope, arrival rates, workflow mix, duration,
 * contention, infrastructure and dependency failures, plus the §5.9 targets a report compares
 * against. Values are test inputs, not facility facts (§5.10).
 */
export const WorkloadManifestSchema = z.object({
  envelope: z.object({
    people: z.number().int().positive(),
    historicalEnrollments: z.number().int().nonnegative(),
    attendanceAndOperationalEvents: z.number().int().nonnegative(),
    activeCustomerSessions: z.number().int().positive(),
    activeStaffOrScannerSessions: z.number().int().positive(),
    contendersForFinalPlace: z.number().int().positive(),
  }),
  arrivalRates: z.object({
    staffLookupPerSessionPerMinute: z.number().positive(),
    customerReadsPerSessionPerMinute: z.number().positive(),
    readinessProbesPerMinute: z.number().positive(),
  }),
  workflowMix: z.record(z.string(), z.number().min(0).max(1)),
  durationSeconds: z.number().int().positive(),
  contention: z.string().min(1),
  infrastructure: z.string().min(1),
  dependencyFailures: z.string().min(1),
  targets: z.object({
    staffLookupP95Ms: z.number().positive(),
    onlineCheckInP95Ms: z.number().positive(),
  }),
});
export type WorkloadManifest = z.infer<typeof WorkloadManifestSchema>;

/** The manifest scaled for a rehearsal (`scale` 0.01 = one percent of the envelope). */
export function scaleManifest(manifest: WorkloadManifest, scale: number): WorkloadManifest {
  const at = (n: number) => Math.max(1, Math.round(n * scale));
  return {
    ...manifest,
    envelope: {
      people: at(manifest.envelope.people),
      historicalEnrollments: Math.round(manifest.envelope.historicalEnrollments * scale),
      attendanceAndOperationalEvents: Math.round(
        manifest.envelope.attendanceAndOperationalEvents * scale,
      ),
      activeCustomerSessions: at(manifest.envelope.activeCustomerSessions),
      activeStaffOrScannerSessions: at(manifest.envelope.activeStaffOrScannerSessions),
      contendersForFinalPlace: manifest.envelope.contendersForFinalPlace,
    },
  };
}
