/**
 * SCR-S-27 entry point: find the enrollment to cancel or transfer (SPK-REG-010, SPK-REG-003).
 * Lists `GET /v1/enrollments` (keyset pages with "Load more", ENR-02) by offering (chosen by
 * program, or passed as `?offering=<id>` from the offering setup screen) or by participant
 * reference, with status; each row opens the preview-first cancellation and transfer screen. The
 * same filter lists the session packages staff may correct (`GET /v1/package-entitlements`,
 * ENR-11; capability `session_packages` shown as a notice, DEC-016). Only opaque ids appear in the
 * URL (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { SelectField, TextField } from '../../features/registration-finance/fields';
import { formatInstant } from '../../features/registration-finance/format';
import { ENROLLMENT_STATUS, REGISTRATION_INTENT } from '../../features/registration-finance/labels';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { OfferingPicker } from '../../features/registration-finance/OfferingPicker';
import { PackageEntitlementList } from '../../features/registration-finance/PackageEntitlements';
import { REGISTRATION_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { LoadMore } from '../../ui/LoadMore';
import { StatusBadge } from '../../ui/StatusBadge';

type EnrollmentStatus = Schema<'EnrollmentStatus'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function EnrollmentsScreen() {
  const [params, setParams] = useSearchParams();
  const offeringId = params.get('offering') ?? '';
  const [participant, setParticipant] = useState('');
  const [status, setStatus] = useState<EnrollmentStatus | ''>('confirmed');
  const participantId = UUID.test(participant.trim()) ? participant.trim() : '';
  const enrollments = useApiPages({
    path: '/enrollments',
    request: {
      query: {
        limit: 50,
        ...(offeringId ? { offeringId } : {}),
        ...(participantId ? { participantPersonId: participantId } : {}),
        ...(status ? { status } : {}),
      },
    },
    enabled: offeringId !== '' || participantId !== '',
  });
  return (
    <section aria-labelledby="enrollments-title">
      <h2 id="enrollments-title">Cancellations and transfers</h2>
      <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
      <p>Find the enrollment, then preview the cancellation or transfer before committing it.</p>
      <OfferingPicker
        label="Enrollments in"
        value={offeringId}
        onChange={(id) => setParams(id ? { offering: id } : {})}
      />
      <div className="rf-grid">
        <TextField
          label="Or participant reference"
          value={participant}
          onChange={setParticipant}
          hint="The participant's person reference from People and families."
        />
        <SelectField
          label="Enrollment status"
          value={status}
          placeholder="All statuses"
          onChange={(v) => setStatus(v as EnrollmentStatus | '')}
          options={Object.entries(ENROLLMENT_STATUS).map(([value, badge]) => ({
            value,
            label: badge.label,
          }))}
        />
      </div>
      {offeringId ? (
        <p>
          Offering: <OfferingName id={offeringId} />
        </p>
      ) : null}
      {offeringId === '' && participantId === '' ? (
        <p>Choose an offering or enter a participant reference.</p>
      ) : (
        <>
          <QueryBoundary
            query={enrollments}
            label="enrollments"
            isEmpty={(items) => items.length === 0}
            empty={{ title: 'No enrollments', description: 'No enrollment matches.' }}
          >
            {(items) => (
              <ul className="list" aria-label="Enrollments">
                {items.map((enrollment) => (
                  <li key={enrollment.id}>
                    <div className="row-text">
                      <Link
                        className="row-title"
                        to={`/registrations/enrollments/${enrollment.id}`}
                      >
                        <PersonName id={enrollment.participantPersonId} fallback="Participant" />
                      </Link>
                      <span className="caption">
                        <OfferingName id={enrollment.offeringId} /> ·{' '}
                        {REGISTRATION_INTENT[enrollment.intent]} · registered{' '}
                        {formatInstant(enrollment.createdAt, enrollment.offering?.timezone)} by{' '}
                        {enrollment.registeredBy.actorLabel}
                      </span>
                    </div>
                    <StatusBadge {...ENROLLMENT_STATUS[enrollment.status]} />
                  </li>
                ))}
              </ul>
            )}
          </QueryBoundary>
          <LoadMore pages={enrollments} label="enrollments" />
          <PackageEntitlementList
            filter={{
              ...(offeringId ? { offeringId } : {}),
              ...(participantId ? { participantPersonId: participantId } : {}),
            }}
          />
        </>
      )}
    </section>
  );
}
