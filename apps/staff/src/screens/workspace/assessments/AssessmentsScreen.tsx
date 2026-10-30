/**
 * SCR-W-07 Assessments (coach) (SPK-YOUTH-005, SPK-YOUTH-006, SPK-UX-007, POL-036; Package G
 * "Youth progression" behind the youth_progression switch, DEC-016; templates and family
 * visibility DEC-054, recommendation inputs DEC-055, both pending).
 *
 * - Who is assessed: a coach picks one of their own sessions (accepted or completed coach
 *   assignments from `GET /v1/me/assignments`) and a participant from its attendance (names from
 *   the attendance read, ENT-01). A program manager may also pick an offering of the facility
 *   (`GET /v1/offerings`) and find the participant with the staff person search.
 * - The participant's assessments (`GET /v1/participants/{personId}/assessments`), recording,
 *   editing, submitting, withdrawing, review by another program manager, corrections
 *   (ParticipantAssessments, AssessmentForm), progression recommendations (Recommendations) and,
 *   for program managers, templates (Templates).
 * - The switch starts off: while it is off the page says "turned off" and offers no authoring,
 *   review or sharing; existing assessments stay readable and drafts can still be withdrawn (the
 *   API never gates reads, withdrawal or retirement). The API answers what each principal may do;
 *   the page offers commands from `GET /v1/me/permissions` and renders refusals as not available.
 * - Children are named only: no date of birth, contact or medical detail; ids never enter a
 *   route (§4.14).
 */
import { useMemo, useState } from 'react';
import { usePermissions } from '../../../api/permissions';
import { useApiPages } from '../../../api/useApiPages';
import { useApiQuery } from '../../../api/useApiQuery';
import { activityFromAssignment, attendanceQuery } from '../../../features/operations/activity';
import { AreaTabs, WORKSPACE_TABS } from '../../../features/operations/AreaTabs';
import { useOperatingFacility } from '../../../features/operations/context';
import { SelectField } from '../../../features/operations/fields';
import { formatRange } from '../../../features/operations/format';
import { PersonSearch, personLabel } from '../../../features/operations/PersonSearch';
import { Button } from '../../../ui/Button';
import { CapabilityGate } from '../../../ui/CapabilityGate';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import type { WorkspaceAssignment } from '../MyAssignment';
import { activityZone } from '../WorkspaceScreen';
import { ParticipantAssessments } from './ParticipantAssessments';
import { Recommendations } from './Recommendations';
import {
  ACTIONS,
  YOUTH_CAPABILITY,
  type AssessmentSubject,
  type AssessmentTemplate,
} from './subject';
import { Templates } from './Templates';

