/**
 * SCR-S-20 Person search (SPK-IAM-001, SPK-IAM-002, SPK-SUPPORT-001, SPK-SUPPORT-002, §4.14, §4.3).
 * Staff look a person up without customer credentials. The API has no person search by name or
 * contact yet, so the search is shown as not available and staff open a record by its reference
 * (from a case, an exception, a receipt or the customer's account). The reference is validated
 * before any request (validation failure state) and never carries personal data in the URL: the
 * route holds only the opaque id. What the record shows is scoped by the API (organization and
 * facility, §4.3); another organization's person is answered NOT_FOUND like any unknown id.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PeopleNav } from '../../features/people/PeopleNav';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';

export function PeopleScreen() {
  const navigate = useNavigate();
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    const problem = referenceError(reference, true);
    setError(problem);
    if (!problem) void navigate(`/people/${reference.trim().toLowerCase()}`);
  };
  return (
    <section aria-labelledby="people-title">
      <h2 id="people-title">People and families</h2>
      <PeopleNav />
      <section className="panel" aria-labelledby="lookup-title">
        <h3 id="lookup-title">Find a person</h3>
        <StateView
          variant="unavailable"
          title="Search by name or contact is not available yet"
          description="The API offers no person search yet. Open a person by the reference shown on their case, exception, receipt or account."
        />
        <form
          noValidate
          className="form"
          aria-label="Open a person by reference"
          onSubmit={(event) => {
            event.preventDefault();
            open();
          }}
        >
          <PersonReferenceField
            label="Person reference"
            required
            value={reference}
            onChange={setReference}
            error={error}
          />
          <Button type="submit">Open record</Button>
        </form>
      </section>
    </section>
  );
}
