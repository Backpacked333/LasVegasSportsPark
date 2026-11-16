/**
 * SCR-C-39 "Update required" (§4.13, SPK-AT-027; PA-11 SPK-UX-011 **Proposed**): plain words with
 * what to do next, and the request's reference quietly under them. The gate
 * that shows it, hides the app beneath and announces it is covered in src/api (data-layer).
 */
import { UpdateRequiredError } from '@sportspark/api-client';
import { screen } from '@testing-library/react-native';
import { renderSurface } from '../../../testing/ui-surfaces';
import { UPDATE_REQUIRED_ANNOUNCEMENT, UpdateRequiredScreen } from '../UpdateRequiredScreen';

function updateRequired(): UpdateRequiredError {
  return new UpdateRequiredError({
    status: 426,
    code: 'CLIENT_UPDATE_REQUIRED',
    message: 'Update the app.',
    nextAction: 'update_app',
    correlationId: 'corr-426',
    details: { minimumVersion: '0.3.0' },
  });
}

describe('SCR-C-39 UpdateRequiredScreen', () => {
  it('SPK-AT-027: says the version is no longer supported and how to update, with the reference', async () => {
    await renderSurface(<UpdateRequiredScreen error={updateRequired()} appVersion="0.1.0" />);
    expect(
      screen.getByRole('header', { name: 'This version of the app is no longer supported' }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Update required')).toBeOnTheScreen();
    expect(
      screen.getByText(
        "You have version 0.1.0; version 0.3.0 or later is required. Update the app from your device's app store to continue.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText('Reference: corr-426')).toBeOnTheScreen();
    expect(UPDATE_REQUIRED_ANNOUNCEMENT).toBe(
      "Update required. This version of the app is no longer supported. Update the app from your device's app store.",
    );
  });
});