export function AssessmentsScreen() {
  const facility = useOperatingFacility();
  const [subject, setSubject] = useState<AssessmentSubject | null>(null);
  const [templates, setTemplates] = useState<AssessmentTemplate[]>([]);
  const keepTemplate = (t: AssessmentTemplate) =>
    setTemplates((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
  return (
    <section aria-labelledby="assessments-title">
      <h2 id="assessments-title">Assessments</h2>
      <AreaTabs label="Workspace screens" tabs={WORKSPACE_TABS} />
      <CapabilityGate
        capability={YOUTH_CAPABILITY}
        subject="Youth assessments and progression"
        whenOff="notice"
        stillAvailable="Existing assessments stay readable, and drafts can still be withdrawn."
      >
        {subject ? (
          <>
            <p>
              <Button variant="secondary" onClick={() => setSubject(null)}>
                Choose another participant
              </Button>
            </p>
            <ParticipantAssessments
              subject={subject}
              templates={templates}
              me={facility.personId}
            />
            <Recommendations key={subject.personId + subject.offeringId} subject={subject} />
          </>
        ) : (
          <ChooseSubject facilityId={facility.facilityId} onChoose={setSubject} />
        )}
        <Templates
          programId={subject?.programId ?? null}
          facilityId={subject?.facilityId ?? facility.facilityId}
          templates={templates}
          onTemplate={keepTemplate}
        />
      </CapabilityGate>
    </section>
  );
}

function ChooseSubject({
  facilityId,
  onChoose,
}: {
  facilityId: string | null;
  onChoose: (s: AssessmentSubject) => void;
}) {
  const permissions = usePermissions();
  const managesHere = facilityId
    ? permissions.isPermitted(ACTIONS.review, facilityId) === true
    : false;
  return (
    <>
      <MySessions onChoose={onChoose} />
      {managesHere && facilityId ? (
        <FacilityOfferings facilityId={facilityId} onChoose={onChoose} />
      ) : null}
    </>
  );
}

/** A coach's own sessions: accepted or completed coach assignments on a session (WRK-03). */
function MySessions({ onChoose }: { onChoose: (s: AssessmentSubject) => void }) {
  const assignments = useApiQuery({ path: '/me/assignments' });
  const sessions = useMemo(
    () =>
      (assignments.data?.items ?? []).filter(
        (i) =>
          i.assignment.kind === 'coach' &&
          i.assignment.targetType === 'session' &&
          i.assignment.offeringId !== null &&
          (i.assignment.status === 'accepted' || i.assignment.status === 'completed'),
      ),
    [assignments.data],
  );
  const [chosen, setChosen] = useState('');
  const item = sessions.find((s) => s.assignment.id === chosen);
  return (
    <section className="ops-section" aria-labelledby="my-sessions-title">
      <h3 id="my-sessions-title">Your sessions</h3>
      <QueryBoundary
        query={assignments}
        label="your sessions"
        isEmpty={() => sessions.length === 0}
        empty={{
          title: 'No coached sessions',
          description:
            'Sessions you have accepted as a coach appear here. Assessments are recorded for their participants.',
        }}
      >
        {() => (
          <SelectField
            label="Session"
            value={chosen}
            onChange={setChosen}
            placeholder="Choose a session"
            options={sessions.map((s) => ({
              value: s.assignment.id,
              label: `${s.activity.title}, ${formatRange(s.activity.scheduledStart, s.activity.scheduledEnd, activityZone(s))}`,
            }))}
          />
        )}
      </QueryBoundary>
      {item ? (
        <SessionParticipants key={item.assignment.id} item={item} onChoose={onChoose} />
      ) : null}
    </section>
  );
}

function SessionParticipants({
  item,
  onChoose,
}: {
  item: WorkspaceAssignment;
  onChoose: (s: AssessmentSubject) => void;
}) {
  const activity = activityFromAssignment(item.assignment);
  const attendance = useApiQuery({
    path: '/attendance',
    request: {
      query: activity ? attendanceQuery(activity) : { activityType: 'event', activityId: '' },
    },
    enabled: activity !== null,
  });
  if (!activity || !item.assignment.offeringId) {
    return (
      <StateView
        variant="unavailable"
        description="This assignment is not linked to a program session."
      />
    );
  }
  const offeringId = item.assignment.offeringId;
  return (
    <QueryBoundary
      query={attendance}
      label="the session's participants"
      isEmpty={(data) => data.people.length === 0}
      empty={{
        title: 'No participants recorded',
        description:
          'Participants appear once their attendance is recorded for this session. Record attendance first.',
      }}
    >
      {(data) => (
        <ul className="list" aria-label="Participants">
          {data.people.map((p) => {
            const name = p.displayName ?? `Participant (ref ${p.personId.slice(0, 8)})`;
            return (
              <li key={p.personId}>
                <span className="row-title">{name}</span>
                <Button
                  variant="secondary"
                  aria-label={`Assess ${name}`}
                  onClick={() =>
                    onChoose({
                      offeringId,
                      offeringName: item.activity.title,
                      programId: null,
                      facilityId: item.activity.facilityId,
                      personId: p.personId,
                      name,
                    })
                  }
                >
                  Assess
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </QueryBoundary>
  );
}

const offeringKey = (o: { id: string }) => o.id;

/** Program managers: an offering of the facility, then the participant by name. */
function FacilityOfferings({
  facilityId,
  onChoose,
}: {
  facilityId: string;
  onChoose: (s: AssessmentSubject) => void;
}) {
  const offerings = useApiPages({
    path: '/offerings',
    request: { query: { facilityId, limit: 50, view: 'staff' } },
    keyOf: offeringKey,
  });
  const [chosen, setChosen] = useState('');
  const offering = (offerings.data ?? []).find((o) => o.id === chosen);
  return (
    <section className="ops-section" aria-labelledby="facility-offerings-title">
      <h3 id="facility-offerings-title">Offerings at this facility</h3>
      <QueryBoundary
        query={offerings}
        label="offerings"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No offerings', description: 'No offering is listed at this facility.' }}
      >
        {(items) => (
          <SelectField
            label="Offering"
            value={chosen}
            onChange={setChosen}
            placeholder="Choose an offering"
            options={items.map((o) => ({
              value: o.id,
              label: `${o.name} (${o.startsOn} to ${o.endsOn})`,
            }))}
          />
        )}
      </QueryBoundary>
      <LoadMore pages={offerings} label="offerings" />
      {offering ? (
        <PersonSearch
          label="Find the participant"
          chooseLabel="Assess"
          kind="child"
          onChoose={(p) =>
            onChoose({
              offeringId: offering.id,
              offeringName: offering.name,
              programId: offering.programId,
              facilityId: offering.facilityId,
              personId: p.id,
              name: personLabel(p),
            })
          }
        />
      ) : null}
    </section>
  );
}
