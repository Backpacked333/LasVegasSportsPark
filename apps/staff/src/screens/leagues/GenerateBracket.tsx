/**
 * SCR-S-13 creating a division's playoff bracket from its structure (`POST /v1/divisions/{id}/
 * bracket-nodes/generate`, SPK-COMP-001 bracket progression). The league manager gives the number
 * of qualifiers; the API pairs seeds 1 v N and sends the top seeds' byes straight to the second
 * round. Nodes start unpublished and unseeded; each is then seeded from the final standings. A
 * division that already has a bracket is refused (never replaced). One idempotency key per intent.
 */
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, SuccessNote, useRefetch } from '../../features/competition/feedback';
import { NumberField, TextField, parseWholeNumber } from '../../features/competition/fields';

export function GenerateBracket({
  divisionId,
  divisionName,
}: {
  divisionId: string;
  divisionName: string;
}) {
  const [teams, setTeams] = useState('');
  const [prefix, setPrefix] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const generate = useApiCommand('post', '/divisions/{id}/bracket-nodes/generate', {
    invalidate: keys('/seasons/{id}/bracket-nodes'),
  });
  const reload = useRefetch(['/seasons/{id}/bracket-nodes']);
  const submit = () => {
    const count = parseWholeNumber(teams);
    if (count === null || count < 2 || count > 64) {
      setError('Enter the number of qualifying teams, from 2 to 64.');
      return;
    }
    setError(undefined);
    void generate
      .submit({
        path: { id: divisionId },
        body: {
          structure: { kind: 'single_elimination', teams: count },
          ...(prefix.trim() ? { namePrefix: prefix.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };
  return (
    <form
      className="form"
      noValidate
      aria-label={`Create the ${divisionName} bracket`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="caption">
        Single elimination. Seeds play 1 v {teams && parseWholeNumber(teams) ? teams : 'N'}; when
        the number is not a power of two the top seeds go straight to the second round.
      </p>
      <div className="field-grid">
        <NumberField
          label="Qualifying teams"
          required
          value={teams}
          onChange={setTeams}
          error={error}
        />
        <TextField
          label="Name in front of each game (optional)"
          value={prefix}
          onChange={setPrefix}
          hint="For example: Gold playoffs"
        />
      </div>
      <div className="actions">
        <CommandButton type="submit" busy={generate.isProcessing}>
          Create bracket
        </CommandButton>
      </div>
      {generate.status === 'success' && generate.data ? (
        <SuccessNote>{`Bracket created: ${generate.data.length} games, unpublished.`}</SuccessNote>
      ) : null}
      <CommandError
        error={generate.error}
        onRetry={submit}
        onReload={() => {
          generate.reset();
          reload();
        }}
      />
    </form>
  );
}
