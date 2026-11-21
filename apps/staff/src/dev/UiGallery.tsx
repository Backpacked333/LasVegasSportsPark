/**
 * Development and demo only (`/dev/ui`): every shared primitive of the redesign handoff (Phase 0)
 * in each of its states, on the dashboard's own tokens, so a screen builder can see and reuse them
 * without hunting through screens. Not in a production build (`dev/index.ts`).
 */
import { useState } from 'react';
import { Avatar } from '../ui/Avatar';
import { BottomSheet } from '../ui/BottomSheet';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { Flash } from '../ui/Flash';
import { OfflineBanner } from '../ui/OfflineBanner';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Skeleton, SkeletonGroup, SkeletonLines } from '../ui/Skeleton';
import { StatusBadge } from '../ui/StatusBadge';
import { useToast } from '../ui/Toast';
import { useRailBadge } from '../layout/RailBadges';

export function UiGallery() {
  const toast = useToast();
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [segment, setSegment] = useState<'day' | 'week'>('day');
  const [count, setCount] = useState(142);
  const [badge, setBadge] = useState(0);
  useRailBadge(
    'arrival',
    badge > 0
      ? { count: badge, tone: 'warning', label: `${badge} check-ins waiting to sync` }
      : null,
  );

  return (
    <section className="ui-gallery" aria-labelledby="gallery-title">
      <div className="page-head">
        <div className="page-head-text">
          <span className="eyebrow">Development · redesign handoff Phase 0</span>
          <h2 id="gallery-title">Staff UI primitives</h2>
        </div>
      </div>

      <div className="card">
        <h3>StatusBadge: six tones, glyph + word</h3>
        <div className="actions-row">
          <StatusBadge tone="success" label="Cleared" />
          <StatusBadge tone="warning" label="Needs action" />
          <StatusBadge tone="error" label="Blocked" />
          <StatusBadge tone="info" label="Money" />
          <StatusBadge tone="neutral" label="Field 2 · 9:00" />
          <StatusBadge tone="pending" label="Proposed" />
          <StatusBadge tone="error" label="Blocks start" size="sm" />
        </div>
      </div>

      <div className="card">
        <h3>Avatar: photo, initials on the person colour, ring</h3>
        <div className="actions-row">
          {['Maya Ortiz', 'Leo Ortiz', 'Taylor Nguyen', 'Kofi Osei', 'Riya Patel'].map((n) => (
            <Avatar key={n} name={n} size={44} />
          ))}
          <Avatar name="Maya Ortiz" size={44} ring />
          <Avatar name="Broken Photo" size={44} photoUrl="/missing.jpg" />
        </div>
      </div>

      <div className="card">
        <h3>Toast: one at a time, Undo for 5 s, countdown</h3>
        <div className="actions-row">
          <Button variant="secondary" onClick={() => toast.show({ message: 'Saved' })}>
            Plain (2.4 s)
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.show({
                tone: 'success',
                message: 'Assigned T. Nguyen',
                onUndo: () => toast.show({ message: 'Undone' }),
              })
            }
          >
            With Undo (5 s)
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.show({
                message: '4 games cancelled',
                onUndo: () => undefined,
                durationMs: 120_000,
                countdown: true,
              })
            }
          >
            Countdown (2:00)
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.show({
                tone: 'error',
                message: 'Not saved: the referee has another game. Code SPK-STAFF-003',
                action: { label: 'Try again', onClick: () => undefined },
              })
            }
          >
            Error with Try again
          </Button>
        </div>
      </div>

      <div className="card">
        <h3>Drawer and BottomSheet</h3>
        <div className="actions-row">
          <Button variant="secondary" onClick={() => setDrawer(true)}>
            Open drawer
          </Button>
          <Button variant="secondary" onClick={() => setSheet(true)}>
            Open bottom sheet
          </Button>
        </div>
        <Drawer
          open={drawer}
          onClose={() => setDrawer(false)}
          labelledBy="gallery-drawer"
          tone="night"
          header={<h3 id="gallery-drawer">Drawer</h3>}
          footer={<Button onClick={() => setDrawer(false)}>Done</Button>}
        >
          <p>Slides in from the right; Escape, ✕ or the scrim closes it; focus returns.</p>
        </Drawer>
        <BottomSheet
          open={sheet}
          onClose={() => setSheet(false)}
          title="Bottom sheet"
          titleId="gallery-sheet"
        >
          <p>Drag the handle down, tap the scrim or ✕ to close.</p>
        </BottomSheet>
      </div>

      <div className="card">
        <h3>SegmentedControl</h3>
        <SegmentedControl
          label="View"
          value={segment}
          onChange={setSegment}
          segments={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
          ]}
        />
      </div>

      <div className="card">
        <h3>Skeleton (loading in the final layout)</h3>
        <SkeletonGroup label="an example card">
          <Skeleton width="40%" height={18} />
          <SkeletonLines lines={3} />
        </SkeletonGroup>
      </div>

      <div className="card">
        <h3>OfflineBanner</h3>
        <OfflineBanner lastGood="8:41 AM" queued={{ count: 2, noun: 'check-in' }}>
          Payments need a connection.
        </OfflineBanner>
      </div>

      <div className="card">
        <h3>Flash and rail badge</h3>
        <p>
          Checked in: <Flash value={count}>{count}</Flash>
        </p>
        <div className="actions-row">
          <Button variant="secondary" onClick={() => setCount((c) => c + 1)}>
            Change the number
          </Button>
          <Button variant="secondary" onClick={() => setBadge((b) => (b + 1) % 4)}>
            Arrival rail badge: {badge}
          </Button>
        </div>
      </div>
    </section>
  );
}
